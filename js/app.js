import { Storage } from "./storage.js";
import { ClaudeClient, ClaudeAPIError } from "./claude.js";
import { computeGoals, ACTIVITY_LABELS, GOAL_LABELS } from "./calc.js";
import { Garmin } from "./garmin.js";

// Bump on every deploy — shown in Settings so it's easy to check which version the phone runs.
const APP_VERSION = "2026-07-15.1";

const MEAL_META = {
  breakfast: { label: "Breakfast", icon: "☀️" },
  lunch: { label: "Lunch", icon: "🍴" },
  dinner: { label: "Dinner", icon: "🌙" },
  snack: { label: "Snack", icon: "🍪" }
};

const state = {
  selectedDate: new Date(),
  weekAnchor: new Date(),
  openMeals: new Set(["breakfast"]),
  activeMealTypeForDialog: "breakfast",
  editingItemId: null, // non-null while create-dialog is repurposed for editing an existing item
  dialogBase: null // original grams/kcal/macros snapshot, used to scale macros when grams changes
};

const el = (id) => document.getElementById(id);

// ---------- date helpers ----------

function dateOnly(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function isSameDay(a, b) {
  return dateOnly(a).getTime() === dateOnly(b).getTime();
}

function weekDates(anchor) {
  const a = dateOnly(anchor);
  const weekday = a.getDay(); // 0 Sun..6 Sat
  const mondayIndex = (weekday + 6) % 7;
  const monday = new Date(a);
  monday.setDate(a.getDate() - mondayIndex);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function currentMealTypeHeuristic() {
  const hour = new Date().getHours();
  if (hour < 11) return "breakfast";
  if (hour < 16) return "lunch";
  if (hour < 21) return "dinner";
  return "snack";
}

/**
 * Single source of truth for "which meal does a new log land in", used both to render the
 * "Logging to X" label and to actually route the entry — so what's displayed always matches
 * what happens. If exactly one meal card is expanded, that's the target (matches how people
 * naturally signal intent by opening the card first); otherwise fall back to time of day.
 */
function resolveDefaultMealType() {
  if (state.openMeals.size === 1) {
    return [...state.openMeals][0];
  }
  return currentMealTypeHeuristic();
}

// ---------- rendering ----------

function renderWeekSelector() {
  const container = el("week-selector");
  const days = weekDates(state.weekAnchor);
  const dayCols = days
    .map((d) => {
      const selected = isSameDay(d, state.selectedDate) ? " selected" : "";
      const weekday = d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
      return `<div class="day-col${selected}" data-date="${d.toISOString()}">
        <div class="weekday">${weekday}</div>
        <div class="num">${d.getDate()}</div>
      </div>`;
    })
    .join("");

  container.innerHTML = `
    <button class="week-nav" id="week-prev">‹</button>
    <div class="week-days">${dayCols}</div>
    <button class="week-nav" id="week-next">›</button>
  `;

  el("week-prev").onclick = () => {
    const a = new Date(state.weekAnchor);
    a.setDate(a.getDate() - 7);
    state.weekAnchor = a;
    renderWeekSelector();
  };
  el("week-next").onclick = () => {
    const a = new Date(state.weekAnchor);
    a.setDate(a.getDate() + 7);
    state.weekAnchor = a;
    renderWeekSelector();
  };
  container.querySelectorAll(".day-col").forEach((node) => {
    node.onclick = () => {
      state.selectedDate = new Date(node.dataset.date);
      renderAll();
    };
  });
}

function renderSummary(day, profile) {
  const totals = Storage.totals(day);
  const garminDay = Garmin.dayFor(day.date);
  const activeCalories = garminDay?.activeCalories || 0;
  const goal = (day.calorieGoal || profile.dailyCalorieGoal) + activeCalories;
  const left = goal - totals.kcal;
  const progress = goal > 0 ? Math.min(Math.max(totals.kcal / goal, 0), 1) : 0;

  el("eaten-value").textContent = totals.kcal;
  el("left-value").textContent = left;
  el("calorie-progress").style.width = `${progress * 100}%`;
  el("calorie-goal-label").textContent = activeCalories
    ? `${goal} kcal (${day.calorieGoal} + ${activeCalories} from Garmin)`
    : `${goal} kcal`;

  setMacro("protein", totals.protein, day.proteinGoalG);
  setMacro("fat", totals.fat, day.fatGoalG);
  setMacro("carb", totals.carb, day.carbGoalG);
}

function renderGarminCard(day) {
  const garminDay = Garmin.dayFor(day.date);
  const card = el("garmin-card");
  if (!garminDay) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const tiles = [
    ["Steps", garminDay.steps ?? "—"],
    ["Active kcal", garminDay.activeCalories ?? "—"],
    ["Sleep", garminDay.sleepHours ? `${garminDay.sleepHours}h` : "—"],
    ["Resting HR", garminDay.restingHeartRate ?? "—"],
    ["HRV", garminDay.hrvLastNightAvg ?? "—"],
    ["Body Battery", garminDay.bodyBatteryHigh ? `${garminDay.bodyBatteryLow}-${garminDay.bodyBatteryHigh}` : "—"],
    ["Stress", garminDay.avgStressLevel ?? "—"],
    ["Weight", garminDay.weightKg ? `${garminDay.weightKg}kg` : "—"]
  ];
  el("garmin-stats").innerHTML = tiles
    .map(([label, value]) => `<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`)
    .join("");
}

function setMacro(name, value, goal) {
  el(`${name}-value`).textContent = value;
  el(`${name}-value`).nextSibling.textContent = `/${goal}`;
  const progress = goal > 0 ? Math.min(Math.max(value / goal, 0), 1) : 0;
  el(`${name}-progress`).style.width = `${progress * 100}%`;
}

function renderMeals(day) {
  const container = el("meal-list");
  container.innerHTML = Storage.MEAL_TYPES.map((type) => mealCardHTML(day, type)).join("");

  Storage.MEAL_TYPES.forEach((type) => {
    el(`meal-header-${type}`).onclick = () => {
      if (state.openMeals.has(type)) state.openMeals.delete(type);
      else state.openMeals.add(type);
      renderMeals(day);
      renderLoggingMealLabel(); // opening/closing a card changes where a new log will land
    };
  });

  container.querySelectorAll("[data-delete-item]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const { mealType, itemId } = btn.dataset;
      Storage.deleteFoodItem(state.selectedDate, mealType, itemId);
      renderAll();
    };
  });

  container.querySelectorAll("[data-edit-item]").forEach((node) => {
    node.onclick = (e) => {
      e.stopPropagation();
      const { mealType, itemId } = node.dataset;
      openEditDialog(day, mealType, itemId);
    };
  });

  container.querySelectorAll("[data-search-meal]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openSearchDialog(btn.dataset.searchMeal);
    };
  });
  container.querySelectorAll("[data-create-meal]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openCreateDialog(btn.dataset.createMeal);
    };
  });

  container.querySelectorAll("[data-repeat-meal]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const mealType = btn.dataset.repeatMeal;
      const yesterday = new Date(state.selectedDate);
      yesterday.setDate(yesterday.getDate() - 1);
      const copied = Storage.copyMealType(yesterday, state.selectedDate, mealType);
      if (!copied) {
        setLoggingFeedback(`Вчера ${MEAL_META[mealType].label.toLowerCase()} не логировался.`, "error");
        return;
      }
      setLoggingFeedback(`Скопировано ${copied} продукт(ов) в ${MEAL_META[mealType].label}.`, "success");
      renderAll();
    };
  });
}

