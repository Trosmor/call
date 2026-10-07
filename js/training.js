// Home strength plan: pull-up bar, a wall and one long resistance band (green, thick).
// Two short sessions alternate (A = legs & chest, B = back & core), "Japanese taiso"
// style: slow tempo, pauses, a little every day. Progression is the whole point —
// each exercise shows last time's numbers and says when to add a rep or step up a level.

export const PLANS = {
  A: { title: "Ноги и грудь", exercises: ["squat", "pushup", "lunge", "wallsit", "plank"] },
  B: { title: "Спина и корпус", exercises: ["pullup", "bandrow", "facepull", "glute", "kneeraise"] }
};

// lo/hi: target range per set. unit: "reps" or "sec". perSide: reps are per leg/arm.
// levels: easier → harder variants; the user's current level lives in profile.trainingLevels.
export const EXERCISES = {
  squat: {
    name: "Приседания с паузой",
    sets: 3, lo: 8, hi: 12, unit: "reps",
    tip: "вниз 3 с, пауза 2 с, пятки в полу",
    levels: ["обычные", "резинка на плечах (стоя на ней)", "болгарские у стула, на каждую ногу"]
  },
  pushup: {
    name: "Медленные отжимания",
    sets: 3, lo: 5, hi: 10, unit: "reps",
    tip: "вниз 3 с, пауза 1 с, локти 45°, тело как доска",
    levels: ["от пола", "ноги на стуле", "ноги на стуле, резинка через спину"]
  },
  lunge: {
    name: "Выпады назад",
    sets: 2, lo: 8, hi: 12, unit: "reps", perSide: true,
    tip: "медленно вниз 3 с, колено почти касается пола",
    levels: ["рукой о стену", "без опоры", "с резинкой на плечах"]
  },
  wallsit: {
    name: "Стульчик у стены",
    sets: 2, lo: 30, hi: 60, unit: "sec",
    tip: "бёдра параллельно полу, спина прижата",
    levels: ["на двух ногах", "резинка над коленями, разводить колени"]
  },
  plank: {
    name: "Планка с дыханием",
    sets: 2, lo: 30, hi: 60, unit: "sec",
    tip: "вдох 4 с, выдох 4 с, таз не провисает",
    levels: ["на локтях", "с поочерёдным подъёмом ноги"]
  },
  pullup: {
    name: "Подтягивания",
    sets: 4, lo: 3, hi: 8, unit: "reps",
    tip: "без рывков; если не идёт — запрыгни и опускайся 5 с",
    levels: ["обычные", "пауза 1 с наверху", "вниз 3 с, пауза наверху"]
  },
  bandrow: {
    name: "Тяга резинки к поясу",
    sets: 3, lo: 12, hi: 15, unit: "reps",
    tip: "резинка за турник или вокруг стоп, лопатки сводить, пауза 1 с",
    levels: ["одинарная резинка", "встать дальше / резинка короче", "одной рукой, на каждую"]
  },
  facepull: {
    name: "Тяга резинки к лицу",
    sets: 2, lo: 15, hi: 20, unit: "reps",
    tip: "резинка на уровне лица, локти высоко, тянуть к глазам",
    levels: ["одинарная резинка", "встать дальше / резинка короче"]
  },
  glute: {
    name: "Ягодичный мост",
    sets: 3, lo: 12, hi: 15, unit: "reps",
    tip: "пауза 2 с наверху, сжимать ягодицы",
    levels: ["на двух ногах", "резинка над коленями", "на одной ноге, на каждую"]
  },
  kneeraise: {
    name: "Подъём коленей в висе",
    sets: 3, lo: 8, hi: 12, unit: "reps",
    tip: "медленно, без раскачки, таз подкручивать",
    levels: ["колени к груди", "колени к груди, вниз 3 с", "прямые ноги"]
  }
};

export function levelOf(levels, exerciseId) {
  const idx = Number(levels?.[exerciseId]) || 0;
  return Math.min(Math.max(idx, 0), EXERCISES[exerciseId].levels.length - 1);
}

/**
 * Progression advice from the previous session of this exercise.
 * `last` = { sets: number[], level } or null. Returns { text, canLevelUp }.
 */
export function progressionHint(exerciseId, last, level) {
  const ex = EXERCISES[exerciseId];
  const unit = ex.unit === "sec" ? " с" : "";
  if (!last || !last.sets.length) {
    return { text: `Цель: ${ex.sets} × ${ex.lo}–${ex.hi}${unit}. Заканчивай подход за 1–2 повтора до отказа.`, canLevelUp: false };
  }
  const sameLevel = last.level === level;
  const done = last.sets.filter((n) => n > 0);
  const allTop = sameLevel && done.length >= ex.sets && done.every((n) => n >= ex.hi);
  if (allTop) {
    const more = level < ex.levels.length - 1;
    return {
      text: more
        ? `Верх диапазона во всех подходах — пора усложнить: «${ex.levels[level + 1]}».`
        : `Верх диапазона во всех подходах — добавляй ${ex.unit === "sec" ? "по 10 с" : "по 1–2 повтора"} или замедли темп.`,
      canLevelUp: more
    };
  }
  if (!sameLevel) return { text: "Новый уровень — начни с нижней границы диапазона.", canLevelUp: false };
  const step = ex.unit === "sec" ? "+5–10 с" : "+1 повтор";
  return { text: `Сегодня: ${step} хотя бы в одном подходе.`, canLevelUp: false };
}

export function formatSets(sets, exerciseId) {
  const unit = EXERCISES[exerciseId].unit === "sec" ? " с" : "";
  return sets.filter((n) => n > 0).map((n) => `${n}${unit}`).join(", ");
}
