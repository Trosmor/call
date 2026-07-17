// Direct browser -> Claude API client. Requires the
// "anthropic-dangerous-direct-browser-access" header to bypass CORS restrictions —
// see https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/
// This exposes the API key in client-side code, which is normally unsafe. It's acceptable
// here only because this is a personal, single-user, bring-your-own-key app installed on
// one device — do not reuse this pattern for anything with untrusted users.

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Same contract used for the photo path and the voice/text path, so both produce one
// shared JSON shape that the rest of the app parses identically. The text path additionally
// gets a snapshot of today's already-logged items, so the model can also handle edits/deletes
// spoken in plain language ("поменяй йогурт на 250 грамм") instead of only ever adding new food.
const SYSTEM_PROMPT = `Ты — модуль распознавания еды для персонального трекера калорий.
Тебе дают ЛИБО фото еды, ЛИБО текстовую расшифровку того, что сказал/написал пользователь (набрано или надиктовано).
Для текстового ввода тебе может быть передан текущий список уже залогированных СЕГОДНЯ продуктов по приёмам пищи (JSON, поле "already_logged" в конце сообщения) — используй его, чтобы понять: пользователь хочет ДОБАВИТЬ новую еду, или ИЗМЕНИТЬ/УДАЛИТЬ уже существующую запись.

Верни СТРОГО валидный JSON без markdown-обёртки, по схеме:

{
  "action": "add" | "edit" | "delete",
  "target_name": "string | null",
  "target_meal_type": "breakfast" | "lunch" | "dinner" | "snack" | null,
  "items": [
    {
      "name": "string, короткое название продукта на русском",
      "grams": number,
      "kcal": integer,
      "protein_g": number,
      "fat_g": number,
      "carb_g": number
    }
  ],
  "meal_type": "breakfast" | "lunch" | "dinner" | "snack" | null,
  "is_water": boolean,
  "water_ml": integer | null,
  "confidence_note": "string, краткая заметка о неопределённости оценки, если есть"
}

Правила:
- action="add" (по умолчанию) — пользователь описывает НОВУЮ еду. items — новые продукты. target_name и target_meal_type — null.
- action="edit" — пользователь просит поправить/обновить уже залогированный продукт ("поменяй йогурт на 250 грамм", "у бутерброда было не 2 яйца а 1"). target_name — точное название существующего продукта из already_logged, максимально похожее на то, что имеет в виду пользователь. target_meal_type — приём пищи, где он находится в already_logged. items — ОДИН элемент с полными новыми значениями (grams/kcal/БЖУ пересчитаны под новую порцию).
- action="delete" — пользователь просит убрать/удалить уже залогированный продукт ("убери печеньки"). target_name и target_meal_type как для edit. items — пустой массив.
- Если already_logged не передан, пуст, или нет разумного совпадения по названию — считай это action="add".
- Если это вода/напиток без калорий — заполни is_water=true, water_ml, items оставь пустым массивом, action="add".
- Если пользователь явно назвал приём пищи для НОВОЙ еды ("на завтрак", "перекусил") — укажи meal_type. Если не указал — верни null (приложение само решит, куда положить).
- Если на фото несколько продуктов — верни несколько элементов items (action всегда "add" для фото, already_logged для фото не передаётся).
- Граммовку и БЖУ оценивай по стандартным справочным значениям на 100г для похожих продуктов, если точный вес не указан — оцени по объёму/визуальному размеру порции.
- Если пользователь пишет что-то вроде "как есть, бинж-день на 4000 ккал" — создай один item с этим названием и суммарной калорийностью, БЖУ оцени пропорционально типичному соотношению.
- Никакого текста вне JSON.`;