function mealCardHTML(day, type) {
  const meta = MEAL_META[type];
  const items = day.meals[type];
  const kcal = Storage.mealTotalKcal(day, type);
  const isOpen = state.openMeals.has(type);

  const rows = items
    .map(
      (item) => `
    <div class="food-item-row">
      <div class="food-item-name" data-edit-item data-meal-type="${type}" data-item-id="${item.id}">${escapeHtml(item.name)}<span class="food-item-macros">${Math.round(item.proteinG)}p · ${Math.round(item.fatG)}f · ${Math.round(item.carbG)}c</span></div>
      <div class="food-item-grams">${Math.round(item.grams)}</div>
      <div class="food-item-kcal">${item.kcal}</div>
      <button class="food-item-delete" data-delete-item data-meal-type="${type}" data-item-id="${item.id}">✕</button>
    </div>`
    )
    .join("");

  return `
    <div class="meal-card">
      <div class="meal-header" id="meal-header-${type}">
        <div class="meal-icon">${meta.icon}</div>
        <div>
          <div class="meal-title">${meta.label}</div>
          <div class="meal-sub">${items.length} items</div>
        </div>
        <div class="meal-kcal-badge">${kcal} kcal</div>
        <div class="chevron">${isOpen ? "▲" : "▼"}</div>
      </div>
      <div class="meal-body ${isOpen ? "open" : ""}">
        ${
          items.length
            ? `<div class="items-header"><span>TITLE</span><span>GRAMS</span><span>KCAL</span><span></span></div>${rows}`
            : ""
        }
        <div class="add-food-row">
          <button class="btn-search" data-search-meal="${type}">Search</button>
          <button class="btn-create" data-create-meal="${type}">Create</button>
          <button class="btn-repeat-meal" data-repeat-meal="${type}">↻ Repeat yesterday's ${meta.label.toLowerCase()}</button>
        </div>
      </div>
    </div>`;
}

