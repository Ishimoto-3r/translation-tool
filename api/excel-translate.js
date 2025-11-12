// /api/excel-translate.js
import OpenAI from "openai";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  try {
    const { rows, toLang } = req.body || {};
    if (!Array.isArray(rows) || !toLang) return res.status(400).json({ error: "invalid payload" });

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const sys = `You are a precise translator. Translate each item strictly into ${toLang}. Preserve line breaks as literal \\n. Return ONLY a JSON array of strings with the SAME length/order.`;
    const resp = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: JSON.stringify(rows) }
      ]
    });

    const text = resp.choices?.[0]?.message?.content?.trim?.() || "[]";
    let translations = [];
    try { translations = JSON.parse(text); } catch { translations = []; }
    if (!Array.isArray(translations) || translations.length !== rows.length) {
      translations = rows.map(x => (x ?? "")); // フォールバック
    }
    return res.status(200).json({ translations });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "internal error" });
  }
}
