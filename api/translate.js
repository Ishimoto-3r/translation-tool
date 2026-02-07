// api/translate.js (CommonJS)
const logger = require("./utils/logger");
const openaiClient = require("./utils/openai-client");
const { handleCorsPreFlight, setCorsHeaders } = require("./utils/api-helpers");

// 依存関係コンテナ（テスト時にモックと差し替え可能にするため）
const deps = {
  logger,
  openaiClient
};

async function handler(req, res) {
  // CORS preflight処理
  if (handleCorsPreFlight(req, res)) {
    return;
  }

  // レスポンスにCORSヘッダーを設定
  setCorsHeaders(res);



  const op = (req.query?.op ? String(req.query.op) : "").trim() || "text";
  deps.logger.info("translate", `Request received with op: ${op}`);

  try {
    if (op === "text") {
      return await handleTextTranslate(req, res);
    }
    if (["sheet", "word", "verify"].includes(op)) {
      return await handleRowsTranslate(req, res, op);
    }

    deps.logger.warn("translate", `Unknown op: ${op}`);
    return res.status(400).json({
      error: "UnknownOp",
      detail: `Unknown op: ${op}`,
    });
  } catch (e) {
    deps.logger.error("translate", "Unexpected error", { error: e.message });
    return res.status(500).json({
      error: "Internal Server Error",
      detail: String(e?.message || e),
    });
  }
}

// ------------------------------------------------------------
// op=text
// ------------------------------------------------------------
async function handleTextTranslate(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { systemPrompt, userPrompt, sourceLang, targetLang } = body;

  if (!userPrompt) {
    return res.status(400).json({ error: "userPrompt is required" });
  }

  const guessedTarget = targetLang || (() => {
    const sp = String(systemPrompt || "");
    if (sp.includes("中国語")) return "zh";
    if (sp.includes("英語")) return "en";
    if (sp.includes("韓国語")) return "ko";
    if (sp.includes("日本語")) return "ja";
    return "";
  })();

  const baseSystem = String(systemPrompt || "").trim() || "あなたはプロの翻訳者です。";
  const jsonGuard = `
重要：出力は必ずJSON（json_object）のみで返してください。
出力例：
{ "translatedText": "..." }
`;

  try {
    const response = await deps.openaiClient.chatCompletion({
      messages: [
        { role: "system", content: baseSystem + "\n" + jsonGuard },
        {
          role: "user",
          content: JSON.stringify({
            sourceLang: sourceLang || "",
            targetLang: guessedTarget || "",
            text: String(userPrompt || ""),
          }),
        },
      ],
      jsonMode: true
    });

    const content = response.choices?.[0]?.message?.content || "{}";
    let obj = {};
    try {
      obj = JSON.parse(content);
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

  } catch (err) {
    if (err.message === "OPENAI_API_KEY_MISSING") {
      return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    }
    throw err;
  }
}

// ------------------------------------------------------------
// op=sheet/word/verify (rows translate)
// ------------------------------------------------------------
async function handleRowsTranslate(req, res, kind) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { rows, toLang, context } = body;

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

  let systemPrompt = "";
  // kind別のプロンプト構築（既存ロジック維持）
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

  try {
    const response = await deps.openaiClient.chatCompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ rows }) },
      ],
      jsonMode: true
    });

    const content = response.choices?.[0]?.message?.content || "{}";
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
    const fixed = rows.map((src, i) => {
      const t = translations[i];
      return (t === undefined || t === null) ? src : String(t);
    });

    const padded = Math.max(0, rows.length - translations.length);
    parsed.translations = fixed;
    parsed.meta = { ...(parsed.meta || {}), padded };

    if (padded > 0) {
      deps.logger.warn(`translate:${kind}`, `padded ${padded} item(s) to match rows length.`);
    }

    return res.status(200).json(parsed);

  } catch (err) {
    if (err.message === "OPENAI_API_KEY_MISSING") {
      return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    }
    throw err;
  }
}

module.exports = handler;
module.exports._deps = deps;