function renderWater(day) {
  const percent = day.waterGoalMl > 0 ? Math.round((day.waterLoggedMl / day.waterGoalMl) * 100) : 0;
  el("water-percent").textContent = `${percent}% goal`;
  el("water-ml").textContent = `${day.waterLoggedMl} ml`;
}

function renderLoggingMealLabel() {
  const type = resolveDefaultMealType();
  el("logging-meal-label").textContent = `Logging to ${MEAL_META[type].label}`;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function renderAll() {
  const profile = Storage.getProfile();
  const day = Storage.getDay(state.selectedDate);
  renderWeekSelector();
  renderSummary(day, profile);
  renderGarminCard(day);
  renderMeals(day);
  renderWater(day);
  renderLoggingMealLabel();
}

// ---------- dialogs: search & create ----------

function openSearchDialog(mealType) {
  state.activeMealTypeForDialog = mealType;
  const dialog = el("search-dialog");
  const input = el("search-input");
  input.value = "";
  renderSearchResults("");
  input.oninput = () => renderSearchResults(input.value);
  dialog.showModal();
}

function renderSearchResults(query) {
  const list = el("search-results");
  const items = Storage.allFoodItemsHistory().filter((i) =>
    query ? i.name.toLowerCase().includes(query.toLowerCase()) : true
  );
  list.innerHTML = items
    .slice(0, 30)
    .map(
      (item) => `<li data-add-item='${JSON.stringify(item).replace(/'/g, "&#39;")}'>
        <span>${escapeHtml(item.name)} — ${Math.round(item.grams)}g, ${item.kcal} kcal</span>
        <span>+</span>
      </li>`
    )
    .join("");
  list.querySelectorAll("li").forEach((li) => {
    li.onclick = () => {
      const item = JSON.parse(li.dataset.addItem);
      Storage.addFoodItem(state.selectedDate, state.activeMealTypeForDialog, {
        ...item,
        source: "search"
      });
      el("search-dialog").close();
      renderAll();
    };
  });
}

el("btn-close-search").onclick = () => el("search-dialog").close();

function openCreateDialog(mealType) {
  state.activeMealTypeForDialog = mealType;
  state.editingItemId = null;
  state.dialogBase = null; // nothing to scale from yet — user is entering fresh values
  el("create-form").reset();
  el("create-dialog-title").textContent = "Create";
  el("create-submit-btn").textContent = "Add";
  el("create-dialog").showModal();
}

function openEditDialog(day, mealType, itemId) {
  const item = day.meals[mealType].find((i) => i.id === itemId);
  if (!item) return;
  state.activeMealTypeForDialog = mealType;
  state.editingItemId = itemId;
  // Snapshot at open time, so scaling multiple grams edits in one sitting is always
  // relative to the original values, not compounding rounding from a previous scale.
  state.dialogBase = { grams: item.grams, kcal: item.kcal, proteinG: item.proteinG, fatG: item.fatG, carbG: item.carbG };
  el("create-name").value = item.name;
  el("create-grams").value = item.grams;
  el("create-kcal").value = item.kcal;
  el("create-protein").value = item.proteinG;
  el("create-fat").value = item.fatG;
  el("create-carb").value = item.carbG;
  el("create-dialog-title").textContent = "Edit";
  el("create-submit-btn").textContent = "Save";
  el("create-dialog").showModal();
}

el("btn-close-create").onclick = () => el("create-dialog").close();

// Changing the portion size scales kcal/macros proportionally, like every other
// calorie tracker — editing grams alone used to silently leave "Left" unchanged.
el("create-grams").addEventListener("input", () => {
  const base = state.dialogBase;
  if (!base || !base.grams) return;
  const newGrams = parseFloat(el("create-grams").value);
  if (!newGrams || newGrams <= 0) return;
  const ratio = newGrams / base.grams;
  el("create-kcal").value = Math.round(base.kcal * ratio);
  el("create-protein").value = round1(base.proteinG * ratio);
  el("create-fat").value = round1(base.fatG * ratio);
  el("create-carb").value = round1(base.carbG * ratio);
});

function round1(n) {
  return Math.round(n * 10) / 10;
}

el("create-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const values = {
    name: el("create-name").value,
    grams: parseFloat(el("create-grams").value) || 0,
    kcal: parseInt(el("create-kcal").value, 10) || 0,
    proteinG: parseFloat(el("create-protein").value) || 0,
    fatG: parseFloat(el("create-fat").value) || 0,
    carbG: parseFloat(el("create-carb").value) || 0
  };
  if (state.editingItemId) {
    Storage.editFoodItem(state.selectedDate, state.activeMealTypeForDialog, state.editingItemId, values);
  } else {
    Storage.addFoodItem(state.selectedDate, state.activeMealTypeForDialog, { ...values, source: "manual" });
  }
  state.editingItemId = null;
  el("create-dialog").close();
  renderAll();
});

