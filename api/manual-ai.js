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
      const notes = String(body.notes || "");
      const granularity = String(body.granularity || "standard");
      const images = Array.isArray(body.images) ? body.images : [];

      if (!images.length) {
        return res.status(400).json({ error: "NoImages" });
      }

      const sys =
        "あなたは日本語の取扱説明書向け原稿の作成者です。\n" +
        "入力の画像（動画から抽出したフレーム）を観察し、作業手順の原稿を作成してください。\n" +
        "文体は「です・ます」で統一します。\n\n" +
        "【絶対条件】\n" +
        "- 画像から断定できない仕様・数値・機能は推測で書かない（不明は不明として扱う）\n" +
        "- 危険表現、過剰な注意、禁止事項、免責、買い替え提案は出力しない\n" +
        "- 余計な前置きや結論は不要。原稿として使える文章だけを出力する\n\n" +
        "【粒度】\n" +
        "- simple: 手順数を絞り、要点のみ\n" +
        "- standard: 通常の取説レベル\n" +
        "- detailed: 迷いが出やすい箇所は補足して丁寧に（ただし推測は禁止）\n\n" +
        "【出力形式（必須）】\n" +
        "1) 1行目にタイトルを必ず出す：\n" +
        "   例）■ 電池の交換 / ■ 組み立て / ■ 操作方法\n" +
        "   ※備考に作業内容があれば、それを優先して具体的なタイトルにする\n" +
        "2) 2行目以降は番号付きで手順を列挙：\n" +
        "   1. 〜\n" +
        "   2. 〜\n" +
        "3) 最後に「確認事項：」を必要な場合のみ1〜3点\n";

      const userText =
        (notes ? `備考: ${notes}\n` : "") +
        `粒度: ${granularity}\n` +
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

