// Single-blob localStorage layer. Personal single-user app — no backend, no sync.
const STORAGE_KEY = "colorize-data-v1";

const DEFAULT_PROFILE = {
  dailyCalorieGoal: 2250,
  proteinGoalG: 150,
  fatGoalG: 75,
  carbGoalG: 220,
  waterGoalMl: 2000,
  preferredModel: "sonnet", // "sonnet" | "haiku"
  apiKey: "",
  // Body profile — used for BMR/TDEE goal calculation and as context for AI nutrition analysis.
  age: null,
  sex: "male", // "male" | "female"
  heightCm: null,
  weightKg: null,
  activityLevel: "sedentary", // sedentary | light | moderate | active | very_active
  goal: "maintain", // lose | maintain | gain
  goalRateKgPerWeek: 0.5
};

const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];

function emptyDay(dateKey, profile) {
  return {
    date: dateKey,
    calorieGoal: profile.dailyCalorieGoal,
    proteinGoalG: profile.proteinGoalG,
    fatGoalG: profile.fatGoalG,
    carbGoalG: profile.carbGoalG,
    waterGoalMl: profile.waterGoalMl,
    waterLoggedMl: 0,
    meals: {
      breakfast: [],
      lunch: [],
      dinner: [],
      snack: []
    },
    // score: 0-100, comment: string, itemsSignature: used to detect the meal changed since
    // rating (so the UI can show "outdated" instead of silently displaying a stale score).
    mealRatings: {
      breakfast: null,
      lunch: null,
      dinner: null,
      snack: null
    }
  };
}

/** Cheap fingerprint of a meal's contents — used to tell whether a saved rating is stale. */
function mealItemsSignature(items) {
  return items.map((i) => `${i.name}:${Math.round(i.grams)}:${i.kcal}`).sort().join("|");
}

function loadRoot() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const root = { profile: { ...DEFAULT_PROFILE }, days: {}, measurements: [], lastReport: null };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
    return root;
  }
  const parsed = JSON.parse(raw);
  parsed.profile = { ...DEFAULT_PROFILE, ...parsed.profile };
  parsed.days = parsed.days || {};
  parsed.measurements = parsed.measurements || [];
  parsed.lastReport = parsed.lastReport || null;
  return parsed;
}

function saveRoot(root) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
}

