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
    // 返却は { text } に統一（フロント互換）
    if ((mode || "") === "media-manual") {
      const category = String(body.category || "");
      const userType = String(body.userType || "");
      const notes = String(body.notes || "");
      const images = Array.isArray(body.images) ? body.images : [];

      if (!images.length) {
        return res.status(400).json({ error: "NoImages" });
      }

      const sys =
        "あなたは取扱説明書の「操作説明」原稿の作成者です。\n" +
        "入力の画像（動画から抽出したフレーム）を観察し、動作説明（手順）の文章だけを日本語（です・ます）で作成してください。\n\n" +
        "【絶対条件】\n" +
        "- 注意事項、警告、禁止事項、免責、買い替え提案、危険表現は出力しない\n" +
        "- 仕様や数値など、画像から断定できない内容は推測で書かない（不明として扱う）\n" +
        "- 出力は「操作手順」に集中し、冗長な前置きは不要\n\n" +
        "【出力形式】\n" +
        "見出し：操作手順\n" +
        "1. 〜 2. 〜 のように番号付きで手順を列挙\n" +
        "最後に必要なら「確認事項：〜」を1〜3点だけ\n";

      const userText =
        `カテゴリ: ${category || "(未指定)"}\n` +
        `想定ユーザー: ${userType || "(未指定)"}\n` +
        (notes ? `補足: ${notes}\n` : "") +
        `画像枚数: ${images.length}\n`;

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
        reasoning_effort: MANUAL_IMAGE_REASONING,
        verbosity: MANUAL_IMAGE_VERBOSITY,
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
      reasoning_effort: isCheck ? MANUAL_CHECK_REASONING : MANUAL_IMAGE_REASONING,
      verbosity: isCheck ? MANUAL_CHECK_VERBOSITY : MANUAL_IMAGE_VERBOSITY,
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
