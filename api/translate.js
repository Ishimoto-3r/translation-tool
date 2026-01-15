// api/translate.js

export default async function handler(req, res) {
  // 1) CORS/OPTIONS（既存sheet/word/verifyと同等にする）
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

  // 2) op判定（無指定は従来どおり text として扱う）
  const op = (req.query?.op ? String(req.query.op) : "").trim() || "text";

  try {
    if (op === "text") {
      return await handleTextTranslate(req, res); // 旧 /api/translate 互換
    }

    if (op === "sheet") {
      return await handleRowsTranslate(req, res, "sheet"); // 旧 /api/sheet 互換
    }

    if (op === "word") {
      return await handleRowsTranslate(req, res, "word"); // 旧 /api/word 互換
    }

    if (op === "verify") {
      return await handleRowsTranslate(req, res, "verify"); // 旧 /api/verify 互換
    }

    return res.status(400).json({
      error: "UnknownOp",
      detail: `Unknown op: ${op}`,
    });
  } catch (e) {
    console.error("[translate] unexpected error:", e);
    return res.status(500).json({
      error: "Internal Server Error",
      detail: String(e?.message || e),
    });
  }
}

// ------------------------------------------------------------
// 旧 api/translate.js の挙動（text翻訳）をそのまま維持
// ------------------------------------------------------------
async function handleTextTranslate(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const body =
    typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { systemPrompt, userPrompt, sourceLang, targetLang } = body;

  if (!userPrompt) {
    return res.status(400).json({ error: "userPrompt is required" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
  }

  // --- targetLang を確定（フロントから渡されるのが理想。無い場合は systemPrompt から推定） ---
  const guessedTarget =
    targetLang ||
    (() => {
      const sp = String(systemPrompt || "");
      if (sp.includes("中国語")) return "zh";
      if (sp.includes("英語")) return "en";
      if (sp.includes("韓国語")) return "ko";
      if (sp.includes("日本語")) return "ja";
      return "";
    })();

  const model = process.env.MODEL_TRANSLATE || "gpt-5.1";

  // systemPrompt は既存ツール側のものを尊重しつつ、JSON返却を強制
  const baseSystem = String(systemPrompt || "").trim() || "あなたはプロの翻訳者です。";
  const jsonGuard = `
重要：出力は必ずJSON（json_object）のみで返してください。
出力例：
{ "translatedText": "..." }
`;

  const messages = [
    { role: "system", content: baseSystem + "\n" + jsonGuard },
    {
      role: "user",
      content: JSON.stringify({
        sourceLang: sourceLang || "",
        targetLang: guessedTarget || "",
        text: String(userPrompt || ""),
      }),
    },
  ];

  const apiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      reasoning_effort: "none",
      verbosity: "low",
    }),
  });

  const data = await apiResponse.json();

  // contentがJSONで来る前提
  let obj = {};
  try {
    obj = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    obj = {};
  }

  const translatedText = (obj.translatedText || obj.text || obj.ja || "").toString().trim();

  if (!translatedText) {
    return res.status(502).json({
      error: "TranslationFailed",
      detail: "翻訳結果が空でした",
    });
  }

  return res.status(200).json({ translatedText });
}

// ------------------------------------------------------------
// 旧 api/sheet.js / api/word.js / api/verify.js の挙動（rows翻訳）
// 返却：{ "translations": ["...", "..."] }
// ------------------------------------------------------------
async function handleRowsTranslate(req, res, kind) {
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
  const { rows, toLang, context } = body;

  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "rows is required" });
  }
  if (!toLang) {
    return res.status(400).json({ error: "toLang is required" });
  }

  // 追加指示（コンテキスト）
  let contextPrompt = "";
  if (context && String(context).trim() !== "") {
    contextPrompt = `
【追加指示（コンテキスト）】
ユーザーからの指示: "${String(context)}"
この指示に従って翻訳のトーンや用語選択を行ってください。
`;
  }

  // kind別のプロンプト（既存の意図を崩さない）
  let systemPrompt = "";

  if (kind === "word") {
    systemPrompt = `
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
- 数値のみ
- 型番・記号・コード
- すでに翻訳先言語で書かれている文章
- 空文字

【その他のルール】
- これはWordファイル内のテキストです。文脈を維持してください。
- 数値、型番、固有の記号などはそのまま維持してください。

出力フォーマット:
{ "translations": ["翻訳1", "翻訳2", ...] }
`;
  } else {
    // sheet / verify
    systemPrompt = `
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
  }

  // OpenAIへ（既存sheet/word/verifyと同等の形式）
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
        { role: "user", content: JSON.stringify({ rows }) },
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

  // --- 行数保証（UIの整合性エラー対策）---
  const translations = Array.isArray(parsed.translations) ? parsed.translations : [];

  // rows と translations を index対応で揃える（不足は原文で埋める）
  const fixed = rows.map((src, i) => {
    const t = translations[i];
    return (t === undefined || t === null) ? src : String(t);
  });

  const padded = Math.max(0, rows.length - translations.length);

  // meta は互換を壊さない（UIが無視してもOK）
  parsed.translations = fixed;
  parsed.meta = { ...(parsed.meta || {}), padded };

  if (padded > 0) {
    console.warn(`[translate:${kind}] padded ${padded} item(s) to match rows length.`);
  }

  return res.status(200).json(parsed);

}

