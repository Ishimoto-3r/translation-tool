// api/sheet.js

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
  }

  const MODEL_TRANSLATE = process.env.MODEL_TRANSLATE || "gpt-5.1";

  const body =
    typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { rows, toLang, context, merges, cellRefs } = body;

  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "rows is required" });
  }
  if (!toLang) {
    return res.status(400).json({ error: "toLang is required" });
  }

  let contextPrompt = "";
  if (context && String(context).trim() !== "") {
    contextPrompt = `
【追加指示（コンテキスト）】
ユーザーからの指示: "${String(context)}"
この指示に従って翻訳のトーンや用語選択を行ってください。
`;
  }

  const systemPrompt = `
あなたはプロの翻訳者です。
入力された配列を "${toLang}" に翻訳し、JSON形式で返してください。

${contextPrompt}

【重要ルール】
- 数値のみ、または製品型番のようなアルファベット記号（例: ODM, USB-C, V1.0）は翻訳せず、そのまま出力してください。
- 翻訳不要と判断した場合は、原文をそのまま返してください。

【翻訳の必須ルール】
- 原文の言語が "${toLang}" と異なる場合、必ず翻訳してください。
- 「意味が通じる」「専門用語だから」などの理由で原文を残すことは禁止です。

【翻訳不要として原文を維持してよい条件（全言語共通）】
- 数値のみ（例: 12.5, 2024）
- 型番・記号・コード（例: USB-C, ODM, ABC-123）
- 空文字・記号のみ
- 注意：中国語（簡体字/繁体字）は日本語ではありません。漢字が含まれていても、中国語なら必ず "${toLang}" に翻訳してください。

出力フォーマット:
{ "translations": ["翻訳1", "翻訳2"] }
`;

  const skippedIndexes = new Set();
  if (Array.isArray(merges) && Array.isArray(cellRefs) && cellRefs.length === rows.length) {
    const cellIndexMap = new Map();
    cellRefs.forEach((ref, idx) => {
      if (!ref) return;
      const row = Number(ref.r ?? ref.row ?? ref[0]);
      const col = Number(ref.c ?? ref.col ?? ref[1]);
      if (Number.isFinite(row) && Number.isFinite(col)) {
        cellIndexMap.set(`${row}:${col}`, idx);
      }
    });

    const markMergedRange = (top, left, bottom, right) => {
      const t = Number(top);
      const l = Number(left);
      const b = Number(bottom);
      const r = Number(right);
      if (![t, l, b, r].every((n) => Number.isFinite(n))) return;
      for (let row = t; row <= b; row += 1) {
        for (let col = l; col <= r; col += 1) {
          if (row === t && col === l) continue;
          const idx = cellIndexMap.get(`${row}:${col}`);
          if (idx !== undefined) skippedIndexes.add(idx);
        }
      }
    };

    merges.forEach((merge) => {
      if (!merge) return;
      if (typeof merge === "string") {
        const match = merge.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
        if (match) {
          const colToNumber = (col) =>
            col.toUpperCase().split("").reduce((sum, ch) => sum * 26 + (ch.charCodeAt(0) - 64), 0);
          const top = Number(match[2]);
          const left = colToNumber(match[1]);
          const bottom = Number(match[4]);
          const right = colToNumber(match[3]);
          markMergedRange(top, left, bottom, right);
        }
        return;
      }
      if (merge.s && merge.e) {
        markMergedRange(merge.s.r, merge.s.c, merge.e.r, merge.e.c);
        return;
      }
      if (merge.start && merge.end) {
        markMergedRange(merge.start.r, merge.start.c, merge.end.r, merge.end.c);
        return;
      }
      if (merge.top !== undefined) {
        markMergedRange(merge.top, merge.left, merge.bottom, merge.right);
      }
    });
  }

  const rowsToTranslate = [];
  const translateIndexMap = new Map();
  rows.forEach((row, idx) => {
    if (skippedIndexes.has(idx)) return;
    translateIndexMap.set(idx, rowsToTranslate.length);
    rowsToTranslate.push(row);
  });

  const apiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL_TRANSLATE,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ rows: rowsToTranslate }) },
      ],
      response_format: { type: "json_object" },
      reasoning_effort: "none",
      verbosity: "low",
    }),
  });

  const data = await apiResponse.json();
  const content = data?.choices?.[0]?.message?.content || "{}";

  let parsed = {};
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return res.status(502).json({
      error: "ParseError",
      detail: "AIのJSONがパースできませんでした",
    });
  }

  const translations = Array.isArray(parsed.translations) ? parsed.translations : [];
  const fixed = rows.map((src, idx) => {
    if (skippedIndexes.has(idx)) return "";
    const mappedIndex = translateIndexMap.get(idx);
    const t = mappedIndex === undefined ? undefined : translations[mappedIndex];
    return (t === undefined || t === null) ? src : String(t);
  });

  const padded = Math.max(0, rowsToTranslate.length - translations.length);

  parsed.translations = fixed;
  parsed.meta = { ...(parsed.meta || {}), padded, mergesProvided: Array.isArray(merges) };

  if (padded > 0) {
    console.warn(`[sheet] padded ${padded} item(s) to match rows length.`);
  }

  if (Array.isArray(merges)) {
    parsed.merges = merges;
  }

  return res.status(200).json(parsed);
}
