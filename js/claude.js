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

async function send(apiKey, model, userContent) {
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
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ClaudeAPIError(`Claude API вернул ошибку ${response.status}: ${body}`);
  }

  const data = await response.json();
  return parseFoodResponse(extractText(data));
}

export const ClaudeClient = {
  modelIdFor(preferredModel) {
    return MODEL_IDS[preferredModel] || MODEL_IDS.sonnet;
  },

  async analyzeFoodPhoto(apiKey, model, imageBase64, mediaType = "image/jpeg") {
    return send(apiKey, model, [
      { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
      { type: "text", text: "Распознай еду на фото и верни JSON по схеме." }
    ]);
  },

  async analyzeFoodText(apiKey, model, text) {
    return send(apiKey, model, [{ type: "text", text }]);
  }
};
