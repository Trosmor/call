import { Storage } from "./storage.js";
import { ClaudeClient, ClaudeAPIError } from "./claude.js";
import { computeGoals, bmr, dailyGoalAdjustment, macrosForCalories, ACTIVITY_LABELS, GOAL_LABELS } from "./calc.js";
import { estimateExpenditure, garminShare, weightTrend, THRESHOLDS } from "./expenditure.js";
import { Garmin } from "./garmin.js";
import { icon, hydrateIcons } from "./icons.js";

// Bump on every deploy — shown in Settings so it's easy to check which version the phone runs.
const APP_VERSION = "2026-09-26.1";

const MEAL_META = {
  breakfast: { label: "Breakfast", icon: "sun" },
  lunch: { label: "Lunch", icon: "utensils" },
  dinner: { label: "Dinner", icon: "moon" },
  snack: { label: "Snack", icon: "apple" }
};

/** 1234 → "1 234" (narrow no-break space), the way the big numbers read best. */
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("ru-RU");

// ---------- theme ----------

const THEME_KEY = "colorize-theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function themePreference() {
  try {
    return localStorage.getItem(THEME_KEY) || "dark";
  } catch (e) {
    return "dark";
  }
}

/** Mirrors the inline script in index.html, which applies the theme before first paint. */
function applyTheme() {
  const pref = themePreference();
  const dark = pref === "dark" || (pref === "auto" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  el("meta-theme-color").content = dark ? "#0a0a0c" : "#f2f1ed";
}

darkQuery.addEventListener("change", () => {
  if (themePreference() === "auto") applyTheme();
});

const state = {
  selectedDate: new Date(),
  weekAnchor: new Date(),
  openMeals: new Set(["breakfast"]),
  activeMealTypeForDialog: "breakfast",
  editingItemId: null, // non-null while create-dialog is repurposed for editing an existing item
  dialogMode: "create", // create | edit | add-from | library-edit — see showFoodDialog
  portionSource: null, // the My foods / recent product the portion or library sheet is about
  dialogBase: null, // original grams/kcal/macros snapshot, used to scale macros when grams changes
  ratingInFlight: new Set(), // "YYYY-MM-DD:mealType" keys with a rating request pending
  loggingBusy: false, // a photo/text logging request is in flight
  searchResults: [] // items currently listed in the Search sheet, addressed by index
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
  const logged = Storage.peekDays(days);
  const profile = Storage.getProfile();
  const today = new Date();
  const dayCols = days
    .map((d, i) => {
      const classes = ["day-col"];
      if (isSameDay(d, state.selectedDate)) classes.push("selected");
      if (isSameDay(d, today)) classes.push("today");
      // Ring around the date = share of that day's budget eaten (only for days with food).
      let ringStyle = "";
      const day = logged[i];
      const kcal = day ? Storage.totals(day).kcal : 0;
      if (kcal > 0) {
        const budget = effectiveBudget(day, profile);
        const ratio = budget > 0 ? kcal / budget : 0;
        classes.push("has-data");
        if (ratio > 1.05) classes.push("over");
        ringStyle = ` style="--p:${Math.round(Math.min(ratio, 1) * 100)}"`;
      }
      const weekday = d.toLocaleDateString("en-US", { weekday: "short" }).slice(0, 2).toUpperCase();
      return `<div class="${classes.join(" ")}" data-date="${d.toISOString()}">
        <div class="weekday">${weekday}</div>
        <div class="num"${ringStyle}>${d.getDate()}</div>
      </div>`;
    })
    .join("");

  container.innerHTML = `
    <button class="week-nav" id="week-prev" aria-label="Previous week">${icon("back")}</button>
    <div class="week-days">${dayCols}</div>
    <button class="week-nav" id="week-next" aria-label="Next week">${icon("chevron-right")}</button>
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

/** Active kcal exactly as Garmin reported them for a date key. */
function garminActiveRaw(dateKey) {
  return Math.round(Garmin.dayFor(dateKey)?.activeCalories || 0);
}

/** Share of Garmin's active kcal counted toward the budget (Settings / expenditure estimate). */
function garminPct(profile = Storage.getProfile()) {
  const pct = Number(profile.garminActivePct);
  return Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : 100;
}

/** Garmin active kcal added on top of the day's goal — scaled by the counted share. */
function garminActiveCalories(dateKey) {
  return Math.round((garminActiveRaw(dateKey) * garminPct()) / 100);
}

/** The day's effective calorie budget, exactly as the Today screen shows it. */
function effectiveBudget(day, profile) {
  return (day.calorieGoal || profile.dailyCalorieGoal) + garminActiveCalories(day.date);
}

/** Fills an SVG progress ring (a <circle> with stroke) to `progress` ∈ [0, 1]. */
function setRing(circle, progress) {
  const circumference = 2 * Math.PI * Number(circle.getAttribute("r"));
  const p = Math.min(Math.max(progress, 0), 1);
  circle.style.strokeDasharray = `${circumference}`;
  // A zero-length round-capped stroke still draws a dot — hide it entirely at 0.
  circle.style.strokeDashoffset = `${circumference * (1 - p)}`;
  circle.style.opacity = p > 0 ? "1" : "0";
}

function renderTopbar() {
  const selected = dateOnly(state.selectedDate);
  const diffDays = Math.round((selected - dateOnly(new Date())) / 86400000);
  const title =
    diffDays === 0 ? "Today"
    : diffDays === -1 ? "Yesterday"
    : diffDays === 1 ? "Tomorrow"
    : selected.toLocaleDateString("en-US", { weekday: "long" });
  el("today-title").textContent = title;
  el("today-eyebrow").textContent = selected.toLocaleDateString("en-US", {
    weekday: diffDays === 0 || Math.abs(diffDays) === 1 ? "long" : undefined,
    day: "numeric",
    month: "long"
  });
}

function renderSummary(day, profile) {
  const totals = Storage.totals(day);
  const activeCalories = garminActiveCalories(day.date);
  const goal = effectiveBudget(day, profile);
  const left = goal - totals.kcal;
  const over = left < 0;

  el("eaten-value").textContent = fmt(totals.kcal);
  el("left-value").textContent = fmt(Math.abs(left));
  el("left-label").textContent = over ? "kcal over" : "kcal left";
  el("burned-value").textContent = activeCalories ? fmt(activeCalories) : "—";
  el("goal-value").textContent = fmt(goal);
  const pct = garminPct(profile);
  el("calorie-goal-label").textContent = activeCalories
    ? `Бюджет: ${fmt(goal - activeCalories)} цель + ${fmt(activeCalories)} активных с Garmin` +
      (pct < 100 ? ` (${pct}% от ${fmt(garminActiveRaw(day.date))})` : "")
    : "";

  const ring = el("calorie-ring");
  ring.setAttribute("stroke", over ? "url(#grad-over)" : "url(#grad-kcal)");
  setRing(ring, goal > 0 ? totals.kcal / goal : 0);
  document.querySelector(".hero-card").classList.toggle("over", over);

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
    ["Steps", garminDay.steps != null ? fmt(garminDay.steps) : "—"],
    ["Active kcal", garminDay.activeCalories != null ? fmt(garminDay.activeCalories) : "—"],
    ["Sleep", garminDay.sleepHours ? `${garminDay.sleepHours}h` : "—"],
    ["Rest HR", garminDay.restingHeartRate ?? "—"],
    ["HRV", garminDay.hrvLastNightAvg ?? "—"],
    ["Battery", garminDay.bodyBatteryHigh ? `${garminDay.bodyBatteryLow}-${garminDay.bodyBatteryHigh}` : "—"],
    ["Stress", garminDay.avgStressLevel ?? "—"],
    ["Weight", garminDay.weightKg ? `${garminDay.weightKg}kg` : "—"]
  ];
  el("garmin-stats").innerHTML = tiles
    .map(([label, value]) => `<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`)
    .join("");

  // The sync runs unattended in GitHub Actions; if it breaks (e.g. the Garmin session token
  // expires) the data silently freezes — surface its age so that's noticeable.
  const hours = Garmin.hoursSinceSync();
  const ageNode = el("garmin-sync-age");
  if (hours === null) {
    ageNode.textContent = "";
    ageNode.className = "hint";
  } else {
    const age = hours < 1 ? "< 1 ч назад" : hours < 48 ? `${Math.round(hours)} ч назад` : `${Math.round(hours / 24)} дн назад`;
    ageNode.textContent = hours > 24 ? `${age} — синк сломался? Проверь GitHub Actions` : age;
    ageNode.className = hours > 24 ? "hint warn" : "hint";
  }
}

/** Workouts for the selected day, straight from Garmin (their kcal are already in active calories). */
function renderWorkouts(day) {
  const activities = Garmin.dayFor(day.date)?.activities || [];
  el("workouts-sub").textContent = activities.length
    ? `${activities.length} from Garmin`
    : Garmin.isAvailable() ? "No workouts this day" : "Connect Garmin to see workouts";
  el("workouts-list").innerHTML = activities
    .map((a) => {
      const details = [
        a.durationMin ? `${Math.round(a.durationMin)} min` : null,
        a.calories ? `${Math.round(a.calories)} kcal` : null,
        a.avgHeartRate ? `♥ ${Math.round(a.avgHeartRate)}` : null
      ].filter(Boolean).join(" · ");
      return `<li><span>${escapeHtml(a.name || a.type || "Workout")}</span><span class="hint">${details}</span></li>`;
    })
    .join("");
}

function setMacro(name, value, goal) {
  const v = Math.round(Number(value) || 0);
  const g = Math.round(Number(goal) || 0);
  el(`${name}-value`).textContent = v;
  el(`${name}-goal`).textContent = `/${g}g`;
  const progress = g > 0 ? Math.min(Math.max(v / g, 0), 1) : 0;
  el(`${name}-progress`).style.width = `${progress * 100}%`;
  el(`${name}-left`).textContent = !g ? "" : v <= g ? `${g - v}g left` : `${v - g}g over`;
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
      if (copied === -1) {
        setLoggingFeedback(`${MEAL_META[mealType].label} уже скопирован со вчера.`, "error");
        return;
      }
      if (!copied) {
        setLoggingFeedback(`Вчера ${MEAL_META[mealType].label.toLowerCase()} не логировался.`, "error");
        return;
      }
      setLoggingFeedback(`Скопировано ${copied} продукт(ов) в ${MEAL_META[mealType].label}.`, "success");
      renderAll();
    };
  });

  container.querySelectorAll("[data-rate-meal]").forEach((btn) => {
    btn.disabled = state.ratingInFlight.has(`${day.date}:${btn.dataset.rateMeal}`);
    btn.onclick = async (e) => {
      e.stopPropagation();
      await rateMeal(btn.dataset.rateMeal);
    };
  });
}

async function rateMeal(mealType) {
  const profile = Storage.getProfile();
  const route = ClaudeClient.routeFor(profile);
  if (!route.apiKey) {
    setLoggingFeedback(ClaudeClient.missingKeyMessage(route), "error");
    return;
  }
  // Capture the day and the exact items being rated BEFORE the request: the user may switch
  // days or edit the meal while waiting, and the result must land where it was asked for,
  // flagged stale if the meal changed in the meantime.
  const date = new Date(state.selectedDate);
  const day = Storage.getDay(date);
  const flightKey = `${day.date}:${mealType}`;
  if (state.ratingInFlight.has(flightKey)) return; // double tap = one paid request, not two
  const items = day.meals[mealType];
  if (!items.length) return;
  const signature = Storage.mealItemsSignature(items);

  state.ratingInFlight.add(flightKey);
  renderMeals(day);
  setLoggingFeedback(`Оцениваю ${MEAL_META[mealType].label.toLowerCase()}...`, "");
  try {
    const payloadItems = items.map((i) => ({
      name: i.name,
      grams: i.grams,
      kcal: i.kcal,
      protein_g: i.proteinG,
      fat_g: i.fatG,
      carb_g: i.carbG
    }));
    const budget = effectiveBudget(day, profile);
    const rating = await ClaudeClient.rateMeal(route, mealType, payloadItems, profile, budget);
    Storage.saveMealRating(date, mealType, { ...rating, model: route.name }, signature);
    setLoggingFeedback(`${MEAL_META[mealType].label}: ${rating.score}/100 · ${route.name}`, "success");
  } catch (err) {
    setLoggingFeedback(err instanceof ClaudeAPIError ? err.message : `Ошибка: ${err.message}`, "error");
  } finally {
    state.ratingInFlight.delete(flightKey);
    renderAll();
  }
}

function scoreBadgeClass(score) {
  if (score >= 80) return "score-good";
  if (score >= 50) return "score-mid";
  return "score-bad";
}

function mealCardHTML(day, type) {
  const meta = MEAL_META[type];
  const items = day.meals[type];
  const kcal = Storage.mealTotalKcal(day, type);
  const isOpen = state.openMeals.has(type);
  // A rating of a meal whose items were all deleted is meaningless — treat it as absent.
  const rating = items.length ? day.mealRatings && day.mealRatings[type] : null;
  const isStale = rating && rating.itemsSignature !== Storage.mealItemsSignature(items);
  const ratingPending = state.ratingInFlight.has(`${day.date}:${type}`);

  const rows = items
    .map(
      (item) => `
    <div class="food-item-row">
      <div class="food-item-name" data-edit-item data-meal-type="${type}" data-item-id="${item.id}">
        <div class="food-item-title">${escapeHtml(item.name)}</div>
        <span class="food-item-macros">${Math.round(item.grams)} g · <b class="p">P</b> ${Math.round(item.proteinG)} · <b class="f">F</b> ${Math.round(item.fatG)} · <b class="c">C</b> ${Math.round(item.carbG)}</span>
      </div>
      <div class="food-item-kcal">${fmt(item.kcal)}<small>kcal</small></div>
      <button class="food-item-delete" aria-label="Delete" data-delete-item data-meal-type="${type}" data-item-id="${item.id}">${icon("x")}</button>
    </div>`
    )
    .join("");

  const score = rating ? Math.min(Math.max(Math.round(Number(rating.score) || 0), 0), 100) : 0;
  const ratingBlock = rating
    ? `<div class="meal-rating ${scoreBadgeClass(score)}">
        <div class="score-ring" style="--p:${score}">${score}</div>
        <div class="meal-rating-body">
          ${escapeHtml(rating.comment)}
          ${rating.model ? `<div class="meal-rating-model">Оценка: ${escapeHtml(rating.model)}</div>` : ""}
          ${isStale ? `<div class="meal-rating-stale">Состав изменился с момента оценки — оцени заново.</div>` : ""}
        </div>
      </div>`
    : "";

  const sub = items.length ? `${items.length} ${items.length === 1 ? "item" : "items"}` : "Nothing logged yet";

  return `
    <div class="meal-card">
      <div class="meal-header" id="meal-header-${type}">
        <div class="meal-icon ${type}">${icon(meta.icon)}</div>
        <div>
          <div class="meal-title">${meta.label}</div>
          <div class="meal-sub">${sub}</div>
        </div>
        <div class="meal-right">
          ${rating && !isStale ? `<div class="meal-score-badge ${scoreBadgeClass(score)}">${score}</div>` : ""}
          <div class="meal-kcal${kcal ? "" : " empty"}">${fmt(kcal)}<small>kcal</small></div>
          <span class="chevron${isOpen ? " open" : ""}">${icon("chevron-down")}</span>
        </div>
      </div>
      <div class="meal-body ${isOpen ? "open" : ""}">
        ${items.length ? `<div class="food-list">${rows}</div>` : ""}
        ${ratingBlock}
        <div class="meal-actions">
          <button class="chip-btn solid" data-search-meal="${type}">${icon("star")}My foods</button>
          <button class="chip-btn" data-create-meal="${type}">${icon("pencil")}Create</button>
          ${
            items.length
              ? `<button class="chip-btn rate" data-rate-meal="${type}">${icon("sparkles")}${ratingPending ? "Rating…" : rating ? "Re-rate" : "Rate meal"}</button>`
              : ""
          }
          <button class="chip-btn" data-repeat-meal="${type}">${icon("repeat")}Yesterday's ${meta.label.toLowerCase()}</button>
        </div>
      </div>
    </div>`;
}

function renderWater(day) {
  const percent = day.waterGoalMl > 0 ? Math.round((day.waterLoggedMl / day.waterGoalMl) * 100) : 0;
  el("water-percent").textContent = `${percent}% of ${fmt(day.waterGoalMl)} ml`;
  el("water-ml").textContent = `${fmt(day.waterLoggedMl)} ml`;
  el("water-progress").style.width = `${Math.min(percent, 100)}%`;
}

/**
 * Splits the day's beer volume back into 0.5 L and 0.33 L servings for the little mug row
 * (big mug = 0.5, small = 0.33). Returns null if the volume isn't a clean combination.
 */
function beerServings(ml) {
  for (let big = Math.floor(ml / 500); big >= 0; big--) {
    const rest = ml - big * 500;
    if (rest % 330 === 0) return { big, small: rest / 330 };
  }
  return null;
}

function renderBeer(day, profile) {
  const ml = Math.round(Number(day.beerMl) || 0);
  const size = profile.beerSizeMl === 330 ? 330 : 500;
  el("beer-ml").textContent = ml ? `${(ml / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} L` : "0 ml";
  el("beer-kcal").textContent = `${fmt(Storage.beerTotals(ml).kcal)} kcal`;
  el("beer-kcal-330").textContent = `${fmt(Storage.beerTotals(330).kcal)} kcal`;
  el("beer-kcal-500").textContent = `${fmt(Storage.beerTotals(500).kcal)} kcal`;
  const radio = document.querySelector(`input[name="beer-size"][value="${size}"]`);
  if (radio) radio.checked = true;

  const servings = beerServings(ml);
  const MAX_MUGS = 12;
  el("beer-mugs").innerHTML = servings && servings.big + servings.small <= MAX_MUGS
    ? icon("beer").repeat(servings.big) + `<span class="small">${icon("beer")}</span>`.repeat(servings.small)
    : "";
}

/** "Day not fully logged" toggle + the weigh-in nudge on the Measurements row. */
function renderDayMeta(day) {
  el("day-incomplete").checked = Boolean(day.incomplete);
  const todayKey = Storage.dateKey(new Date());
  const trend = weightTrend(Storage.allMeasurements());
  const todays = trend.find((p) => p.key === todayKey);
  const last = trend[trend.length - 1];
  const sub = el("measurements-sub");
  if (todays) {
    sub.textContent = `Сегодня ${todays.weight.toFixed(1)} kg · тренд ${todays.trend.toFixed(1)}`;
    sub.className = "row-sub";
  } else {
    sub.textContent = last ? `Взвесься сегодня · тренд ${last.trend.toFixed(1)} kg` : "Взвесься сегодня — утром, до еды";
    sub.className = "row-sub nudge";
  }
}

el("day-incomplete").addEventListener("change", (e) => {
  Storage.setDayIncomplete(state.selectedDate, e.target.checked);
});

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
  renderTopbar();
  renderWeekSelector();
  renderSummary(day, profile);
  renderGarminCard(day);
  renderMeals(day);
  renderWater(day);
  renderBeer(day, profile);
  renderWorkouts(day);
  renderDayMeta(day);
  renderLoggingMealLabel();
}

// ---------- dialogs: add food (My foods + recent) & create/edit ----------
//
// One create-dialog serves five modes (state.dialogMode):
//   create        — new product typed by hand
//   edit          — a logged item of the selected day
//   add-from      — portion sheet for a My foods / recent product (grams rescale everything)
//   library-edit  — change or delete a saved My foods product

function openSearchDialog(mealType) {
  state.activeMealTypeForDialog = mealType;
  const input = el("search-input");
  input.value = "";
  renderSearchResults("");
  input.oninput = () => renderSearchResults(input.value);
  el("search-dialog").showModal();
}

function renderSearchResults(query) {
  const list = el("search-results");
  const q = query.trim().toLowerCase();
  const matches = (item) => !q || item.name.toLowerCase().includes(q);
  const library = Storage.libraryAll();
  const libraryNames = new Set(library.map((i) => i.name.toLowerCase()));
  const mine = library.filter(matches).map((i) => ({ ...i, fromLibrary: true }));
  // Recent = history minus anything already saved, so a product never shows up twice.
  const recent = Storage.allFoodItemsHistory()
    .filter((i) => matches(i) && !libraryNames.has(i.name.toLowerCase()))
    .slice(0, 30);
  // Rows are addressed by index into state.searchResults — serializing items into HTML
  // attributes broke on names containing "&" sequences the parser treats as entities.
  state.searchResults = [...mine, ...recent];

  const row = (item, idx) => `<li data-result-index="${idx}">
      ${item.fromLibrary ? `<span class="search-star">${icon("star")}</span>` : ""}
      <div class="search-result-text">
        <div class="search-result-name">${escapeHtml(item.name)}</div>
        <div class="search-result-sub">${Math.round(num(item.grams))} g · ${fmt(item.kcal)} kcal</div>
      </div>
      ${item.fromLibrary ? `<button class="search-edit" aria-label="Edit" data-edit-library="${idx}">${icon("pencil")}</button>` : ""}
      <span class="search-add">${icon("plus")}</span>
    </li>`;

  let html = "";
  if (mine.length) {
    html += `<li class="search-section">★ Мои продукты</li>` + mine.map((item, i) => row(item, i)).join("");
  } else if (!q) {
    html += `<li class="search-hint">Сохраняй частые продукты: открой продукт в дневнике или создай новый и включи «Сохранить в Мои продукты». Потом они добавляются отсюда без AI.</li>`;
  }
  if (recent.length) {
    html += `<li class="search-section">Недавние</li>` + recent.map((item, i) => row(item, mine.length + i)).join("");
  }
  if (!mine.length && !recent.length && q) html += `<li class="search-empty">Ничего не нашлось</li>`;
  list.innerHTML = html;

  list.querySelectorAll("li[data-result-index]").forEach((li) => {
    li.onclick = () => {
      const item = state.searchResults[Number(li.dataset.resultIndex)];
      if (item) openPortionDialog(item);
    };
  });
  list.querySelectorAll("[data-edit-library]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const item = state.searchResults[Number(btn.dataset.editLibrary)];
      if (item) openLibraryEditDialog(item);
    };
  });
}

el("btn-close-search").onclick = () => el("search-dialog").close();

/** Fills the create-dialog and configures its extra controls for the given mode. */
function showFoodDialog({ mode, title, submit, values = null, base = null, saveLabel = null, saveChecked = false }) {
  state.dialogMode = mode;
  state.dialogBase = base; // original values, used to scale everything when grams change
  el("create-form").reset();
  if (values) {
    el("create-name").value = values.name;
    el("create-grams").value = round1(num(values.grams));
    el("create-kcal").value = Math.round(num(values.kcal));
    el("create-protein").value = round1(num(values.proteinG));
    el("create-fat").value = round1(num(values.fatG));
    el("create-carb").value = round1(num(values.carbG));
  }
  el("create-dialog-title").textContent = title;
  el("create-submit-btn").textContent = submit;
  el("save-library-row").classList.toggle("hidden", !saveLabel);
  el("save-library-label").textContent = saveLabel || "";
  el("create-save-library").checked = saveChecked;
  const viewingOtherDay = Storage.dateKey(state.selectedDate) !== Storage.dateKey(new Date());
  el("btn-copy-to-today").classList.toggle("hidden", !(mode === "edit" && viewingOtherDay));
  el("btn-delete-library").classList.toggle("hidden", mode !== "library-edit");
  el("create-dialog").showModal();
}

function openCreateDialog(mealType) {
  state.activeMealTypeForDialog = mealType;
  state.editingItemId = null;
  showFoodDialog({ mode: "create", title: "Create", submit: "Add", saveLabel: "Сохранить в «Мои продукты»" });
}

function openEditDialog(day, mealType, itemId) {
  const item = day.meals[mealType].find((i) => i.id === itemId);
  if (!item) return;
  state.activeMealTypeForDialog = mealType;
  state.editingItemId = itemId;
  // Snapshot at open time, so scaling multiple grams edits in one sitting is always
  // relative to the original values, not compounding rounding from a previous scale.
  showFoodDialog({
    mode: "edit",
    title: "Edit",
    submit: "Save",
    values: item,
    base: { ...item },
    saveLabel: "Сохранить в «Мои продукты»"
  });
}

/** Portion sheet: pick a saved or recent product, adjust grams, add — no AI call. */
function openPortionDialog(item) {
  state.editingItemId = null;
  state.portionSource = item;
  showFoodDialog({
    mode: "add-from",
    title: `Add to ${MEAL_META[state.activeMealTypeForDialog].label}`,
    submit: "Add",
    values: item,
    base: { ...item },
    saveLabel: item.fromLibrary ? "Обновить в «Мои продукты»" : "Сохранить в «Мои продукты»"
  });
}

function openLibraryEditDialog(item) {
  state.portionSource = item;
  showFoodDialog({ mode: "library-edit", title: "My food", submit: "Save", values: item, base: { ...item } });
}

el("btn-close-create").onclick = () => el("create-dialog").close();

// Changing the portion size scales kcal/macros proportionally, like every other
// calorie tracker — editing grams alone used to silently leave "Left" unchanged.
el("create-grams").addEventListener("input", () => {
  const base = state.dialogBase;
  if (!base || !num(base.grams)) return;
  const newGrams = parseFloat(el("create-grams").value);
  if (!newGrams || newGrams <= 0) return;
  const ratio = newGrams / num(base.grams);
  el("create-kcal").value = Math.round(num(base.kcal) * ratio);
  el("create-protein").value = round1(num(base.proteinG) * ratio);
  el("create-fat").value = round1(num(base.fatG) * ratio);
  el("create-carb").value = round1(num(base.carbG) * ratio);
});

function round1(n) {
  return Math.round(n * 10) / 10;
}

function dialogValues() {
  return {
    name: el("create-name").value.trim(),
    grams: parseFloat(el("create-grams").value) || 0,
    kcal: Math.round(parseFloat(el("create-kcal").value)) || 0,
    proteinG: parseFloat(el("create-protein").value) || 0,
    fatG: parseFloat(el("create-fat").value) || 0,
    carbG: parseFloat(el("create-carb").value) || 0
  };
}

el("create-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const values = dialogValues();
  const mode = state.dialogMode;

  if (mode === "library-edit") {
    Storage.updateLibraryItem(state.portionSource.id, values);
    el("create-dialog").close();
    renderSearchResults(el("search-input").value);
    return;
  }

  const mealType = state.activeMealTypeForDialog;
  if (mode === "edit") {
    Storage.editFoodItem(state.selectedDate, mealType, state.editingItemId, values);
  } else {
    Storage.addFoodItem(state.selectedDate, mealType, { ...values, source: mode === "add-from" ? "library" : "manual" });
  }
  const saved = !el("save-library-row").classList.contains("hidden") && el("create-save-library").checked;
  if (saved) Storage.saveToLibrary(values);

  state.editingItemId = null;
  el("create-dialog").close();
  if (el("search-dialog").open) el("search-dialog").close();
  if (saved) setLoggingFeedback(`★ ${values.name} — в «Моих продуктах».`, "success");
  renderAll();
});

// Copies the item being viewed on another day into today's same meal (with any edits made
// in the sheet) — "yesterday's ice cream again" without retyping or an AI call.
el("btn-copy-to-today").onclick = () => {
  const values = dialogValues();
  const mealType = state.activeMealTypeForDialog;
  Storage.addFoodItem(new Date(), mealType, { ...values, source: "copy" });
  if (el("create-save-library").checked) Storage.saveToLibrary(values);
  el("create-dialog").close();
  setLoggingFeedback(`Скопировано на сегодня: ${values.name} → ${MEAL_META[mealType].label}.`, "success");
  renderAll();
};

el("btn-delete-library").onclick = () => {
  const item = state.portionSource;
  if (!item || !window.confirm(`Удалить «${item.name}» из «Моих продуктов»? Записи в дневнике останутся.`)) return;
  Storage.deleteLibraryItem(item.id);
  el("create-dialog").close();
  renderSearchResults(el("search-input").value);
};

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
  if (copied === -1) {
    setLoggingFeedback("Вчерашний день уже скопирован.", "error");
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

// A mistaken "+" tap had no undo before — water could only ever go up.
el("btn-remove-water").onclick = () => {
  Storage.addWater(state.selectedDate, -250);
  renderAll();
};

// ---------- beer ----------

function selectedBeerSize() {
  return Storage.getProfile().beerSizeMl === 330 ? 330 : 500;
}

el("btn-add-beer").onclick = () => {
  Storage.addBeer(state.selectedDate, selectedBeerSize());
  renderAll();
  // Little "cheers" wiggle on the mug icon.
  const mug = el("beer-icon");
  mug.classList.remove("cheers");
  void mug.offsetWidth; // restart the animation on rapid taps
  mug.classList.add("cheers");
};

el("btn-remove-beer").onclick = () => {
  Storage.addBeer(state.selectedDate, -selectedBeerSize());
  renderAll();
};

document.querySelectorAll('input[name="beer-size"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    Storage.saveProfile({ beerSizeMl: Number(radio.value) });
  });
});

// ---------- navigation ----------

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.add("hidden"));
  el(id).classList.remove("hidden");
}

el("btn-settings").onclick = () => {
  loadSettingsForm();
  showScreen("screen-settings");
};

// Re-render on the way back: goals changed in Settings (or a new weigh-in) used to stay
// invisible on the Today screen until some unrelated action triggered a render.
function backToToday() {
  showScreen("screen-today");
  renderAll();
}

el("btn-back").onclick = backToToday;
document.querySelectorAll(".back-to-today").forEach((btn) => {
  btn.onclick = backToToday;
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
  el("goal-garmin-pct").value = garminPct(profile);
  // Guarded: an unexpected value (e.g. from an old or hand-edited backup) used to throw here,
  // which aborted the whole click handler and made Settings impossible to open.
  const modelRadio =
    document.querySelector(`input[name="model"][value="${profile.preferredModel}"]`) ||
    document.querySelector('input[name="model"][value="sonnet"]');
  modelRadio.checked = true;
  const themeRadio = document.querySelector(`input[name="theme"][value="${themePreference()}"]`);
  if (themeRadio) themeRadio.checked = true;
  el("api-key-status").textContent = profile.apiKey ? "Key is set." : "No key set yet.";
  el("openrouter-key-status").textContent = profile.openrouterApiKey ? "Key is set." : "No key set yet.";

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
  el("calc-goals-status").textContent =
    `BMR ${goals.bmr} kcal · TDEE ${goals.tdee} kcal · Goal ${goals.calorieGoal} kcal` +
    (goals.clampedToBmr
      ? " — цель поднята до BMR: такой темп похудения без тренировок небезопасен. Калории с часов Garmin добавятся к ней сверху."
      : "");
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

el("goal-garmin-pct").addEventListener("change", () => {
  const pct = Math.min(Math.max(parseInt(el("goal-garmin-pct").value, 10) || 0, 0), 100);
  el("goal-garmin-pct").value = pct;
  Storage.saveProfile({ garminActivePct: pct });
});

document.querySelectorAll('input[name="theme"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    try {
      localStorage.setItem(THEME_KEY, radio.value);
    } catch (e) {
      // storage full/blocked — the theme still applies for this session
    }
    applyTheme();
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

el("btn-save-openrouter-key").onclick = () => {
  const key = el("openrouter-key-input").value.trim();
  if (!key) return;
  Storage.saveProfile({ openrouterApiKey: key });
  el("openrouter-key-input").value = "";
  el("openrouter-key-status").textContent = "Saved.";
};

// ---------- backup ----------

el("btn-export-backup").onclick = async () => {
  const json = Storage.exportBackup();
  const filename = `colorize-backup-${Storage.dateKey(new Date())}.json`;
  const file = new File([json], filename, { type: "application/json" });

  // On iOS (especially the installed home-screen app) a blob download is unreliable; the
  // share sheet offers "Save to Files" and works everywhere it's supported.
  const isTouchDevice = navigator.maxTouchPoints > 0;
  if (isTouchDevice && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      el("backup-status").textContent = "Backup saved.";
      return;
    } catch (err) {
      if (err.name === "AbortError") return; // user closed the share sheet
      // any other share failure: fall back to a plain download below
    }
  }

  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously right after click() can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
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
  state.loggingBusy = busy;
  el("logging-spinner").classList.toggle("hidden", !busy);
  el("btn-camera").disabled = busy;
  el("btn-send").disabled = busy;
}

function setLoggingFeedback(message, kind) {
  const node = el("logging-feedback");
  node.textContent = message || "";
  node.className = "logging-feedback" + (kind ? ` ${kind}` : "");
}

/** Model output → a valid meal type, or null. ("Lunch", "обед" etc. used to crash the feedback.) */
function normalizeMealType(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return Storage.MEAL_TYPES.includes(v) ? v : null;
}

/**
 * Finds the logged item Claude meant by target_name. Searches the meal it named first, then
 * every meal — the model occasionally names the wrong meal for an item it clearly means.
 */
function findLoggedItem(day, targetName, targetMealType) {
  const needle = String(targetName || "").trim().toLowerCase();
  if (!needle) return null;
  const preferred = normalizeMealType(targetMealType);
  const passes = preferred ? [[preferred], Storage.MEAL_TYPES] : [Storage.MEAL_TYPES];
  for (const meals of passes) {
    for (const mealType of meals) {
      const exact = day.meals[mealType].find((i) => (i.name || "").toLowerCase() === needle);
      if (exact) return { mealType, item: exact };
    }
    for (const mealType of meals) {
      const partial = day.meals[mealType].find((i) => {
        const name = (i.name || "").toLowerCase();
        return name && (name.includes(needle) || needle.includes(name));
      });
      if (partial) return { mealType, item: partial };
    }
  }
  return null;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Where a log should land, captured at SUBMIT time. A request takes several seconds; if the
 * user switched days or opened another meal card meanwhile, the food used to follow the
 * current screen instead of going where it was sent from.
 */
const MEAL_WORDS = {
  breakfast: /завтрак|breakfast/i,
  lunch: /обед|ланч|lunch/i,
  dinner: /ужин|dinner|supper/i,
  snack: /перекус|полдник|снек|snack/i
};

/**
 * Where new food lands. The "Logging to X" label is the contract: the model's meal_type is
 * only trusted when the user actually named a meal in the text ("на обед", "после ужина").
 * Otherwise the model used to guess from the food itself — oatmeal or eggs went to Breakfast
 * even while the label said Lunch, and photos (no text at all) were the worst case.
 */
function resolveAddMealType(modelMealType, ctx) {
  const text = ctx.text || "";
  const named = Storage.MEAL_TYPES.filter((type) => MEAL_WORDS[type].test(text));
  if (!named.length) return ctx.defaultMealType;
  return normalizeMealType(modelMealType) || named[0];
}

function captureLoggingContext(source, text = "") {
  return { date: new Date(state.selectedDate), defaultMealType: resolveDefaultMealType(), source, text };
}

function applyClaudeResponse(response, ctx) {
  const { date, source } = ctx;
  const messages = [];
  const action = source === "photo" ? "add" : response.action; // a photo can only add food

  if (action === "edit" || action === "delete") {
    const match = findLoggedItem(Storage.getDay(date), response.target_name, response.target_meal_type);
    if (!match) {
      setLoggingFeedback(`Не нашёл "${response.target_name}" среди залогированного за этот день.`, "error");
      return;
    }
    const mealLabel = MEAL_META[match.mealType].label;
    if (action === "delete") {
      Storage.deleteFoodItem(date, match.mealType, match.item.id);
      messages.push(`Удалено: ${match.item.name} из ${mealLabel}`);
    } else {
      const updated = response.items?.[0];
      if (!updated) {
        setLoggingFeedback("Claude не прислал новые значения для изменения.", "error");
        return;
      }
      // Anything the model left out keeps its current value instead of being zeroed.
      const keep = (v, current) => (v === null || v === undefined || v === "" ? current : v);
      const values = {
        name: updated.name || match.item.name,
        grams: keep(updated.grams, match.item.grams),
        kcal: keep(updated.kcal, match.item.kcal),
        proteinG: keep(updated.protein_g, match.item.proteinG),
        fatG: keep(updated.fat_g, match.item.fatG),
        carbG: keep(updated.carb_g, match.item.carbG)
      };
      Storage.editFoodItem(date, match.mealType, match.item.id, values);
      messages.push(`Изменено: ${values.name} → ${Math.round(num(values.grams))}g, ${Math.round(num(values.kcal))} kcal (${mealLabel})`);
    }
  } else {
    const items = Array.isArray(response.items) ? response.items : [];
    if (items.length) {
      const mealType = resolveAddMealType(response.meal_type, ctx);
      const summaries = items.map((item) => {
        Storage.addFoodItem(date, mealType, {
          name: item.name,
          grams: item.grams,
          kcal: item.kcal,
          proteinG: item.protein_g,
          fatG: item.fat_g,
          carbG: item.carb_g,
          source
        });
        return `${item.name} ${Math.round(num(item.grams))}g, ${Math.round(num(item.kcal))} kcal`;
      });
      messages.push(`Added to ${MEAL_META[mealType].label}: ${summaries.join("; ")}`);
    }
  }

  // Water is independent of the food action, so "съел яблоко и выпил стакан воды" logs both
  // (it used to return early on water and silently drop the food).
  const waterMl = Math.round(num(response.water_ml));
  if (response.is_water && waterMl > 0) {
    Storage.addWater(date, waterMl);
    messages.push(`+${waterMl} ml water`);
  }

  if (!messages.length) {
    setLoggingFeedback(
      source === "photo" ? "Не удалось распознать еду на фото." : "Не нашёл в сообщении еды или воды — опиши подробнее.",
      "error"
    );
    return;
  }
  const otherDay = Storage.dateKey(date) !== Storage.dateKey(state.selectedDate);
  setLoggingFeedback(
    messages.join(" · ") + (otherDay ? ` (за ${date.toLocaleDateString()})` : "") + (ctx.modelName ? ` · ${ctx.modelName}` : ""),
    "success"
  );
  renderAll();
}

/** Returns true on success, so the caller can restore the user's input on failure. */
async function runClaudeRequest(fn, ctx) {
  const route = ClaudeClient.routeFor(Storage.getProfile());
  if (!route.apiKey) {
    setLoggingFeedback(ClaudeClient.missingKeyMessage(route), "error");
    return false;
  }
  setLoggingBusy(true);
  setLoggingFeedback("");
  try {
    const response = await fn(route);
    applyClaudeResponse(response, { ...ctx, modelName: route.name });
    return true;
  } catch (err) {
    setLoggingFeedback(err instanceof ClaudeAPIError ? err.message : `Ошибка: ${err.message}`, "error");
    return false;
  } finally {
    setLoggingBusy(false);
  }
}

el("text-log-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.loggingBusy) return;
  const input = el("text-log-input");
  const text = input.value.trim();
  if (!text) return;
  const ctx = captureLoggingContext("voice", text);
  const day = Storage.getDay(ctx.date);
  const alreadyLoggedByMeal = {};
  for (const mealType of Storage.MEAL_TYPES) {
    alreadyLoggedByMeal[mealType] = day.meals[mealType].map((i) => ({
      name: i.name,
      grams: i.grams,
      kcal: i.kcal
    }));
  }
  if (recognition) recognition.abort();
  input.value = "";
  updateSendButton();
  const ok = await runClaudeRequest(
    (route) => ClaudeClient.analyzeFoodText(route, text, alreadyLoggedByMeal),
    ctx
  );
  // Give the text back on failure — a long dictation shouldn't have to be repeated.
  if (!ok && !input.value) input.value = text;
  updateSendButton();
});

// ---------- voice dictation ----------
// The main button is a mic while the field is empty and turns into "send" once there's text
// (like messengers). Dictation uses the browser's speech recognition; where it's unavailable
// or blocked (some iOS home-screen setups), fall back to the keyboard's own 🎤 dictation.

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null; // the active dictation session, if any

const SEND_BUTTON_LABELS = { mic: "Dictate", stop: "Stop dictation", send: "Send" };

function updateSendButton() {
  const btn = el("btn-send");
  const mode = recognition ? "stop" : el("text-log-input").value.trim() ? "send" : "mic";
  btn.classList.toggle("listening", mode === "stop");
  if (btn.dataset.mode === mode) return;
  btn.dataset.mode = mode;
  btn.innerHTML = icon(mode);
  btn.setAttribute("aria-label", SEND_BUTTON_LABELS[mode]);
}

function keyboardDictationHint(reason) {
  const input = el("text-log-input");
  input.focus();
  setLoggingFeedback(`${reason ? reason + " " : ""}Нажми 🎤 на клавиатуре iPhone и надиктуй, что съел.`, reason ? "error" : "");
}

function startDictation() {
  if (state.loggingBusy || recognition) return;
  if (!SpeechRecognitionCtor) {
    keyboardDictationHint("");
    return;
  }
  const input = el("text-log-input");
  const rec = new SpeechRecognitionCtor();
  rec.lang = "ru-RU";
  rec.interimResults = true;
  rec.continuous = false;
  let heardSomething = false;

  rec.onresult = (event) => {
    let text = "";
    for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
    input.value = text.trim();
    heardSomething = heardSomething || Boolean(input.value);
  };
  rec.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      keyboardDictationHint("Нет доступа к микрофону.");
    } else if (event.error === "no-speech") {
      setLoggingFeedback("Не расслышал — нажми микрофон и попробуй ещё раз.", "error");
    } else if (event.error !== "aborted") {
      keyboardDictationHint(`Диктовка не сработала (${event.error}).`);
    }
  };
  rec.onend = () => {
    recognition = null;
    updateSendButton();
    if (heardSomething && el("logging-feedback").textContent.startsWith("Слушаю")) {
      setLoggingFeedback("Проверь текст и нажми отправить.", "");
    }
  };

  try {
    rec.start();
  } catch (err) {
    keyboardDictationHint("");
    return;
  }
  recognition = rec;
  setLoggingFeedback("Слушаю… скажи, что съел или выпил.", "");
  updateSendButton();
}

el("text-log-input").addEventListener("input", updateSendButton);

el("btn-send").addEventListener("click", (e) => {
  const mode = el("btn-send").dataset.mode;
  if (mode === "send") return; // regular form submit
  e.preventDefault();
  if (mode === "stop") recognition?.stop();
  else startDictation();
});

el("btn-camera").onclick = () => el("camera-input").click();

el("camera-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || state.loggingBusy) return;
  const ctx = captureLoggingContext("photo");
  let base64;
  try {
    base64 = await resizeImageToBase64(file);
  } catch (err) {
    // Used to be an unhandled rejection: nothing happened and nothing was shown.
    setLoggingFeedback("Не удалось прочитать фото — попробуй другое.", "error");
    return;
  }
  await runClaudeRequest((route) => ClaudeClient.analyzeFoodPhoto(route, base64), ctx);
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
  const points = weightTrend(Storage.allMeasurements()); // one point per day, with smoothed trend
  const card = el("weight-chart-card");
  if (points.length < 2) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  const width = 320, height = 150, padLeft = 30, padRight = 8, padY = 14;
  const values = points.flatMap((p) => [p.weight, p.trend]);
  const minW = Math.min(...values), maxW = Math.max(...values);
  const range = maxW - minW || 1;
  const dayOf = (key) => {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  };
  const t0 = dayOf(points[0].key), t1 = dayOf(points[points.length - 1].key);

  // X is proportional to time, so gaps between weigh-ins look like gaps.
  const xFor = (key) => padLeft + ((dayOf(key) - t0) / (t1 - t0 || 1)) * (width - padLeft - padRight);
  const yFor = (w) => padY + (1 - (w - minW) / range) * (height - padY * 2);

  const trend = points.map((p) => [xFor(p.key), yFor(p.trend)]);
  const trendLine = trend.map(([x, y]) => `${x},${y}`).join(" ");
  const areaPath =
    `M${trend[0][0]},${height - padY} ` + trend.map(([x, y]) => `L${x},${y}`).join(" ") +
    ` L${trend[trend.length - 1][0]},${height - padY} Z`;
  const dots = points
    .map((p) => `<circle class="chart-raw" cx="${xFor(p.key)}" cy="${yFor(p.weight)}" r="2.5"></circle>`)
    .join("");
  const last = trend[trend.length - 1];

  el("weight-chart").innerHTML = `
    <svg class="weight-chart" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad-weight-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#ffb547" /><stop offset="1" stop-color="#ff4f6d" />
        </linearGradient>
        <linearGradient id="grad-weight-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ff4f6d" stop-opacity="0.28" /><stop offset="1" stop-color="#ff4f6d" stop-opacity="0" />
        </linearGradient>
      </defs>
      <line class="chart-grid" x1="${padLeft}" x2="${width - padRight}" y1="${padY}" y2="${padY}"></line>
      <line class="chart-grid" x1="${padLeft}" x2="${width - padRight}" y1="${height - padY}" y2="${height - padY}"></line>
      <text class="chart-label" x="0" y="${padY + 3}">${maxW.toFixed(1)}</text>
      <text class="chart-label" x="0" y="${height - padY + 3}">${minW.toFixed(1)}</text>
      <path class="chart-area" d="${areaPath}"></path>
      ${dots}
      <polyline class="chart-line" points="${trendLine}"></polyline>
      <circle class="chart-dot" cx="${last[0]}" cy="${last[1]}" r="3.5"></circle>
    </svg>`;
  const lastPoint = points[points.length - 1];
  el("weight-chart-caption").textContent =
    `Точки — взвешивания, линия — сглаженный тренд (${lastPoint.trend.toFixed(1)} kg). Скачки воды и соли тренд почти не двигают.`;
}

/** Runs the estimate on everything stored. */
function currentExpenditure() {
  return estimateExpenditure({
    days: Storage.allDays(),
    measurements: Storage.allMeasurements(),
    totalsOf: (day) => Storage.totals(day),
    garminActiveOf: garminActiveRaw
  });
}

function renderExpenditureCard() {
  const est = currentExpenditure();
  const profile = Storage.getProfile();
  const body = el("expenditure-body");

  if (est.status === "collecting") {
    const t = THRESHOLDS.preliminary;
    const bar = (have, need) => Math.min(100, Math.round((have / need) * 100));
    body.innerHTML = `
      <div class="exp-title">Собираю данные</div>
      <p class="hint">Нужно минимум ${t.foodDays} полностью записанных дней еды и ${t.weighIns} взвешиваний на отрезке от ${t.spanDays} дней. Сегодняшний день не считается — он ещё не закончен.</p>
      <div class="exp-progress"><span>Дни с едой</span><b>${est.foodDays} / ${t.foodDays}</b></div>
      <div class="progress-track"><div class="progress-fill" style="width:${bar(est.foodDays, t.foodDays)}%"></div></div>
      <div class="exp-progress"><span>Взвешивания</span><b>${est.weighIns} / ${t.weighIns}</b></div>
      <div class="progress-track"><div class="progress-fill" style="width:${bar(est.weighIns, t.weighIns)}%"></div></div>`;
    return;
  }

  const haveProfile = profile.age && profile.heightCm && profile.weightKg;
  const bmrValue = haveProfile ? bmr(profile) : null;
  const formula = haveProfile ? computeGoals(profile).tdee : null;
  const pct = garminPct(profile);
  const share = garminShare(est.expenditure, bmrValue, est.avgActive);
  const appAssumes = formula !== null ? Math.round(formula + (est.avgActive * pct) / 100) : null;
  const trendText = est.slopeKgPerWeek === 0
    ? "стоит на месте"
    : `${est.slopeKgPerWeek > 0 ? "+" : "−"}${Math.abs(est.slopeKgPerWeek).toFixed(2)} kg/нед`;

  let garminVerdict;
  if (share === null) {
    garminVerdict = est.avgActive < 100
      ? "Активных калорий Garmin слишком мало, чтобы проверить их точность."
      : "Заполни возраст, рост и вес в Настройках — без них не проверить Garmin.";
  } else if (share >= 0.8) {
    garminVerdict = `Калории Garmin близки к реальности (≈${Math.round(share * 100)}%). Учитывать их полностью — нормально.`;
  } else {
    garminVerdict = `Garmin завышает: реально подтверждается ≈${Math.round(share * 100)}% его активных калорий (в среднем ${fmt(est.avgActive)} в день).`;
  }
  // The usual culprit: an activity level above "sedentary" already includes movement, and
  // Garmin's active calories then add it a second time.
  if (appAssumes !== null && appAssumes - est.expenditure > 150) {
    garminVerdict = `Бюджет был завышен примерно на ${fmt(appAssumes - est.expenditure)} ккал в день` +
      (est.avgActive && profile.activityLevel !== "sedentary"
        ? " — активность в профиле уже учитывает движение, а Garmin добавлял его ещё раз. "
        : ". ") + garminVerdict;
  } else if (appAssumes !== null && est.expenditure - appAssumes > 150) {
    garminVerdict = `Ты тратишь примерно на ${fmt(est.expenditure - appAssumes)} ккал в день больше, чем закладывало приложение. ` + garminVerdict;
  }
  if (share !== null && est.status !== "ready") {
    garminVerdict += " Пока грубо — долю Garmin предложу поменять, когда оценка станет надёжной.";
  }

  // Suggested goal: real expenditure minus the Garmin share that will be added on top daily,
  // then the deficit for the profile's target rate — never below BMR.
  // The Garmin share is noisy (±150 kcal of error over ~600 active kcal) — only act on it
  // once the estimate is reliable; before that the goal is suggested with the current share.
  const newPct = share === null || est.status !== "ready" ? pct : Math.round(share * 100);
  const base = est.expenditure - (est.avgActive * newPct) / 100;
  let suggested = Math.round((base + dailyGoalAdjustment(profile)) / 10) * 10;
  if (bmrValue) suggested = Math.max(suggested, Math.round(bmrValue / 10) * 10);
  const changes = suggested !== profile.dailyCalorieGoal || newPct !== pct;

  body.innerHTML = `
    <div class="exp-head">
      <div>
        <div class="exp-num">${fmt(est.expenditure)}<small>kcal/день</small></div>
        <div class="hint">Реальный расход по твоим данным</div>
      </div>
      <span class="exp-badge ${est.status}">${est.status === "ready" ? "надёжно" : "предварительно"}</span>
    </div>
    ${est.plausible ? "" : `<p class="hint warn">Число выглядит неправдоподобно — похоже, часть еды не записана. Отметь неполные дни на главном экране.</p>`}
    <div class="exp-rows">
      <div><span>Ел в среднем</span><b>${fmt(est.avgIntake)} kcal</b></div>
      <div><span>Тренд веса</span><b>${trendText}</b></div>
      ${formula !== null ? `<div><span>Формула по профилю</span><b>${fmt(formula)} kcal</b></div>` : ""}
      ${appAssumes !== null && est.avgActive ? `<div><span>Приложение закладывало</span><b>${fmt(appAssumes)} kcal</b></div>` : ""}
    </div>
    <p class="exp-verdict">${garminVerdict}</p>
    <p class="hint">По ${est.foodDays} дням еды и ${est.weighIns} взвешиваниям за ${est.spanDays} дн. Чем больше данных, тем точнее.</p>
    ${est.plausible && changes ? `
      <div class="exp-suggest">
        <div>Новая цель: <b>${fmt(suggested)} kcal</b>${newPct !== pct ? ` + ${newPct}% калорий Garmin` : ""}</div>
        <div class="hint">Сейчас: ${fmt(profile.dailyCalorieGoal)} kcal + ${pct}% Garmin. Учтён темп из профиля.</div>
        <button id="btn-apply-expenditure" class="primary-btn">Применить</button>
      </div>` : ""}`;

  const apply = el("btn-apply-expenditure");
  if (apply) {
    apply.onclick = () => {
      Storage.saveProfile({
        dailyCalorieGoal: suggested,
        garminActivePct: newPct,
        ...macrosForCalories(suggested, profile.weightKg)
      });
      renderMeasurements();
    };
  }
}

function renderMeasurements() {
  renderExpenditureCard();
  renderWeightChart();
  const list = el("measurement-list");
  const measurements = [...Storage.allMeasurements()].reverse();
  list.innerHTML = measurements
    .map(
      (m) => `<li>
        <span>${new Date(m.date).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</span>
        <span class="measure-value">${num(m.weightKg).toFixed(1)} kg</span>
        <button aria-label="Delete" data-delete-measurement="${m.id}">${icon("x")}</button>
      </li>`
    )
    .join("") || `<li><span class="hint">No entries yet</span></li>`;

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
  renderAll();
});

// ---------- reports ----------

function renderReportsScreen() {
  const stats = Storage.weeklyStats(state.selectedDate, 7, garminActiveCalories);
  const grid = el("weekly-stats");
  const tiles = [
    ["Avg calories", stats.daysLogged ? fmt(stats.avgKcal) : "—"],
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
    el("report-meta").textContent =
      `Last analyzed: ${new Date(last.generatedAt).toLocaleString()}` + (last.model ? ` · ${last.model}` : "");
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
    const heading = line.match(/^\s*#{1,6}\s+(.*)/);
    const bullet = line.match(/^\s*[-*•]\s+(.*)/);
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
  // Bold first, then single-asterisk italics — the app's own "*(Ответ обрезан…)*" note
  // and the model's emphasis used to show up as literal asterisks.
  return str
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, "$1<em>$2</em>");
}

el("btn-analyze").onclick = async () => {
  const profile = Storage.getProfile();
  const route = ClaudeClient.routeFor(profile);
  if (!route.apiKey) {
    el("analyze-status").textContent = ClaudeClient.missingKeyMessage(route);
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
    const text = await ClaudeClient.analyzeNutrition(route, profile, recentDays);
    Storage.saveLastReport(text, route.name);
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
applyTheme();
hydrateIcons();
updateSendButton();
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
