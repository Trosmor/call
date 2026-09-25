// "Real" energy expenditure from the user's own data, MacroFactor-style:
//   expenditure ≈ average logged intake − (weight change per day × 7700 kcal/kg)
// No wearable estimates go into the number itself — Garmin's active calories are only
// compared against it afterwards, to find out how much of them is real.

export const KCAL_PER_KG = 7700;
const WINDOW_DAYS = 28;
const TREND_ALPHA = 0.1; // smoothing per day for the displayed trend line (Hacker's Diet style)

// How much data before showing a number at all, and before calling it reliable.
export const THRESHOLDS = {
  preliminary: { foodDays: 10, weighIns: 5, spanDays: 10 },
  ready: { foodDays: 18, weighIns: 10, spanDays: 17 }
};

const DAY_MS = 86400000;

function localKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function keyToDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function daysBetween(aKey, bKey) {
  return Math.round((keyToDate(bKey) - keyToDate(aKey)) / DAY_MS);
}

/** One weight per calendar day (the latest entry of that day), sorted by date. */
export function dailyWeights(measurements) {
  const byDay = new Map();
  for (const m of measurements) {
    const w = Number(m.weightKg);
    if (!Number.isFinite(w) || w <= 0) continue;
    const key = localKey(new Date(m.date));
    const prev = byDay.get(key);
    if (!prev || new Date(m.date) >= prev.at) byDay.set(key, { key, weight: w, at: new Date(m.date) });
  }
  return [...byDay.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map(({ key, weight }) => ({ key, weight }));
}

/**
 * Smoothed weight trend: an exponential moving average that accounts for gaps between
 * weigh-ins, so water/salt swings don't read as real gain or loss.
 */
export function weightTrend(measurements) {
  const points = dailyWeights(measurements);
  let trend = null;
  let prevKey = null;
  return points.map((p) => {
    if (trend === null) {
      trend = p.weight;
    } else {
      const gap = Math.max(1, daysBetween(prevKey, p.key));
      const alpha = 1 - Math.pow(1 - TREND_ALPHA, gap);
      trend += alpha * (p.weight - trend);
    }
    prevKey = p.key;
    return { key: p.key, weight: p.weight, trend: Math.round(trend * 100) / 100 };
  });
}

/** Least-squares slope in kg/day over (dayIndex, weight) points. */
function slopePerDay(points, originKey) {
  const xs = points.map((p) => daysBetween(originKey, p.key));
  const ys = points.map((p) => p.weight);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : 0;
}

/**
 * @param days          root.days map (dateKey → day)
 * @param measurements  all weigh-ins
 * @param totalsOf      (day) → { kcal } — Storage.totals, includes beer
 * @param garminActiveOf (dateKey) → raw Garmin active kcal for that day (0 if none)
 * @param today         Date
 */
export function estimateExpenditure({ days, measurements, totalsOf, garminActiveOf, today = new Date() }) {
  const todayKey = localKey(today);
  const windowStart = new Date(today);
  windowStart.setDate(windowStart.getDate() - WINDOW_DAYS);
  const windowStartKey = localKey(windowStart);

  // Food days: complete, non-empty, strictly before today (today is still being logged).
  const foodDays = Object.values(days)
    .filter((d) => d.date >= windowStartKey && d.date < todayKey && !d.incomplete)
    .map((d) => ({ key: d.date, kcal: totalsOf(d).kcal }))
    .filter((d) => d.kcal > 0)
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  // The weight change must be measured over the same stretch the intake covers.
  const startKey = foodDays.length ? foodDays[0].key : todayKey;
  const weights = dailyWeights(measurements).filter((p) => p.key >= startKey && p.key <= todayKey);
  const spanDays = weights.length >= 2 ? daysBetween(weights[0].key, weights[weights.length - 1].key) : 0;

  const counts = { foodDays: foodDays.length, weighIns: weights.length, spanDays };
  const meets = (t) => counts.foodDays >= t.foodDays && counts.weighIns >= t.weighIns && counts.spanDays >= t.spanDays;
  const status = meets(THRESHOLDS.ready) ? "ready" : meets(THRESHOLDS.preliminary) ? "preliminary" : "collecting";

  const result = { status, ...counts };
  if (status === "collecting") return result;

  const avgIntake = foodDays.reduce((s, d) => s + d.kcal, 0) / foodDays.length;
  const slope = slopePerDay(weights, startKey); // kg/day, negative = losing
  const expenditure = avgIntake - slope * KCAL_PER_KG;
  const activeDays = foodDays.map((d) => garminActiveOf(d.key)).filter((v) => v > 0);
  const avgActive = activeDays.length ? activeDays.reduce((a, b) => a + b, 0) / activeDays.length : 0;

  return {
    ...result,
    avgIntake: Math.round(avgIntake),
    slopeKgPerWeek: Math.round(slope * 7 * 100) / 100,
    expenditure: Math.round(expenditure),
    avgActive: Math.round(avgActive),
    garminDays: activeDays.length,
    // Outside this range the logs are almost certainly incomplete — don't present it as fact.
    plausible: expenditure >= 1200 && expenditure <= 5500
  };
}

/**
 * What share of Garmin's active calories matches reality. Base = BMR × 1.2 (resting +
 * digestion + minimal movement); whatever the real expenditure has on top of that is the
 * actual activity, compared to what Garmin reported. Returns 0..1 in 0.1 steps, or null
 * when there's too little Garmin activity to judge.
 */
export function garminShare(expenditure, bmr, avgActive) {
  if (!bmr || avgActive < 100) return null;
  const share = (expenditure - bmr * 1.2) / avgActive;
  return Math.min(1, Math.max(0, Math.round(share * 10) / 10));
}
