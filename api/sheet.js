// api/sheet.js
import * as xlsx from "xlsx";

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
  const { toLang, context, file, fileBase64, data, sheetName } = body;

  const inputData = fileBase64 || file || data;
  if (!inputData) {
    return res.status(400).json({ error: "file is required" });
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

  const buffer = (() => {
    if (Buffer.isBuffer(inputData)) return inputData;
    if (Array.isArray(inputData)) return Buffer.from(inputData);
    if (inputData instanceof ArrayBuffer) return Buffer.from(inputData);
    if (typeof inputData === "string") {
      const base64 = inputData.includes(",") ? inputData.split(",").pop() : inputData;
      return Buffer.from(base64 || "", "base64");
    }
    if (inputData?.data && Array.isArray(inputData.data)) {
      return Buffer.from(inputData.data);
    }
    return null;
  })();

  if (!buffer || buffer.length === 0) {
    return res.status(400).json({ error: "file is invalid" });
  }

  const wbIn = xlsx.read(buffer, { type: "buffer" });
  const targetSheetName = sheetName || wbIn.SheetNames[0];
  if (!targetSheetName) {
    return res.status(400).json({ error: "sheetName is required" });
  }

  const wsIn = wbIn.Sheets[targetSheetName];
  if (!wsIn) {
    return res.status(400).json({ error: "sheet not found" });
  }

  const merges = Array.isArray(wsIn["!merges"]) ? wsIn["!merges"] : [];
  let range = wsIn["!ref"] ? xlsx.utils.decode_range(wsIn["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  merges.forEach((merge) => {
    if (!merge || !merge.s || !merge.e) return;
    if (merge.s.r < range.s.r) range.s.r = merge.s.r;
    if (merge.s.c < range.s.c) range.s.c = merge.s.c;
    if (merge.e.r > range.e.r) range.e.r = merge.e.r;
    if (merge.e.c > range.e.c) range.e.c = merge.e.c;
  });

  const isMergedNonTopLeft = (r, c) => {
    for (let i = 0; i < merges.length; i += 1) {
      const merge = merges[i];
      if (!merge || !merge.s || !merge.e) continue;
      if (r < merge.s.r || r > merge.e.r) continue;
      if (c < merge.s.c || c > merge.e.c) continue;
      if (r === merge.s.r && c === merge.s.c) return false;
      return true;
    }
    return false;
  };

  const aoa = [];
  const translateRows = [];
  const translateTargets = [];

  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const addr = xlsx.utils.encode_cell({ r, c });
      const cell = wsIn[addr];
      const rawValue = cell ? cell.v : null;
      if (isMergedNonTopLeft(r, c)) {
        row.push(null);
        continue;
      }
      row.push(rawValue ?? null);
      if (typeof rawValue === "string") {
        const trimmed = rawValue.trim();
        if (trimmed !== "") {
          translateRows.push(trimmed.replace(/\n/g, "|||"));
          translateTargets.push({ r, c, original: rawValue });
        }
      }
    }
    aoa.push(row);
  }

  const translations = [];
  const BATCH_SIZE = 40;
  for (let i = 0; i < translateRows.length; i += BATCH_SIZE) {
    const batch = translateRows.slice(i, i + BATCH_SIZE);
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
          { role: "user", content: JSON.stringify({ rows: batch }) },
        ],
        response_format: { type: "json_object" },
        reasoning_effort: "none",
        verbosity: "low",
      }),
    });

    const apiData = await apiResponse.json();
    const content = apiData?.choices?.[0]?.message?.content || "{}";

    let parsed = {};
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      return res.status(502).json({
        error: "ParseError",
        detail: "AIのJSONがパースできませんでした",
      });
    }

    const batchTranslations = Array.isArray(parsed.translations) ? parsed.translations : [];
    batch.forEach((src, idx) => {
      const t = batchTranslations[idx];
      translations.push((t === undefined || t === null) ? src : String(t));
    });
  }

  translateTargets.forEach((target, idx) => {
    const translated = (translations[idx] || "").replace(/\|\|\|/g, "\n");
    const rowIndex = target.r - range.s.r;
    const colIndex = target.c - range.s.c;
    if (aoa[rowIndex] && colIndex >= 0) {
      aoa[rowIndex][colIndex] = translated || target.original;
    }
  });

  const wsOut = xlsx.utils.aoa_to_sheet(aoa, { origin: { r: range.s.r, c: range.s.c } });
  wsOut["!merges"] = wsIn["!merges"];

  merges.forEach((merge) => {
    if (!merge || !merge.s || !merge.e) return;
    for (let r = merge.s.r; r <= merge.e.r; r += 1) {
      for (let c = merge.s.c; c <= merge.e.c; c += 1) {
        if (r === merge.s.r && c === merge.s.c) continue;
        const addr = xlsx.utils.encode_cell({ r, c });
        if (wsOut[addr]) {
          delete wsOut[addr];
        }
      }
    }
  });

  let outRange = wsOut["!ref"] ? xlsx.utils.decode_range(wsOut["!ref"]) : range;
  merges.forEach((merge) => {
    if (!merge || !merge.s || !merge.e) return;
    if (merge.s.r < outRange.s.r) outRange.s.r = merge.s.r;
    if (merge.s.c < outRange.s.c) outRange.s.c = merge.s.c;
    if (merge.e.r > outRange.e.r) outRange.e.r = merge.e.r;
    if (merge.e.c > outRange.e.c) outRange.e.c = merge.e.c;
  });
  wsOut["!ref"] = xlsx.utils.encode_range(outRange);

  const wbOut = xlsx.utils.book_new();
  wbIn.SheetNames.forEach((name) => {
    if (name === targetSheetName) {
      xlsx.utils.book_append_sheet(wbOut, wsOut, name);
    } else {
      xlsx.utils.book_append_sheet(wbOut, wbIn.Sheets[name], name);
    }
  });

  const output = xlsx.write(wbOut, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  return res.status(200).send(output);
}
