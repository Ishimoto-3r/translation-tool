// api/manual-ai.js
const logger = require("../lib/logger");
const openaiClient = require("../lib/openai-client");
const { handleCorsPreFlight, setCorsHeaders } = require("../lib/api-helpers");

// 依存関係コンテナ（テスト用）
const deps = {
  logger,
  openaiClient,
};

const MODEL_MANUAL_CHECK =
  process.env.MODEL_MANUAL_CHECK ||
  process.env.MODEL_MANUAL || // 互換用（今は残す）
  "gpt-5.2";

const MODEL_MANUAL_IMAGE = process.env.MODEL_MANUAL_IMAGE || "gpt-5.1";

const MANUAL_CHECK_REASONING = process.env.MANUAL_CHECK_REASONING || "medium";
const MANUAL_CHECK_VERBOSITY = process.env.MANUAL_CHECK_VERBOSITY || "low";

const MANUAL_IMAGE_REASONING = process.env.MANUAL_IMAGE_REASONING || "none";
const MANUAL_IMAGE_VERBOSITY = process.env.MANUAL_IMAGE_VERBOSITY || "low";

module.exports = async function handler(req, res) {
  // CORS preflight処理（他APIと統一）
  if (handleCorsPreFlight(req, res)) return;
  setCorsHeaders(res);

  if (req.method !== "POST") {
    return res.status(405).json({ error: "MethodNotAllowed" });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { prompt, image, mode } = body;

    // バリデーション: 文字数制限 (10万文字)
    if (prompt && prompt.length > 100000) {
      return res.status(400).json({ error: "PromptTooLong", detail: "Prompt exceeds 100,000 characters." });
    }
    // バリデーション: 画像サイズ制限 (Base64で約5MB = 7MB string)
    if (typeof image === "string" && image.length > 7 * 1024 * 1024) {
      return res.status(400).json({ error: "ImageTooLarge", detail: "Image size exceeds limit." });
    }

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
    const { MANUAL_AI_PROMPTS } = require("../lib/prompts");

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

      deps.logger.info("manual-ai", `media-manual: model=${MODEL_MANUAL_IMAGE}, images=${images.length}`);
      const completion = await deps.openaiClient.chatCompletion({
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

    deps.logger.info("manual-ai", `${isCheck ? "check" : "image"}: model=${isCheck ? MODEL_MANUAL_CHECK : MODEL_MANUAL_IMAGE}`);
    const completion = await deps.openaiClient.chatCompletion({
      model: isCheck ? MODEL_MANUAL_CHECK : MODEL_MANUAL_IMAGE,
      messages,
    });

    const text = completion.choices[0]?.message?.content ?? "";
    return res.status(200).json({ text });
  } catch (err) {
    deps.logger.error("manual-ai", "Unexpected error", { error: err.message });
    return res.status(500).json({
      error: "OpenAIError",
      detail: String(err?.message || err),
    });
  }
}

module.exports._deps = deps;