// Separate system prompt for the Reports screen — a narrative nutrition/training
// analysis, not a structured logging call, so it returns plain markdown text instead of JSON.
const ANALYSIS_SYSTEM_PROMPT = `Ты — персональный нутрициолог и тренер, анализирующий дневник питания пользователя личного трекера калорий.
Тебе дают: профиль пользователя (возраст, пол, рост, вес, уровень активности, цель) и данные за последние несколько дней —
дневные суммы калорий/БЖУ относительно цели, потребление воды, список конкретных съеденных продуктов по приёмам пищи, и
ОПЦИОНАЛЬНО поле "garmin" на день (данные с фитнес-часов): steps, activeCalories, sleepHours, restingHeartRate,
hrvLastNightAvg, avgStressLevel, bodyBatteryHigh/Low, activities (тренировки: тип, длительность, калории, средний пульс).
Поле "garmin" может отсутствовать у части или всех дней — просто игнорируй его для тех дней, где его нет.

Напиши разбор на русском языке в формате markdown (используй заголовки ##, списки -, **жирный** для акцентов). Включи:
1. Краткий вывод — укладывается ли пользователь в цель по калориям и БЖУ, есть ли устойчивый паттерн (систематический перебор/недобор).
2. Качество питания — достаточно ли белка, баланс жиров/углеводов, разнообразие продуктов, скрытые проблемы (мало клетчатки, много сахара/фастфуда и т.п.), если это видно из названий продуктов.
3. Вода — соответствует ли цели.
4. Восстановление и активность (если есть данные garmin) — соотнеси сон/HRV/стресс/body battery с питанием: например, недосып или низкий HRV на фоне жёсткого дефицита калорий — повод смягчить дефицит; много активных калорий без соответствующего увеличения белка/калорий — повод скорректировать план. Если данных garmin нет вообще ни для одного дня — пропусти этот пункт, не выдумывай.
5. Конкретные рекомендации по питанию на ближайшую неделю (3-5 пунктов, практичные и выполнимые).
6. Рекомендации по тренировкам, соответствующие цели пользователя (похудение/поддержание/набор), уровню активности и (если есть) фактической нагрузке/восстановлению из garmin — 2-4 пункта.

Пиши по делу, без воды в тексте (в переносном смысле), не повторяй сырые цифры без интерпретации. Если данных мало (1-2 дня) — прямо скажи, что для точных выводов нужно больше данных, но всё равно дай общие рекомендации по профилю.`;

// Separate system prompt for per-meal scoring — a short structured verdict on one meal,
// not the whole-day narrative the Reports screen produces.
const MEAL_RATING_SYSTEM_PROMPT = `Ты — персональный нутрициолог, оценивающий ОДИН конкретный приём пищи пользователя личного трекера калорий.
Тебе дают: тип приёма пищи (breakfast/lunch/dinner/snack), список продуктов в нём (название, граммы, ккал, БЖУ), и профиль пользователя
(цель — похудение/поддержание/набор, дневные цели по калориям и БЖУ) для контекста.

Оцени приём пищи по шкале 0-100, где ориентируйся на:
- Баланс БЖУ для этого типа приёма пищи (например, завтрак без белка — минус, ужин с преобладанием быстрых углеводов на ночь — минус).
- Соответствие порции разумной доле дневного бюджета калорий (грубо: завтрак/обед/ужин — по 25-35% дневной цели, снек — 5-15%; сильное превышение или явно голодная порция — минус).
- Качество продуктов, насколько можно судить по названиям (обработанная еда, фастфуд, много сахара — минус; цельные продукты, овощи, достаточно белка и клетчатки — плюс).
- Разумный здравый смысл нутрициолога, а не формальный подсчёт — не придирайся к мелочам, если приём пищи в целом сбалансирован.

Верни СТРОГО валидный JSON без markdown-обёртки, по схеме:
{
  "score": integer 0-100,
  "comment": "string, 2-4 предложения на русском: что было хорошо, что не так, и конкретный совет как улучшить именно этот приём пищи в следующий раз"
}

Пиши по делу, без общих фраз ("следите за питанием"), комментарий должен быть про конкретные продукты из списка. Никакого текста вне JSON.`;

const MODEL_IDS = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5"
};

export class ClaudeAPIError extends Error {}

function extractText(data) {
  const block = (data.content || []).find((b) => b.type === "text");
  if (!block) throw new ClaudeAPIError("Не удалось разобрать ответ от Claude.");
  return { text: block.text, truncated: data.stop_reason === "max_tokens" };
}

function parseFoodResponse(rawText) {
  let text = rawText.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```json/, "").replace(/```$/, "").trim();
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ClaudeAPIError("Claude вернул не-JSON ответ: " + text.slice(0, 200));
  }
}

