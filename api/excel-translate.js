// /api/excel-translate.js
// Excel翻訳API：rows(string[]) を受け取り、同じ長さの translations(string[]) を返す（CommonJS版）

const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Vercel の環境変数に OPENAI_MODEL があればそれを使用。
// なければ gpt-4o-mini を使う。
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { rows, toLang } = req.body || {};

    // 入力バリデーション
    if (!Array.isArray(rows) || rows.length === 0) {
      return res
        .status(400)
        .json({ error: "rows は1件以上の文字列配列である必要があります" });
    }
    if (typeof toLang !== "string" || !toLang.trim()) {
      return res
        .status(400)
        .json({ error: "toLang は翻訳先言語コードの文字列である必要があります" });
    }

    console.log(
      `[excel-translate] request: rows=${rows.length}, toLang=${toLang}`
    );

    // モデルへの指示：JSON配列だけ返す
    const systemPrompt =
      "You are a professional translation engine. " +
      "You receive a JSON object like {\"target_language\":\"ja\",\"texts\":[\"...\"]}. " +
      "You MUST respond with ONLY a valid JSON array of translated strings, nothing else. " +
      "The array length MUST be exactly the same as the input 'texts' array. " +
      "Do not add explanations or additional keys.";

    const userPayload = {
      target_language: toLang,
      texts: rows,
    };

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      temperature: 0.1,
    });

    const raw = completion.choices?.[0]?.message?.content?.trim();
    if (!raw) {
      console.error("[excel-translate] empty content:", completion);
      throw new Error("モデルからの出力が空でした");
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("[excel-translate] JSON parse error", {
        message: e.message,
        rawPreview: raw.slice(0, 500),
      });
      throw new Error("モデル出力のJSON解析に失敗しました");
    }

    if (!Array.isArray(parsed)) {
      console.error("[excel-translate] parsed is not array:", parsed);
      throw new Error("モデル出力が配列ではありません");
    }

    if (parsed.length !== rows.length) {
      console.error("[excel-translate] length mismatch", {
        expected: rows.length,
        got: parsed.length,
        inputPreview: rows.slice(0, 3),
        outputPreview: parsed.slice(0, 3),
      });
      throw new Error("モデル出力の要素数が入力と一致しません");
    }

    console.log("[excel-translate] success");
    return res.status(200).json({ translations: parsed });
  } catch (err) {
    console.error("[excel-translate] Unexpected error", err);
    return res.status(500).json({
      error: "Translation failed on server",
      detail: err.message || String(err),
    });
  }
};
