import { Storage } from "./storage.js";
import { ClaudeClient, ClaudeAPIError } from "./claude.js";

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
  activeMealTypeForDialog: "breakfast"
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
  const goal = day.calorieGoal || profile.dailyCalorieGoal;
  const left = goal - totals.kcal;
  const progress = goal > 0 ? Math.min(Math.max(totals.kcal / goal, 0), 1) : 0;

  el("eaten-value").textContent = totals.kcal;
  el("left-value").textContent = left;
  el("calorie-progress").style.width = `${progress * 100}%`;
  el("calorie-goal-label").textContent = `${goal} kcal`;

  setMacro("protein", totals.protein, day.proteinGoalG);
  setMacro("fat", totals.fat, day.fatGoalG);
  setMacro("carb", totals.carb, day.carbGoalG);
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
      <div class="food-item-name">${escapeHtml(item.name)}<span class="food-item-macros">${Math.round(item.proteinG)}p · ${Math.round(item.fatG)}f · ${Math.round(item.carbG)}c</span></div>
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
  const type = currentMealTypeHeuristic();
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
  el("create-form").reset();
  el("create-dialog").showModal();
}

el("btn-close-create").onclick = () => el("create-dialog").close();

el("create-form").addEventListener("submit", (e) => {
  e.preventDefault();
  Storage.addFoodItem(state.selectedDate, state.activeMealTypeForDialog, {
    name: el("create-name").value,
    grams: parseFloat(el("create-grams").value) || 0,
    kcal: parseInt(el("create-kcal").value, 10) || 0,
    proteinG: parseFloat(el("create-protein").value) || 0,
    fatG: parseFloat(el("create-fat").value) || 0,
    carbG: parseFloat(el("create-carb").value) || 0,
    source: "manual"
  });
  el("create-dialog").close();
  renderAll();
});

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

// ---------- settings ----------

function loadSettingsForm() {
  const profile = Storage.getProfile();
  el("goal-kcal").value = profile.dailyCalorieGoal;
  el("goal-protein").value = profile.proteinGoalG;
  el("goal-fat").value = profile.fatGoalG;
  el("goal-carb").value = profile.carbGoalG;
  el("goal-water").value = profile.waterGoalMl;
  document.querySelector(`input[name="model"][value="${profile.preferredModel}"]`).checked = true;
  el("api-key-status").textContent = profile.apiKey ? "Key is set." : "No key set yet.";
}

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

async function applyClaudeResponse(response, thumbnailSource) {
  if (response.is_water && response.water_ml) {
    Storage.addWater(state.selectedDate, response.water_ml);
    setLoggingFeedback(`Added ${response.water_ml} ml of water`, "success");
    renderAll();
    return;
  }

  const mealType = response.meal_type || currentMealTypeHeuristic();
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
  setLoggingFeedback(summaries.length ? `Added: ${summaries.join("; ")}` : "", "success");
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
  await runClaudeRequest((apiKey, model) => ClaudeClient.analyzeFoodText(apiKey, model, text), "voice");
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

// ---------- service worker ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// ---------- init ----------

renderAll();
