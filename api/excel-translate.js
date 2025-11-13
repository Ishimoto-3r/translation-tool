// /api/excel-translate.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const { rows, toLang } = req.body || {};
    if (!Array.isArray(rows) || !toLang) {
      res.status(400).json({ error: "invalid payload" });
      return;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      res.status(500).json({ error: "OPENAI_API_KEY is not set" });
      return;
    }

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const systemPrompt =
      `You are a precise translator. Translate each item strictly into ${toLang}.` +
      ` Preserve line breaks as literal \\n.` +
      ` Return ONLY a JSON array of strings with the SAME length and order as input.`;

    // 文字数が多い場合に備えて、300件ずつ分割して逐次呼び出す
    const CHUNK = 300;
    const all = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const body = {
        model,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(chunk) },
        ],
      };

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        // ここで詳細を返す（デバッグしやすい）
        res.status(502).json({ error: "openai_error", detail: text });
        return;
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content?.trim?.() ?? "[]";

      let arr;
      try {
        arr = JSON.parse(content);
      } catch (e) {
        res.status(502).json({ error: "parse_error", raw: content });
        return;
      }

      if (!Array.isArray(arr) || arr.length !== chunk.length) {
        res.status(502).json({
          error: "length_mismatch",
          expected: chunk.length,
          got: Array.isArray(arr) ? arr.length : "not array",
          raw: content,
        });
        return;
      }
      all.push(...arr);
    }

    res.status(200).json({ translations: all });
  } catch (err) {
    // Vercel 側での例外も拾ってメッセージ化
    res.status(500).json({ error: "internal_error", message: String(err?.message || err) });
  }
}
