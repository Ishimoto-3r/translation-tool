import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const body = req.body || {};
    if (body.mode !== "media-manual") {
      return res.status(400).json({ error: "Unsupported mode" });
    }
    const notes = String(body.notes || "");
    const granularity = String(body.granularity || "standard");

    const sys =
      "あなたは日本語の取扱説明書向け原稿の作成者です。\n" +
      "文体はです・ます調で統一してください。\n\n" +
      "【絶対条件】\n" +
      "- 推測で断定しない\n" +
      "- 過剰な注意・免責を書かない\n\n" +
      "【粒度】\n" +
      "- simple: 要点のみ\n" +
      "- standard: 通常\n" +
      "- detailed: 丁寧\n\n" +
      "【出力形式】\n" +
      "1行目に必ずタイトル（例：■ 電池の交換）\n" +
      "以降は番号付き手順。必要に応じて確認事項。";

    const user =
      (notes ? `備考: ${notes}\n` : "") +
      `粒度: ${granularity}\n`;

    const r = await client.responses.create({
      model: "gpt-5.2",
      input: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ],
      max_output_tokens: 700
    });

    const text = r.output_text || "";
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: "Failed", detail: String(e) });
  }
}