// ---------- repeat yesterday ----------

el("btn-repeat-yesterday").onclick = () => {
  const yesterday = new Date(state.selectedDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const copied = Storage.copyMeals(yesterday, state.selectedDate);
  if (copied === null) {
    setLoggingFeedback("Вчера ничего не залогировано.", "error");
    return;
  }
  if (copied === 0) {
    setLoggingFeedback("Вчера приёмов пищи не было.", "error");
    return;
  }
  setLoggingFeedback(`Скопировано ${copied} продукт(ов) со вчера.`, "success");
  renderAll();
};

// ---------- water ----------

el("btn-add-water").onclick = () => {
  Storage.addWater(state.selectedDate, 250);
  renderAll();
};

// ---------- navigation ----------

el("btn-settings").onclick = () => {
  loadSettingsForm();
  el("screen-today").classList.add("hidden");
  el("screen-settings").classList.remove("hidden");
};
el("btn-back").onclick = () => {
  el("screen-settings").classList.add("hidden");
  el("screen-today").classList.remove("hidden");
};

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  el(id).classList.remove("hidden");
}

document.querySelectorAll(".back-to-today").forEach((btn) => {
  btn.onclick = () => showScreen("screen-today");
});

el("btn-open-measurements").onclick = () => {
  renderMeasurements();
  showScreen("screen-measurements");
};

el("btn-open-reports").onclick = () => {
  renderReportsScreen();
  showScreen("screen-reports");
};

// ---------- settings ----------

function populateSelect(select, labels, current) {
  select.innerHTML = Object.entries(labels)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  select.value = current;
}

