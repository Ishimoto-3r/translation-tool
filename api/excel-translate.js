// /api/excel-translate.js
// Excel翻訳API（フロントから rows, toLang を受け取り、配列→配列で返す）

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 好きなモデル名に変更可（既存と合わせてください）
const MODEL = process.env.OPENAI_MODEL || "gpt-5"; 
const BATCH_SIZE = 40; // フロントの excel.js と揃える

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { rows, toLang } = req.body || {};

    // 入力チェック
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

    const translations = [];

    // rows を更にサーバー側でもバッチ分割（安全マージン）
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);

      console.log(
        `[excel-translate] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${
          Math.ceil(rows.length / BATCH_SIZE)
        } items ${i}..${i + batch.length - 1}`
      );

      // OpenAI Responses API を使用（配列→配列のJSONを要求）
      const response = await client.responses.create({
        model: MODEL,
        input: [
          {
            role: "system",
            content:
              "You are a professional translation engine. " +
              "You MUST return ONLY a valid JSON array of strings, no extra text. " +
              "The array length MUST be exactly the same as the input array.",
          },
          {
            role: "user",
            content: JSON.stringify({
              target_language: toLang,
              texts: batch,
            }),
          },
        ],
      });

      const raw = response.output_text; // まとめてテキストとして取得（JSON期待）
      if (!raw || typeof raw !== "string") {
        console.error("[excel-translate] Empty or non-string output", raw);
        throw new Error("モデルからの出力が不正です");
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        console.error("[excel-translate] JSON parse error", {
          message: parseErr.message,
          rawPreview: raw.slice(0, 500),
        });
        throw new Error("モデル出力のJSON解析に失敗しました");
      }

      if (!Array.isArray(parsed)) {
        console.error(
          "[excel-translate] Parsed output is not an array",
          parsed
        );
        throw new Error("モデル出力が配列ではありません");
      }

      if (parsed.length !== batch.length) {
        console.error("[excel-translate] Length mismatch in batch", {
          expected: batch.length,
          got: parsed.length,
          batchPreview: batch.slice(0, 3),
          parsedPreview: parsed.slice(0, 3),
        });
        throw new Error("モデル出力の要素数が一致しません");
      }

      translations.push(...parsed);
    }

    if (translations.length !== rows.length) {
      console.error("[excel-translate] Final length mismatch", {
        expected: rows.length,
        got: translations.length,
      });
      return res
        .status(500)
        .json({ error: "内部エラー: translations length mismatch" });
    }

    return res.status(200).json({ translations });
  } catch (err) {
    console.error("[excel-translate] Unexpected error", err);
    // 502 ではなく 500 とメッセージを返すようにする
    return res.status(500).json({
      error: "Translation failed on server",
      detail: err.message || String(err),
    });
  }
}