function dateKey(date) {
  // Build the key from LOCAL date components. toISOString() converts to UTC first, which
  // shifts the calendar day for any positive UTC offset (e.g. UTC+3) — "today" at local
  // midnight becomes "yesterday" in UTC, silently filing entries under the wrong date.
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const Storage = {
  getProfile() {
    return loadRoot().profile;
  },

  saveProfile(partial) {
    const root = loadRoot();
    root.profile = { ...root.profile, ...partial };

    // Day logs snapshot the goals when first created, so a goal change would otherwise
    // never reach a day that's already open. Propagate to today and to any day that has
    // no food logged yet; past days with food keep their historical goals.
    const goalFields = ["dailyCalorieGoal", "proteinGoalG", "fatGoalG", "carbGoalG", "waterGoalMl"];
    if (goalFields.some((f) => f in partial)) {
      const todayKey = dateKey(new Date());
      for (const [key, day] of Object.entries(root.days)) {
        const hasFood = MEAL_TYPES.some((t) => day.meals[t].length > 0);
        if (key === todayKey || key > todayKey || !hasFood) {
          day.calorieGoal = root.profile.dailyCalorieGoal;
          day.proteinGoalG = root.profile.proteinGoalG;
          day.fatGoalG = root.profile.fatGoalG;
          day.carbGoalG = root.profile.carbGoalG;
          day.waterGoalMl = root.profile.waterGoalMl;
        }
      }
    }

    saveRoot(root);
    return root.profile;
  },

  /** Fetch-or-create the day, mirroring DayLogStore.dayLog(for:) from the original plan. */
  getDay(date) {
    const root = loadRoot();
    const key = dateKey(date);
    if (!root.days[key]) {
      root.days[key] = emptyDay(key, root.profile);
      saveRoot(root);
    } else if (!root.days[key].mealRatings) {
      // Backfill for days created before mealRatings existed.
      root.days[key].mealRatings = { breakfast: null, lunch: null, dinner: null, snack: null };
      saveRoot(root);
    }
    return root.days[key];
  },

  saveDay(day) {
    const root = loadRoot();
    root.days[day.date] = day;
    saveRoot(root);
  },

  addFoodItem(date, mealType, item) {
    const root = loadRoot();
    const key = dateKey(date);
    if (!root.days[key]) root.days[key] = emptyDay(key, root.profile);
    const day = root.days[key];
    if (!MEAL_TYPES.includes(mealType)) mealType = "snack";
    day.meals[mealType].push({
      id: crypto.randomUUID(),
      name: item.name,
      grams: item.grams,
      kcal: Math.round(item.kcal),
      proteinG: item.proteinG,
      fatG: item.fatG,
      carbG: item.carbG,
      source: item.source || "manual",
      createdAt: new Date().toISOString()
    });
    saveRoot(root);
    return day;
  },

  deleteFoodItem(date, mealType, itemId) {
    const root = loadRoot();
    const key = dateKey(date);
    const day = root.days[key];
    if (!day) return;
    day.meals[mealType] = day.meals[mealType].filter((i) => i.id !== itemId);
    saveRoot(root);
  },

  editFoodItem(date, mealType, itemId, updates) {
    const root = loadRoot();
    const key = dateKey(date);
    const day = root.days[key];
    if (!day) return;
    const item = day.meals[mealType].find((i) => i.id === itemId);
    if (!item) return;
    item.name = updates.name;
    item.grams = updates.grams;
    item.kcal = Math.round(updates.kcal);
    item.proteinG = updates.proteinG;
    item.fatG = updates.fatG;
    item.carbG = updates.carbG;
    saveRoot(root);
  },

  /** Copies every meal item from one day into another, e.g. "repeat yesterday". */
  copyMeals(fromDate, toDate) {
    const root = loadRoot();
    const fromKey = dateKey(fromDate);
    const toKey = dateKey(toDate);
    const fromDay = root.days[fromKey];
    if (!fromDay) return null;
    if (!root.days[toKey]) root.days[toKey] = emptyDay(toKey, root.profile);
    const toDay = root.days[toKey];

    let copiedCount = 0;
    for (const mealType of MEAL_TYPES) {
      for (const item of fromDay.meals[mealType]) {
        toDay.meals[mealType].push({
          ...item,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString()
        });
        copiedCount++;
      }
    }
    toDay.waterLoggedMl += fromDay.waterLoggedMl;
    saveRoot(root);
    return copiedCount;
  },

  /** Copies just one meal type from one day into another, e.g. "repeat yesterday's breakfast". */
  copyMealType(fromDate, toDate, mealType) {
    const root = loadRoot();
    const fromKey = dateKey(fromDate);
    const toKey = dateKey(toDate);
    const fromDay = root.days[fromKey];
    if (!fromDay || !fromDay.meals[mealType].length) return 0;
    if (!root.days[toKey]) root.days[toKey] = emptyDay(toKey, root.profile);
    const toDay = root.days[toKey];

    for (const item of fromDay.meals[mealType]) {
      toDay.meals[mealType].push({
        ...item,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString()
      });
    }
    saveRoot(root);
    return fromDay.meals[mealType].length;
  },

  addWater(date, ml) {
    const root = loadRoot();
    const key = dateKey(date);
    if (!root.days[key]) root.days[key] = emptyDay(key, root.profile);
    root.days[key].waterLoggedMl += ml;
    saveRoot(root);
    return root.days[key];
  },

  /** All previously logged food items, most recent first — backs the "Search" picker. */
  allFoodItemsHistory() {
    const root = loadRoot();
    const items = [];
    for (const day of Object.values(root.days)) {
      for (const mealType of MEAL_TYPES) {
        for (const item of day.meals[mealType]) {
          items.push(item);
        }
      }
    }
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const seen = new Set();
    return items.filter((i) => {
      const k = i.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },

  totals(day) {
    let kcal = 0, protein = 0, fat = 0, carb = 0;
    for (const mealType of MEAL_TYPES) {
      for (const item of day.meals[mealType]) {
        kcal += item.kcal;
        protein += item.proteinG;
        fat += item.fatG;
        carb += item.carbG;
      }
    }
    return { kcal, protein: Math.round(protein), fat: Math.round(fat), carb: Math.round(carb) };
  },

  mealTotalKcal(day, mealType) {
    return day.meals[mealType].reduce((sum, i) => sum + i.kcal, 0);
  },

  // ---------- meal ratings ----------

  mealItemsSignature(items) {
    return mealItemsSignature(items);
  },

  saveMealRating(date, mealType, rating) {
    const root = loadRoot();
    const key = dateKey(date);
    const day = root.days[key];
    if (!day) return;
    if (!day.mealRatings) day.mealRatings = { breakfast: null, lunch: null, dinner: null, snack: null };
    day.mealRatings[mealType] = {
      score: rating.score,
      comment: rating.comment,
      itemsSignature: mealItemsSignature(day.meals[mealType]),
      ratedAt: new Date().toISOString()
    };
    saveRoot(root);
  },

  // ---------- body measurements ----------

  addMeasurement(weightKg, note = "", date = new Date()) {
    const root = loadRoot();
    const entry = { id: crypto.randomUUID(), date: new Date(date).toISOString(), weightKg, note };
    root.measurements.push(entry);
    root.measurements.sort((a, b) => new Date(a.date) - new Date(b.date));
    // Keep the profile's weight in sync so BMR/TDEE always uses the latest reading.
    const isLatest = root.measurements[root.measurements.length - 1].id === entry.id;
    if (isLatest) root.profile.weightKg = weightKg;
    saveRoot(root);
    return entry;
  },

  deleteMeasurement(id) {
    const root = loadRoot();
    root.measurements = root.measurements.filter((m) => m.id !== id);
    saveRoot(root);
  },

  allMeasurements() {
    return loadRoot().measurements;
  },

  hasMeasurementOnDate(date) {
    const key = dateKey(date);
    return loadRoot().measurements.some((m) => dateKey(m.date) === key);
  },

  /** Auto-log weigh-ins from Garmin that aren't already recorded — dedupe by day, never overwrites a manual entry. */
  importGarminWeights(garminDays) {
    let imported = 0;
    for (const day of garminDays) {
      if (!day.weightKg) continue;
      if (this.hasMeasurementOnDate(day.date)) continue;
      this.addMeasurement(day.weightKg, "Garmin", day.date);
      imported++;
    }
    return imported;
  },

  // ---------- reports ----------

  /** Local, no-AI weekly summary — always available, costs nothing. */
  weeklyStats(referenceDate = new Date(), numDays = 7) {
    const root = loadRoot();
    const days = [];
    for (let i = 0; i < numDays; i++) {
      const d = new Date(referenceDate);
      d.setDate(d.getDate() - i);
      const key = dateKey(d);
      const day = root.days[key];
      // Merely browsing a date creates an empty day (fetch-or-create), and those
      // empties would drag every average down — only count days with actual logs.
      const hasAnyLog = day && (MEAL_TYPES.some((t) => day.meals[t].length > 0) || day.waterLoggedMl > 0);
      if (hasAnyLog) days.push(day);
    }
    if (days.length === 0) {
      return { daysLogged: 0, avgKcal: 0, avgProtein: 0, avgFat: 0, avgCarb: 0, avgWaterMl: 0, onTargetPct: 0 };
    }
    let kcalSum = 0, proteinSum = 0, fatSum = 0, carbSum = 0, waterSum = 0, onTarget = 0;
    for (const day of days) {
      const t = this.totals(day);
      kcalSum += t.kcal;
      proteinSum += t.protein;
      fatSum += t.fat;
      carbSum += t.carb;
      waterSum += day.waterLoggedMl;
      if (day.calorieGoal > 0 && Math.abs(t.kcal - day.calorieGoal) <= day.calorieGoal * 0.1) onTarget++;
    }
    const n = days.length;
    return {
      daysLogged: n,
      avgKcal: Math.round(kcalSum / n),
      avgProtein: Math.round(proteinSum / n),
      avgFat: Math.round(fatSum / n),
      avgCarb: Math.round(carbSum / n),
      avgWaterMl: Math.round(waterSum / n),
      onTargetPct: Math.round((onTarget / n) * 100)
    };
  },

  /** Compact per-day + per-meal payload for the AI analysis request — keeps token usage low. */
  recentDaysForAnalysis(referenceDate = new Date(), numDays = 7) {
    const root = loadRoot();
    const out = [];
    for (let i = numDays - 1; i >= 0; i--) {
      const d = new Date(referenceDate);
      d.setDate(d.getDate() - i);
      const key = dateKey(d);
      const day = root.days[key];
      // Skip days with nothing logged — an auto-created empty day would read as
      // "ate nothing that day" to the model and skew the analysis.
      if (!day || !MEAL_TYPES.some((t) => day.meals[t].length > 0)) continue;
      const t = this.totals(day);
      const items = [];
      for (const mealType of MEAL_TYPES) {
        for (const item of day.meals[mealType]) {
          items.push(`${mealType}: ${item.name} (${Math.round(item.grams)}g, ${item.kcal}kcal)`);
        }
      }
      out.push({
        date: key,
        totals: t,
        calorieGoal: day.calorieGoal,
        waterLoggedMl: day.waterLoggedMl,
        waterGoalMl: day.waterGoalMl,
        items
      });
    }
    return out;
  },

  getLastReport() {
    return loadRoot().lastReport;
  },

  saveLastReport(text) {
    const root = loadRoot();
    root.lastReport = { text, generatedAt: new Date().toISOString() };
    saveRoot(root);
    return root.lastReport;
  },

  // ---------- backup ----------

  /** Full JSON dump of everything in localStorage — the only copy of the data that exists. */
  exportBackup() {
    const root = loadRoot();
    return JSON.stringify({ ...root, exportedAt: new Date().toISOString(), version: 1 }, null, 2);
  },

  /** Overwrites all local data. Caller is responsible for confirming with the user first. */
  importBackup(jsonString) {
    const parsed = JSON.parse(jsonString);
    if (!parsed || typeof parsed !== "object" || !parsed.profile || !parsed.days) {
      throw new Error("Файл не похож на бэкап Colorize.");
    }
    const root = {
      profile: { ...DEFAULT_PROFILE, ...parsed.profile },
      days: parsed.days || {},
      measurements: parsed.measurements || [],
      lastReport: parsed.lastReport || null
    };
    saveRoot(root);
    return root;
  },

  dateKey,
  MEAL_TYPES
};