function loadSettingsForm() {
  const profile = Storage.getProfile();
  el("goal-kcal").value = profile.dailyCalorieGoal;
  el("goal-protein").value = profile.proteinGoalG;
  el("goal-fat").value = profile.fatGoalG;
  el("goal-carb").value = profile.carbGoalG;
  el("goal-water").value = profile.waterGoalMl;
  document.querySelector(`input[name="model"][value="${profile.preferredModel}"]`).checked = true;
  el("api-key-status").textContent = profile.apiKey ? "Key is set." : "No key set yet.";

  el("profile-age").value = profile.age ?? "";
  el("profile-sex").value = profile.sex;
  el("profile-height").value = profile.heightCm ?? "";
  el("profile-weight").value = profile.weightKg ?? "";
  populateSelect(el("profile-activity"), ACTIVITY_LABELS, profile.activityLevel);
  populateSelect(el("profile-goal"), GOAL_LABELS, profile.goal);
  el("profile-rate").value = profile.goalRateKgPerWeek ?? 0.5;
  el("calc-goals-status").textContent = "";
}

const PROFILE_FIELD_IDS = ["profile-age", "profile-sex", "profile-height", "profile-weight", "profile-activity", "profile-goal", "profile-rate"];
PROFILE_FIELD_IDS.forEach((id) => {
  el(id).addEventListener("change", () => {
    Storage.saveProfile({
      age: parseInt(el("profile-age").value, 10) || null,
      sex: el("profile-sex").value,
      heightCm: parseFloat(el("profile-height").value) || null,
      weightKg: parseFloat(el("profile-weight").value) || null,
      activityLevel: el("profile-activity").value,
      goal: el("profile-goal").value,
      goalRateKgPerWeek: parseFloat(el("profile-rate").value) || 0
    });
  });
});

el("btn-calc-goals").onclick = () => {
  const profile = Storage.getProfile();
  if (!profile.age || !profile.heightCm || !profile.weightKg) {
    el("calc-goals-status").textContent = "Fill in age, height and weight first.";
    return;
  }
  const goals = computeGoals(profile);
  Storage.saveProfile({
    dailyCalorieGoal: goals.calorieGoal,
    proteinGoalG: goals.proteinGoalG,
    fatGoalG: goals.fatGoalG,
    carbGoalG: goals.carbGoalG
  });
  el("goal-kcal").value = goals.calorieGoal;
  el("goal-protein").value = goals.proteinGoalG;
  el("goal-fat").value = goals.fatGoalG;
  el("goal-carb").value = goals.carbGoalG;
  el("calc-goals-status").textContent = `BMR ${goals.bmr} kcal · TDEE ${goals.tdee} kcal · Goal ${goals.calorieGoal} kcal`;
};

["goal-kcal", "goal-protein", "goal-fat", "goal-carb", "goal-water"].forEach((id) => {
  el(id).addEventListener("change", () => {
    Storage.saveProfile({
      dailyCalorieGoal: parseInt(el("goal-kcal").value, 10) || 0,
      proteinGoalG: parseInt(el("goal-protein").value, 10) || 0,
      fatGoalG: parseInt(el("goal-fat").value, 10) || 0,
      carbGoalG: parseInt(el("goal-carb").value, 10) || 0,
      waterGoalMl: parseInt(el("goal-water").value, 10) || 0
    });
  });
});

document.querySelectorAll('input[name="model"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    Storage.saveProfile({ preferredModel: radio.value });
  });
});

el("btn-save-key").onclick = () => {
  const key = el("api-key-input").value.trim();
  if (!key) return;
  Storage.saveProfile({ apiKey: key });
  el("api-key-input").value = "";
  el("api-key-status").textContent = "Saved.";
};

// ---------- backup ----------

