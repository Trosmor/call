// Direct browser -> Claude API client. Requires the
// "anthropic-dangerous-direct-browser-access" header to bypass CORS restrictions —
// see https://simonwillison.net/2024/Aug/23/anthropic-dangerous-direct-browser-access/
// This exposes the API key in client-side code, which is normally unsafe. It's acceptable
// here only because this is a personal, single-user, bring-your-own-key app installed on
// one device — do not reuse this pattern for anything with untrusted users.

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Same contract used for both the photo path and the voice/text path, so both
// produce one shared JSON shape that the rest of the app parses identically.
const SYSTEM_PROMPT = `Ты — модуль распознавания еды для персонального трекера калорий.
Тебе дают ЛИБО фото еды, ЛИБО текстовую расшифровку того, что съел/выпил пользователь (набрано или надиктовано).
Верни СТРОГО валидный JSON без markdown-обёртки, по схеме:

{
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
- Если это вода/напиток без калорий — заполни is_water=true, water_ml, items оставь пустым массивом.
- Если пользователь явно назвал приём пищи ("на завтрак", "перекусил") — укажи meal_type. Если не указал — верни null.
- Если на фото несколько продуктов — верни несколько элементов items.
- Граммовку и БЖУ оценивай по стандартным справочным значениям на 100г для похожих продуктов, если точный вес не указан — оцени по объёму/визуальному размеру порции.
- Если пользователь пишет что-то вроде "как есть, бинж-день на 4000 ккал" — создай один item с этим названием и суммарной калорийностью, БЖУ оцени пропорционально типичному соотношению.
- Никакого текста вне JSON.`;

// Separate system prompt for the Reports screen — a narrative nutrition/training
// analysis, not a structured logging call, so it returns plain markdown text instead of JSON.
const ANALYSIS_SYSTEM_PROMPT = `Ты — персональный нутрициолог и тренер, анализирующий дневник питания пользователя личного трекера калорий.
Тебе дают: профиль пользователя (возраст, пол, рост, вес, уровень активности, цель) и данные за последние несколько дней —
дневные суммы калорий/БЖУ относительно цели, потребление воды, и список конкретных съеденных продуктов по приёмам пищи.

Напиши разбор на русском языке в формате markdown (используй заголовки ##, списки -, **жирный** для акцентов). Включи:
1. Краткий вывод — укладывается ли пользователь в цель по калориям и БЖУ, есть ли устойчивый паттерн (систематический перебор/недобор).
2. Качество питания — достаточно ли белка, баланс жиров/углеводов, разнообразие продуктов, скрытые проблемы (мало клетчатки, много сахара/фастфуда и т.п.), если это видно из названий продуктов.
3. Вода — соответствует ли цели.
4. Конкретные рекомендации по питанию на ближайшую неделю (3-5 пунктов, практичные и выполнимые).
5. Рекомендации по тренировкам, соответствующие цели пользователя (похудение/поддержание/набор) и уровню активности — 2-4 пункта.

Пиши по делу, без воды в тексте (в переносном смысле), не повторяй сырые цифры без интерпретации. Если данных мало (1-2 дня) — прямо скажи, что для точных выводов нужно больше данных, но всё равно дай общие рекомендации по профилю.`;

const MODEL_IDS = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5"
};

export class ClaudeAPIError extends Error {}

function extractText(data) {
  const block = (data.content || []).find((b) => b.type === "text");
  if (!block) throw new ClaudeAPIError("Не удалось разобрать ответ от Claude.");
  return block.text;
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
    const text = await send(apiKey, model, SYSTEM_PROMPT, [
      { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
      { type: "text", text: "Распознай еду на фото и верни JSON по схеме." }
    ]);
    return parseFoodResponse(text);
  },

  async analyzeFoodText(apiKey, model, text) {
    const raw = await send(apiKey, model, SYSTEM_PROMPT, [{ type: "text", text }]);
    return parseFoodResponse(raw);
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
    return send(
      apiKey,
      model,
      ANALYSIS_SYSTEM_PROMPT,
      [{ type: "text", text: JSON.stringify(payload) }],
      1536
    );
  }
};
