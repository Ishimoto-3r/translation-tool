// api/kensho-ai.js
import OpenAI from "openai";

const MODEL = process.env.MODEL_MANUAL_CHECK || "gpt-5.2";
const REASONING = process.env.MANUAL_CHECK_REASONING || "medium";
const VERBOSITY = process.env.MANUAL_CHECK_VERBOSITY || "low";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { productInfo, selectedLabels, currentRows, images } = body;

    const sys =
      "あなたは製品の検証項目を追加提案する担当者です。\n" +
      "入力情報・画像・既存の検証項目を踏まえて、追加すべき検証項目だけを提案してください。\n" +
      "出力は必ずJSON配列のみ。形式：[{\"text\":\"...\",\"note\":\"...\"}]\n" +
      "noteは任意。textは1項目=1行の検証内容。";

    const content = [
      { type: "text", text: JSON.stringify({ productInfo, selectedLabels, currentRows }, null, 2) },
    ];

    if (Array.isArray(images)) {
      for (const img of images) {
        if (typeof img === "string" && (img.startsWith("data:image/") || img.startsWith("http"))) {
          content.push({ type: "image_url", image_url: { url: img } });
        }
      }
    }

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: sys },
        { role: "user", content },
      ],
      reasoning_effort: REASONING,
      verbosity: VERBOSITY,
    });

    const text = completion.choices[0]?.message?.content ?? "[]";
    return res.status(200).json({ text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "OpenAIError", detail: String(err) });
  }
}
