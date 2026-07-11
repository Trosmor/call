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
    }
  };
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
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD, local-agnostic enough for personal use
}

export const Storage = {
  getProfile() {
    return loadRoot().profile;
  },

  saveProfile(partial) {
    const root = loadRoot();
    root.profile = { ...root.profile, ...partial };
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

  // ---------- body measurements ----------

  addMeasurement(weightKg, note = "") {
    const root = loadRoot();
    const entry = { id: crypto.randomUUID(), date: new Date().toISOString(), weightKg, note };
    root.measurements.push(entry);
    root.measurements.sort((a, b) => new Date(a.date) - new Date(b.date));
    // Keep the profile's weight in sync so BMR/TDEE always uses the latest reading.
    root.profile.weightKg = weightKg;
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
      if (day) days.push(day);
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
      if (!day) continue;
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