async function send(apiKey, model, systemPrompt, userContent, maxTokens = 1024) {
  if (!apiKey) throw new ClaudeAPIError("Укажи Claude API-ключ в Настройках.");

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ClaudeAPIError(`Claude API вернул ошибку ${response.status}: ${body}`);
  }

  const data = await response.json();
  return extractText(data);
}

export const ClaudeClient = {
  modelIdFor(preferredModel) {
    return MODEL_IDS[preferredModel] || MODEL_IDS.sonnet;
  },

  async analyzeFoodPhoto(apiKey, model, imageBase64, mediaType = "image/jpeg") {
    const { text } = await send(apiKey, model, SYSTEM_PROMPT, [
      { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
      { type: "text", text: "Распознай еду на фото и верни JSON по схеме." }
    ]);
    return parseFoodResponse(text);
  },

  /**
   * `alreadyLoggedByMeal` is today's current items grouped by meal type — passing it lets
   * the model recognize edit/delete requests ("поменяй йогурт на 250 грамм") instead of
   * only ever adding new food. Omit or pass {} when there's nothing to reference yet.
   */
  async analyzeFoodText(apiKey, model, text, alreadyLoggedByMeal = {}) {
    const hasContext = Object.values(alreadyLoggedByMeal).some((items) => items && items.length);
    const content = hasContext
      ? `${text}\n\nalready_logged: ${JSON.stringify(alreadyLoggedByMeal)}`
      : text;
    const { text: raw } = await send(apiKey, model, SYSTEM_PROMPT, [{ type: "text", text: content }]);
    return parseFoodResponse(raw);
  },

  /** Returns { score: 0-100, comment }. */
  async rateMeal(apiKey, model, mealType, items, profile) {
    const payload = {
      meal_type: mealType,
      items,
      profile: {
        goal: profile.goal,
        dailyCalorieGoal: profile.dailyCalorieGoal,
        proteinGoalG: profile.proteinGoalG,
        fatGoalG: profile.fatGoalG,
        carbGoalG: profile.carbGoalG
      }
    };
    const { text } = await send(
      apiKey,
      model,
      MEAL_RATING_SYSTEM_PROMPT,
      [{ type: "text", text: JSON.stringify(payload) }],
      512
    );
    let parsed;
    try {
      parsed = JSON.parse(text.trim().replace(/^```json/, "").replace(/```$/, "").trim());
    } catch (e) {
      throw new ClaudeAPIError("Claude вернул не-JSON ответ при оценке приёма пищи.");
    }
    if (typeof parsed.score !== "number" || !parsed.comment) {
      throw new ClaudeAPIError("Не удалось разобрать оценку приёма пищи.");
    }
    return { score: Math.max(0, Math.min(100, Math.round(parsed.score))), comment: parsed.comment };
  },

  /** Returns markdown text, not JSON — see ANALYSIS_SYSTEM_PROMPT. */
  async analyzeNutrition(apiKey, model, profile, recentDays) {
    const payload = {
      profile: {
        age: profile.age,
        sex: profile.sex,
        heightCm: profile.heightCm,
        weightKg: profile.weightKg,
        activityLevel: profile.activityLevel,
        goal: profile.goal,
        goalRateKgPerWeek: profile.goalRateKgPerWeek
      },
      days: recentDays
    };
    // The prompt asks for 6 detailed sections (summary, quality, water, recovery,
    // nutrition recs, training recs) — with Garmin data included this routinely runs
    // long. Sonnet 5's tokenizer also uses ~30% more tokens per word of output than
    // older models, so a budget that looks generous by old intuition still wasn't
    // enough (cut off at section 6 with a 3000 cap) — pushed well past that.
    const { text, truncated } = await send(
      apiKey,
      model,
      ANALYSIS_SYSTEM_PROMPT,
      [{ type: "text", text: JSON.stringify(payload) }],
      6000
    );
    return truncated
      ? text + "\n\n*(Ответ обрезан по лимиту длины — попробуй ещё раз или переключись на Sonnet, если сейчас выбран Haiku.)*"
      : text;
  }
};
