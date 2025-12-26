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
    // 追加：画像/動画 → 取説原稿案（統合モード）
    // =========================================================
    // 【背景】
    // - Vercel Hobby は Serverless Functions を増やせないため
    //   新規 /api/media-manual.js を作らず、既存 manual-ai.js に統合する。
    //
    // 【フロントからの想定POST】
    // {
    //   mode: "media-manual",
    //   category: "...", userType: "...", notes: "...",
    //   images: [{ name:"...", dataUrl:"data:image/jpeg;base64,..." }, ...]
    // }
    //
    // 【返却】
    // - 既存互換のため { text } を返す（フロントも data.text を表示する）
    // =========================================================
    if ((mode || "") === "media-manual") {
      const category = String(body.category || "");
      const userType = String(body.userType || "");
      const notes = String(body.notes || "");
      const images = Array.isArray(body.images) ? body.images : [];

      if (!images.length) {
        return res.status(400).json({ error: "NoImages" });
      }

      const sys =
        "あなたは取扱説明書（家庭用/業務用）の原稿作成のプロです。\n" +
        "ユーザーが貼り付けた画像/動画の代表フレームを観察し、取説の原稿案を日本語で作成してください。\n\n" +
        "【必須要件】\n" +
        "1) 推測で断定しない（見えていない仕様・数値・付属品は「不明」として保留）\n" +
        "2) 文章はそのまま貼れる取説調（です・ます）\n" +
        "3) 「概要→各部名称→基本操作→注意事項→お手入れ/保管→トラブルシュート」の順で出力\n" +
        "4) 画像に写るボタン/端子/表示/注意ラベルはできる限り拾う\n" +
        "5) 不確かな点は末尾に「要確認リスト」として箇条書きで列挙\n";

      const userText =
        `カテゴリ: ${category || "(未指定)"}\n` +
        `想定ユーザー: ${userType || "(未指定)"}\n` +
        (notes ? `補足: ${notes}\n` : "") +
        `画像枚数: ${images.length}\n`;

      // chat.completions のマルチモーダル形式に合わせる
      const userContent = [{ type: "text", text: userText }];

      for (const im of images) {
        const dataUrl = im?.dataUrl ? String(im.dataUrl) : "";
        if (!dataUrl.startsWith("data:image/")) continue;

        userContent.push({
          type: "image_url",
          image_url: { url: dataUrl },
        });
      }

      const messages = [
        { role: "system", content: sys },
        { role: "user", content: userContent },
      ];

      // 画像系モデル設定を使う（後で環境変数運用に戻してOK）
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
    res.status(200).json({ text });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "OpenAIError",
      detail: String(err),
    });
  }
}
