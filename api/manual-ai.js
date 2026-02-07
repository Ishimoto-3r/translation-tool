// api/manual-ai.js
import OpenAI from "openai";

const MODEL_MANUAL_CHECK =
  process.env.MODEL_MANUAL_CHECK ||
  process.env.MODEL_MANUAL || // 互換用（今は残す）
  "gpt-5.2";

const MODEL_MANUAL_IMAGE = process.env.MODEL_MANUAL_IMAGE || "gpt-5.1";

const MANUAL_CHECK_REASONING = process.env.MANUAL_CHECK_REASONING || "medium";
const MANUAL_CHECK_VERBOSITY = process.env.MANUAL_CHECK_VERBOSITY || "low";

const MANUAL_IMAGE_REASONING = process.env.MANUAL_IMAGE_REASONING || "none";
const MANUAL_IMAGE_VERBOSITY = process.env.MANUAL_IMAGE_VERBOSITY || "low";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "MethodNotAllowed" });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { prompt, image, mode } = body;

    // =========================================================
    // media-manual：画像/動画フレーム → 取説「動作説明のみ」
    // =========================================================
    // フロント想定:
    // {
    //   mode: "media-manual",
    //   category, userType, notes,
    //   images: [{ name, dataUrl }, ...]
    // }
    // api/utils/prompts.js からプロンプト定数を取得
    const { MANUAL_AI_PROMPTS } = require("./utils/prompts");

    // 返却は { text } に統一（フロント互換）
    if ((mode || "") === "media-manual") {
      const notes = String(body.notes || "");
      const granularity = String(body.granularity || "standard");
      const images = Array.isArray(body.images) ? body.images : [];

      if (!images.length) {
        return res.status(400).json({ error: "NoImages" });
      }

      const sys = MANUAL_AI_PROMPTS.MEDIA_MANUAL_SYSTEM;

      const userText = MANUAL_AI_PROMPTS.MEDIA_MANUAL_USER_TEMPLATE(notes, granularity, images.length);

      const userContent = [{ type: "text", text: userText }];

      for (const im of images) {
        const dataUrl = im && im.dataUrl ? String(im.dataUrl) : "";
        if (!dataUrl) continue;
        if (!dataUrl.startsWith("data:image/") && !dataUrl.startsWith("http")) continue;

        userContent.push({
          type: "image_url",
          image_url: { url: dataUrl },
        });
      }

      const messages = [
        { role: "system", content: sys },
        { role: "user", content: userContent },
      ];

      const completion = await client.chat.completions.create({
        model: MODEL_MANUAL_IMAGE,
        messages,
      });

      const text = completion.choices[0]?.message?.content ?? "";
      return res.status(200).json({ text });
    }

    // =========================================================
    // 既存：manual-ai（check/image）
    // =========================================================
    if (!prompt) {
      return res.status(400).json({ error: "PromptRequired" });
    }

    const messages = [
      {
        role: "system",
        content: "あなたは日本語マニュアル作成のアシスタントです。必ず日本語のみで回答してください。",
      },
    ];

    const userContent = [{ type: "text", text: prompt }];

    if (typeof image === "string") {
      if (image.startsWith("data:image/") || image.startsWith("http")) {
        userContent.push({
          type: "image_url",
          image_url: { url: image },
        });
      }
    }

    messages.push({ role: "user", content: userContent });

    const isCheck = (mode || "check") === "check";

    const completion = await client.chat.completions.create({
      model: isCheck ? MODEL_MANUAL_CHECK : MODEL_MANUAL_IMAGE,
      messages,
    });


    const text = completion.choices[0]?.message?.content ?? "";
    return res.status(200).json({ text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "OpenAIError",
      detail: String(err),
    });
  }
}

