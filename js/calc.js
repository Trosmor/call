// Mifflin-St Jeor BMR + activity multiplier + goal-rate adjustment.
// Deliberately simple, standard formulas — no personalization beyond what the profile provides.

const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9
};

export const ACTIVITY_LABELS = {
  sedentary: "Sedentary (little/no exercise)",
  light: "Light (1-3 days/week)",
  moderate: "Moderate (3-5 days/week)",
  active: "Active (6-7 days/week)",
  very_active: "Very active (physical job or 2x/day)"
};

export const GOAL_LABELS = {
  lose: "Lose weight",
  maintain: "Maintain",
  gain: "Gain weight"
};

/** kcal per kg of body fat, standard approximation used for deficit/surplus sizing. */
const KCAL_PER_KG = 7700;

export function bmr({ sex, weightKg, heightCm, age }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === "female" ? base - 161 : base + 5;
}

export function tdee(bmrValue, activityLevel) {
  return bmrValue * (ACTIVITY_MULTIPLIERS[activityLevel] || ACTIVITY_MULTIPLIERS.sedentary);
}

/**
 * Computes daily calorie + macro goals from a body profile.
 * goalRateKgPerWeek: positive for gain, negative for loss, 0 for maintain.
 */
export function computeGoals(profile) {
  const { sex, weightKg, heightCm, age, activityLevel, goal, goalRateKgPerWeek } = profile;
  const bmrValue = bmr({ sex, weightKg, heightCm, age });
  const maintenance = tdee(bmrValue, activityLevel);

  let rate = goalRateKgPerWeek || 0;
  if (goal === "lose") rate = -Math.abs(rate || 0.5);
  else if (goal === "gain") rate = Math.abs(rate || 0.25);
  else rate = 0;

  const dailyAdjustment = (rate * KCAL_PER_KG) / 7;
  // Never target below BMR: with a sedentary multiplier even the default 0.5 kg/week loss
  // pushed the goal under basal metabolism (e.g. 80 kg male: BMR 1780, goal 1586), which is
  // an unsafe recommendation. Garmin active calories are still added on top in the app.
  const rawGoal = Math.round(maintenance + dailyAdjustment);
  const calorieGoal = Math.max(rawGoal, Math.round(bmrValue));
  const clampedToBmr = calorieGoal > rawGoal;

  // Protein: ~2g/kg bodyweight (supports muscle retention in a deficit or growth in a surplus).
  const proteinGoalG = Math.round(weightKg * 2);
  // Fat: 25% of total calories.
  const fatGoalG = Math.round((calorieGoal * 0.25) / 9);
  // Carbs: remaining calories.
  const proteinKcal = proteinGoalG * 4;
  const fatKcal = fatGoalG * 9;
  const carbGoalG = Math.max(0, Math.round((calorieGoal - proteinKcal - fatKcal) / 4));

  return {
    bmr: Math.round(bmrValue),
    tdee: Math.round(maintenance),
    calorieGoal,
    proteinGoalG,
    fatGoalG,
    carbGoalG,
    clampedToBmr
  };
}