el("btn-export-backup").onclick = () => {
  const json = Storage.exportBackup();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `colorize-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  el("backup-status").textContent = "Backup downloaded.";
};

el("btn-import-backup").onclick = () => el("import-backup-input").click();

el("import-backup-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  const confirmed = window.confirm(
    "Это ПОЛНОСТЬЮ заменит текущие данные в приложении содержимым файла. Продолжить?"
  );
  if (!confirmed) return;

  try {
    const text = await file.text();
    Storage.importBackup(text);
    el("backup-status").textContent = "Restored from backup.";
    loadSettingsForm();
    renderAll();
  } catch (err) {
    el("backup-status").textContent = `Ошибка восстановления: ${err.message}`;
  }
});

// ---------- logging: text / photo -> Claude ----------

function setLoggingBusy(busy) {
  el("logging-spinner").classList.toggle("hidden", !busy);
  el("btn-camera").disabled = busy;
  el("btn-send").disabled = busy;
}

function setLoggingFeedback(message, kind) {
  const node = el("logging-feedback");
  node.textContent = message || "";
  node.className = "logging-feedback" + (kind ? ` ${kind}` : "");
}

/** Finds the logged item Claude meant by target_name, preferring target_meal_type when given. */
function findLoggedItem(day, targetName, targetMealType) {
  if (!targetName) return null;
  const needle = targetName.trim().toLowerCase();
  const mealsToSearch = targetMealType ? [targetMealType] : Storage.MEAL_TYPES;
  for (const mealType of mealsToSearch) {
    const items = day.meals[mealType] || [];
    const exact = items.find((i) => i.name.toLowerCase() === needle);
    if (exact) return { mealType, item: exact };
  }
  for (const mealType of mealsToSearch) {
    const items = day.meals[mealType] || [];
    const partial = items.find(
      (i) => i.name.toLowerCase().includes(needle) || needle.includes(i.name.toLowerCase())
    );
    if (partial) return { mealType, item: partial };
  }
  return null;
}

async function applyClaudeResponse(response, thumbnailSource) {
  if (response.is_water && response.water_ml) {
    Storage.addWater(state.selectedDate, response.water_ml);
    setLoggingFeedback(`Added ${response.water_ml} ml of water`, "success");
    renderAll();
    return;
  }

  const day = Storage.getDay(state.selectedDate);

  if (response.action === "edit" || response.action === "delete") {
    const match = findLoggedItem(day, response.target_name, response.target_meal_type);
    if (!match) {
      setLoggingFeedback(`Не нашёл "${response.target_name}" среди уже залогированного сегодня.`, "error");
      return;
    }
    if (response.action === "delete") {
      Storage.deleteFoodItem(state.selectedDate, match.mealType, match.item.id);
      setLoggingFeedback(`Удалено: ${match.item.name} из ${MEAL_META[match.mealType].label}.`, "success");
    } else {
      const updated = response.items?.[0];
      if (!updated) {
        setLoggingFeedback("Claude не прислал новые значения для изменения.", "error");
        return;
      }
      Storage.editFoodItem(state.selectedDate, match.mealType, match.item.id, {
        name: updated.name || match.item.name,
        grams: updated.grams,
        kcal: updated.kcal,
        proteinG: updated.protein_g,
        fatG: updated.fat_g,
        carbG: updated.carb_g
      });
      setLoggingFeedback(
        `Изменено: ${updated.name || match.item.name} → ${Math.round(updated.grams)}g, ${updated.kcal} kcal (${MEAL_META[match.mealType].label}).`,
        "success"
      );
    }
    renderAll();
    return;
  }

  const mealType = response.meal_type || resolveDefaultMealType();
  const summaries = [];
  for (const item of response.items || []) {
    Storage.addFoodItem(state.selectedDate, mealType, {
      name: item.name,
      grams: item.grams,
      kcal: item.kcal,
      proteinG: item.protein_g,
      fatG: item.fat_g,
      carbG: item.carb_g,
      source: thumbnailSource
    });
    summaries.push(`${item.name} ${Math.round(item.grams)}g, ${item.kcal} kcal`);
  }
  setLoggingFeedback(
    summaries.length ? `Added to ${MEAL_META[mealType].label}: ${summaries.join("; ")}` : "",
    "success"
  );
  renderAll();
}

async function runClaudeRequest(fn, thumbnailSource) {
  const profile = Storage.getProfile();
  if (!profile.apiKey) {
    setLoggingFeedback("Укажи Claude API-ключ в Настройках.", "error");
    return;
  }
  setLoggingBusy(true);
  setLoggingFeedback("");
  try {
    const model = ClaudeClient.modelIdFor(profile.preferredModel);
    const response = await fn(profile.apiKey, model);
    await applyClaudeResponse(response, thumbnailSource);
  } catch (err) {
    setLoggingFeedback(err instanceof ClaudeAPIError ? err.message : `Ошибка: ${err.message}`, "error");
  } finally {
    setLoggingBusy(false);
  }
}

el("text-log-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = el("text-log-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const day = Storage.getDay(state.selectedDate);
  const alreadyLoggedByMeal = {};
  for (const mealType of Storage.MEAL_TYPES) {
    alreadyLoggedByMeal[mealType] = day.meals[mealType].map((i) => ({
      name: i.name,
      grams: i.grams,
      kcal: i.kcal
    }));
  }
  await runClaudeRequest(
    (apiKey, model) => ClaudeClient.analyzeFoodText(apiKey, model, text, alreadyLoggedByMeal),
    "voice"
  );
});

el("btn-camera").onclick = () => el("camera-input").click();

el("camera-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const base64 = await resizeImageToBase64(file);
  await runClaudeRequest((apiKey, model) => ClaudeClient.analyzeFoodPhoto(apiKey, model, base64), "photo");
});

/** Downscale to ~1024px and JPEG-compress before sending, to keep vision token cost low. */
function resizeImageToBase64(file, maxDimension = 1024, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => {
      img.onload = () => {
        const scale = Math.min(maxDimension / img.width, maxDimension / img.height, 1);
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl.split(",")[1]);
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- measurements ----------

function renderWeightChart() {
  const points = Storage.allMeasurements(); // already sorted ascending by date
  const card = el("weight-chart-card");
  if (points.length < 2) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  const width = 320, height = 120, padX = 24, padY = 16;
  const weights = points.map((p) => p.weightKg);
  const minW = Math.min(...weights), maxW = Math.max(...weights);
  const range = maxW - minW || 1;

  const xFor = (i) => padX + (i / (points.length - 1)) * (width - padX * 2);
  const yFor = (w) => padY + (1 - (w - minW) / range) * (height - padY * 2);

  const linePoints = points.map((p, i) => `${xFor(i)},${yFor(p.weightKg)}`).join(" ");
  const dots = points
    .map((p, i) => `<circle class="chart-dot" cx="${xFor(i)}" cy="${yFor(p.weightKg)}" r="3"></circle>`)
    .join("");

  el("weight-chart").innerHTML = `
    <svg class="weight-chart" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <text class="chart-label" x="${padX}" y="10">${maxW.toFixed(1)}</text>
      <text class="chart-label" x="${padX}" y="${height - 4}">${minW.toFixed(1)}</text>
      <polyline class="chart-line" points="${linePoints}"></polyline>
      ${dots}
    </svg>`;
}

function renderMeasurements() {
  renderWeightChart();
  const list = el("measurement-list");
  const measurements = [...Storage.allMeasurements()].reverse();
  list.innerHTML = measurements
    .map(
      (m) => `<li>
        <span>${new Date(m.date).toLocaleDateString()}</span>
        <span>${m.weightKg.toFixed(1)} kg</span>
        <button data-delete-measurement="${m.id}">✕</button>
      </li>`
    )
    .join("") || `<li><span>No entries yet</span></li>`;

  list.querySelectorAll("[data-delete-measurement]").forEach((btn) => {
    btn.onclick = () => {
      Storage.deleteMeasurement(btn.dataset.deleteMeasurement);
      renderMeasurements();
    };
  });
}

el("measurement-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = el("measurement-weight");
  const weight = parseFloat(input.value);
  if (!weight) return;
  Storage.addMeasurement(weight);
  input.value = "";
  renderMeasurements();
});

// ---------- reports ----------

function renderReportsScreen() {
  const stats = Storage.weeklyStats(state.selectedDate, 7);
  const grid = el("weekly-stats");
  const tiles = [
    ["Avg calories", stats.daysLogged ? stats.avgKcal : "—"],
    ["Days on target", `${stats.onTargetPct}%`],
    ["Avg protein", `${stats.avgProtein}g`],
    ["Avg fat", `${stats.avgFat}g`],
    ["Avg carbs", `${stats.avgCarb}g`],
    ["Avg water", `${stats.avgWaterMl}ml`]
  ];
  grid.innerHTML = tiles
    .map(([label, value]) => `<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`)
    .join("");

  const last = Storage.getLastReport();
  if (last) {
    el("report-card").classList.remove("hidden");
    el("report-meta").textContent = `Last analyzed: ${new Date(last.generatedAt).toLocaleString()}`;
    el("report-text").innerHTML = renderMarkdown(last.text);
  } else {
    el("report-card").classList.add("hidden");
  }
  el("analyze-status").textContent = "";
}

/** Tiny, dependency-free markdown -> HTML for the AI report (headers, bold, bullet lists, paragraphs). */
function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  const lines = escaped.split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const heading = line.match(/^##+\s+(.*)/);
    const bullet = line.match(/^[-*]\s+(.*)/);
    if (heading) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h2>${inlineMarkdown(heading[1])}</h2>`;
    } else if (bullet) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineMarkdown(bullet[1])}</li>`;
    } else if (line.trim() === "") {
      if (inList) { html += "</ul>"; inList = false; }
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${inlineMarkdown(line)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

function inlineMarkdown(str) {
  return str.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

el("btn-analyze").onclick = async () => {
  const profile = Storage.getProfile();
  if (!profile.apiKey) {
    el("analyze-status").textContent = "Укажи Claude API-ключ в Настройках.";
    return;
  }
  if (!profile.age || !profile.heightCm || !profile.weightKg) {
    el("analyze-status").textContent = "Заполни профиль (возраст, рост, вес) в Настройках для точного анализа.";
    return;
  }
  const btn = el("btn-analyze");
  btn.disabled = true;
  el("analyze-status").textContent = "Анализирую...";
  try {
    const model = ClaudeClient.modelIdFor(profile.preferredModel);
    const recentDays = Storage.recentDaysForAnalysis(state.selectedDate, 7);
    for (const day of recentDays) {
      const g = Garmin.dayFor(day.date);
      if (g) {
        day.garmin = {
          steps: g.steps,
          activeCalories: g.activeCalories,
          sleepHours: g.sleepHours,
          restingHeartRate: g.restingHeartRate,
          hrvLastNightAvg: g.hrvLastNightAvg,
          avgStressLevel: g.avgStressLevel,
          bodyBatteryHigh: g.bodyBatteryHigh,
          bodyBatteryLow: g.bodyBatteryLow,
          activities: g.activities
        };
      }
    }
    const text = await ClaudeClient.analyzeNutrition(profile.apiKey, model, profile, recentDays);
    Storage.saveLastReport(text);
    renderReportsScreen();
  } catch (err) {
    el("analyze-status").textContent = err instanceof ClaudeAPIError ? err.message : `Ошибка: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
};

// ---------- service worker ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ---------- init ----------

el("app-version").textContent = `Colorize ${APP_VERSION}`;
renderAll();

Garmin.preload().then(() => {
  if (Garmin.isAvailable()) {
    Storage.importGarminWeights(Garmin.allDays());
    renderAll();
  }
});

// iOS keeps an installed PWA frozen in memory for days. When the app is resumed after
// midnight, selectedDate still points at the old "today", so new logs would silently
// land on yesterday. On resume: roll selectedDate forward (only if the user hadn't
// deliberately navigated to another day) and re-fetch Garmin data, which also goes
// stale across a suspend.
let autoSelectedKey = Storage.dateKey(state.selectedDate);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;

  const todayKey = Storage.dateKey(new Date());
  if (todayKey !== autoSelectedKey && Storage.dateKey(state.selectedDate) === autoSelectedKey) {
    state.selectedDate = new Date();
    state.weekAnchor = new Date();
    autoSelectedKey = todayKey;
    renderAll();
  }

  Garmin.refresh().then((changed) => {
    if (changed) {
      Storage.importGarminWeights(Garmin.allDays());
      renderAll();
    }
  });
});
