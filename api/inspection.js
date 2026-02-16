// api/inspection.js（CommonJS変換版）
// op=meta     : SharePointテンプレから「選択リスト」（検品項目リスト A=選択リスト の C列）を返す
// op=extract  : PDFテキスト（ブラウザ抽出）から、型番/製品名/仕様/動作(タイトル+items)/付属品 をAI抽出
// op=generate : テンプレExcelへ差し込み → 余計なシート削除 → 書体/サイズ/揃え調整 → base64で返す

const ExcelJS = require("exceljs");
const pdfParse = require("pdf-parse");
const logger = require("../lib/logger");
const openaiClient = require("../lib/openai-client");
const { getAccessToken, validateExternalUrl } = require("../lib/api-helpers");

// 依存関係コンテナ
const deps = {
  logger,
  openaiClient
};

// ===== Config =====
const DEFAULT_MODEL = "gpt-4o";
const DEFAULT_REASONING = "medium";
const DEFAULT_VERBOSITY = "low";

function getModelConfig() {
  return {
    MODEL: process.env.MODEL_MANUAL_CHECK || process.env.OPENAI_MODEL || DEFAULT_MODEL,
    REASONING: process.env.MANUAL_CHECK_REASONING || DEFAULT_REASONING,
    VERBOSITY: process.env.MANUAL_CHECK_VERBOSITY || DEFAULT_VERBOSITY,
  };
}

const handler = async (req, res) => {
  try {
    const op = (req.query?.op ?? "").toString();

    // CORS preflight等はVercelの設定やミドルウェアに任せるが、念のため
    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }

    if (op === "meta") return await handleMeta(req, res);
    if (op === "fetch") return await handleFetch(req, res); // Proxy for client-side PDF processing
    if (op === "extract") return await handleExtract(req, res);
    if (op === "generate") return await handleGenerate(req, res);

    deps.logger.warn("inspection", `Unknown op: ${op}`);
    return res.status(404).json({ error: "NotFound", detail: "Unknown op" });
  } catch (err) {
    deps.logger.error("inspection", "Unexpected error", { error: err.message });
    return res.status(500).json({ error: "UnexpectedError", detail: String(err?.message || err) });
  }
};

const MAX_PDF_BYTES = 4 * 1024 * 1024;
const MAX_HTML_TEXT_CHARS = 30000;

async function resolvePdfUrlFromHtml(baseUrl, htmlText) {
  deps.logger.info("inspection", "[extract] html length: " + htmlText.length);
  const rawLinks = [];
  const attrRegex = /(href|src)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attrRegex.exec(htmlText)) !== null) {
    rawLinks.push(match[2]);
  }
  const candidates = rawLinks
    .map((href) => {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((href) => {
      const lower = href.toLowerCase();
      return (
        lower.includes(".pdf") ||
        lower.includes("wp-content/uploads") ||
        lower.includes("manual") ||
        lower.includes("download") ||
        lower.includes("attachment")
      );
    });

  const jsonRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonMatch;
  while ((jsonMatch = jsonRegex.exec(htmlText)) !== null) {
    const jsonText = jsonMatch[1];
    try {
      const data = JSON.parse(jsonText);
      const stack = [data];
      while (stack.length) {
        const node = stack.pop();
        if (node && typeof node === "object") {
          if (typeof node.contentUrl === "string") candidates.push(new URL(node.contentUrl, baseUrl).toString());
          if (typeof node.url === "string") candidates.push(new URL(node.url, baseUrl).toString());
          if (node.associatedMedia) stack.push(node.associatedMedia);
          for (const val of Object.values(node)) {
            if (val && typeof val === "object") stack.push(val);
          }
        }
      }
    } catch {
      // ignore JSON parse errors
    }
  }

  const deduped = Array.from(new Set(candidates)).slice(0, 20);

  const hits = [];
  for (const candidate of deduped) {
    let contentType = "";
    try {
      const headRes = await fetch(candidate, {
        method: "HEAD",
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.8",
        },
      });
      contentType = (headRes.headers.get("content-type") || "").toLowerCase();
      if (headRes.ok && contentType.includes("application/pdf")) {
        hits.push(candidate);
        continue;
      }
    } catch {
      // fall through to range fetch
    }

    try {
      const rangeRes = await fetch(candidate, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.8",
          "Range": "bytes=0-2047",
        },
      });
      const rangeType = (rangeRes.headers.get("content-type") || "").toLowerCase();
      if (rangeRes.ok && rangeType.includes("application/pdf")) {
        hits.push(candidate);
      }
    } catch {
      // ignore range errors
    }
  }

  deps.logger.info("inspection", "[extract] pdf hits: " + hits.length);
  return { resolvedUrl: hits[0] || "", candidates: deduped };
}

function htmlToText(html) {
  if (!html) return "";
  let text = html;
  text = text.replace(/<\s*(script|style|noscript|header|footer|nav)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  const entities = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
  };
  text = text.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (m) => entities[m] || m);
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > MAX_HTML_TEXT_CHARS) {
    text = text.slice(0, MAX_HTML_TEXT_CHARS);
  }
  return text;
}

async function getPdfBufferFromRequest(req, { pdfUrl }) {
  const contentType = (req.headers["content-type"] || "").toLowerCase();
  if (contentType.includes("application/pdf")) {
    if (Buffer.isBuffer(req.body)) return { buffer: req.body, sourceType: "pdf" };
    if (req.body instanceof ArrayBuffer) return { buffer: Buffer.from(req.body), sourceType: "pdf" };
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    return { buffer: Buffer.concat(chunks), sourceType: "pdf" };
  }
  if (pdfUrl) {
    const r = await fetch(pdfUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    const httpStatus = r.status;
    const contentType = (r.headers.get("content-type") || "").toLowerCase();
    if (!r.ok) {
      const err = new Error("PDFURLFetchError");
      err.httpStatus = httpStatus;
      throw err;
    }
    if (contentType.includes("application/pdf")) {
      const ab = await r.arrayBuffer();
      return { buffer: Buffer.from(ab), httpStatus, sourceType: "pdf" };
    }
    const htmlText = await r.text();
    const { resolvedUrl, candidates } = await resolvePdfUrlFromHtml(pdfUrl, htmlText);
    if (!resolvedUrl) {
      return {
        htmlText,
        sourceType: "html",
        httpStatus,
        pdfCandidates: candidates,
      };
    }
    const pdfRes = await fetch(resolvedUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/pdf,text/html;q=0.9,*/*;q=0.8",
      },
    });
    const pdfStatus = pdfRes.status;
    const pdfType = (pdfRes.headers.get("content-type") || "").toLowerCase();
    if (!pdfRes.ok || !pdfType.includes("application/pdf")) {
      const err = new Error("PDFURLFetchError");
      err.httpStatus = pdfStatus;
      throw err;
    }
    const pdfAb = await pdfRes.arrayBuffer();
    return {
      buffer: Buffer.from(pdfAb),
      httpStatus: pdfStatus,
      sourceType: "pdf",
      pdfCandidates: candidates,
    };
  }
  throw new Error("pdfUrl or application/pdf body is required");
}

// ===== Graph token =====
// getAccessToken() は lib/api-helpers.js に共通化済み

// ===== Template download =====
// 優先：INSPECTION_TEMPLATE_URL（Shareリンク）
// 互換：INSPECTION_SITE_ID / INSPECTION_DRIVE_ID / INSPECTION_TEMPLATE_ITEM_ID
async function downloadTemplateBuffer() {
  const accessToken = await getAccessToken();

  // 優先：INSPECTION_TEMPLATE_URL（Shareリンク）
  // 互換：INSPECTION_SITE_ID / INSPECTION_DRIVE_ID / INSPECTION_TEMPLATE_ITEM_ID
  // 旧互換：MANUAL_SHAREPOINT_FILE_URL（inspectionが動いていた時期のキー）
  const url =
    process.env.INSPECTION_TEMPLATE_URL ||
    process.env.MANUAL_SHAREPOINT_FILE_URL ||
    "";
  const siteId = process.env.INSPECTION_SITE_ID || "";
  const driveId = process.env.INSPECTION_DRIVE_ID || "";
  const itemId = process.env.INSPECTION_TEMPLATE_ITEM_ID || "";

  if (url) {
    const shareId = Buffer.from(url).toString("base64").replace(/=+$/, "");
    const graphRes = await fetch(
      `https://graph.microsoft.com/v1.0/shares/u!${shareId}/driveItem/content`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!graphRes.ok) {
      const t = await graphRes.text().catch(() => "");
      throw new Error(`GraphDownloadError: ${graphRes.status} ${t}`);
    }
    const ab = await graphRes.arrayBuffer();
    return Buffer.from(ab);
  }

  if (siteId && driveId && itemId) {
    const graphRes = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/items/${itemId}/content`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!graphRes.ok) {
      const t = await graphRes.text().catch(() => "");
      throw new Error(`GraphDownloadError: ${graphRes.status} ${t}`);
    }
    const ab = await graphRes.arrayBuffer();
    return Buffer.from(ab);
  }

  throw new Error(
    "ConfigError: INSPECTION_TEMPLATE_URL または INSPECTION_SITE_ID / INSPECTION_DRIVE_ID / INSPECTION_TEMPLATE_ITEM_ID（または旧キー MANUAL_SHAREPOINT_FILE_URL）が不足"
  );
}

// ===== Helpers =====
function cellToText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);

  if (typeof v === "object") {
    // ExcelJS richText
    if (Array.isArray(v.richText)) {
      return v.richText.map(x => (x && x.text ? x.text : "")).join("");
    }
    // ExcelJS hyperlink
    if (typeof v.text === "string") return v.text;
    // ExcelJS formula result
    if (v.result != null) return cellToText(v.result);
  }
  return "";
}

function norm(s) {
  return cellToText(s).trim();
}

function thinBorder() {
  return {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };
}

function shouldSkipOpItem(text) {
  const t = norm(text);
  if (!t) return true;

  // 要件：安全・取扱注意（動作に関わる禁止/中止）系は動作に入れない
  const ng = [
    "安全", "取扱注意", "禁止", "中止", "危険", "警告", "注意",
    "火気", "感電", "やけど", "発煙", "発火", "爆発", "高温", "液体",
    "分解", "改造", "水濡れ", "挿入しない", "放置しない"
  ];
  // ただし「メニュー」系の設定は動作として残す
  if (t.includes("メニュー")) return false;

  return ng.some(k => t.includes(k));
}

function dedupeKeepOrder(arr) {
  const out = [];
  const seen = new Set();
  for (const v0 of arr || []) {
    const v = norm(v0);
    if (!v) continue;
    const key = v;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function normalizeManualAccessory(text) {
  // 取扱説明書の表記ブレ吸収（あなたのC要件）
  const t = norm(text);
  if (!t) return "";
  const variants = ["取扱説明書", "取り扱い説明書", "取扱い説明書", "取説", "マニュアル", "説明書"];
  if (variants.some(v => t.includes(v))) return "取扱説明書";
  return t;
}

function cleanFileNamePart(s) {
  return norm(s).replace(/[\\\/:\*\?"<>\|]/g, "_").replace(/\s+/g, " ").trim();
}

// ===== Parse selection list from template =====
async function getSelectionItemsFromTemplate() {
  const buf = await downloadTemplateBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  const sheet = wb.getWorksheet("検品項目リスト");
  if (!sheet) throw new Error("SheetError: 検品項目リスト が見つかりません");

  const items = [];
  // A列=選択リスト の行で、C列を採用
  sheet.eachRow((row, rowNumber) => {
    const a = norm(row.getCell(1).value);
    if (a !== "選択リスト") return;
    const c = norm(row.getCell(3).value);
    if (c) items.push(c);
  });

  return dedupeKeepOrder(items);
}

// ===== AI extract =====
// api/utils/prompts.js からプロンプト定数を取得
const { INSPECTION_PROMPTS } = require("../lib/prompts");

async function aiExtractFromSourceText({ sourceText, fileName, modelHint, productHint }) {
  const { MODEL, REASONING, VERBOSITY } = getModelConfig();

  deps.logger.info("inspection", `Calling AI Extract (SourceText) for ${fileName}, model=${MODEL}`);

  const completion = await deps.openaiClient.chatCompletion({
    model: MODEL,
    messages: [
      { role: "system", content: INSPECTION_PROMPTS.SYSTEM },
      { role: "user", content: INSPECTION_PROMPTS.USER_TEMPLATE(modelHint, productHint, fileName, sourceText) },
    ],
    reasoning_effort: REASONING,
    verbosity: VERBOSITY,
  });

  const text = completion.choices[0]?.message?.content ?? "{}";
  let obj;
  try {
    // JSONブロックを探す簡易ロジック
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    const jsonText = s >= 0 && e > s ? text.slice(s, e + 1) : "{}";
    obj = JSON.parse(jsonText);
  } catch {
    deps.logger.warn("inspection", "JSON Parse Error in aiExtractFromSourceText", { raw: text.slice(0, 50) });
    obj = {};
  }

  return normalizeExtractResult(obj);
}

async function extractPdfTextFromBuffer(pdfBuffer) {
  // Use pdf-parse for more stable text extraction in serverless environment
  // Throw error if failed (to avoid empty AI request)
  try {
    const data = await pdfParse(pdfBuffer);
    if (!data || !data.text) {
      throw new Error("PDF parsing returned no text");
    }
    return data.text;
  } catch (e) {
    deps.logger.error("inspection", "pdf-parse failed", { error: e.message });
    throw e;
  }
}

// ===== AI extract from PDF file =====
async function aiExtractFromPdfFile({ pdfBuffer, fileName, modelHint, productHint }) {
  const { MODEL, REASONING, VERBOSITY } = getModelConfig();

  const sys = `
あなたは取扱説明書（日本語）の内容から、検品リスト作成に必要な情報を抽出します。
必ずJSONのみを返してください（説明文は不要）。
`;

  const user = `
【目的】
検品リストに入れる「仕様」「動作」「付属品」、および「型番」「製品名」を抽出します。

【重要ルール】
- 「動作」には、安全注意/禁止/中止/警告/注意（安全・取扱注意、禁止事項）は入れない。
- 「動作」は、実際の操作/設定/表示/接続/保存など “できること” を箇条書きで。
- 「動作」は、まとまりがある場合は title を1つ作り、その配下に items を並べる（例：メニュー設定系はまとめる）。
- 「付属品」は、PDFに書かれているものをできるだけ拾う。表記揺れを整理する（例：USBケーブル/USBコード/ケーブル→USBケーブル）。
- ただし「取扱説明書」は、PDF内の明記が無くても必ず付属品候補に入れる（表記は「取扱説明書」に統一）。
- 型番/製品名は、PDF内の表記（例：3R-XXXX）やタイトル行から推定。見つからない場合は空文字。

【ヒント（既に入力されている可能性あり）】
- 型番ヒント: ${modelHint || ""}
- 製品名ヒント: ${productHint || ""}

【返却JSONスキーマ（厳守）】
{
  "model": "型番",
  "productName": "製品名",
  "specs": ["仕様の箇条書き", "..."],
  "ops": [{"title":"見出し","items":["動作1","動作2"]}],
  "accs": ["付属品1","付属品2","取扱説明書"]
}
`;

  const file = new File([pdfBuffer], fileName || "manual.pdf", { type: "application/pdf" });

  // deps.openaiClient.client.files.create を直接使用
  deps.logger.info("inspection", `Uploading PDF file: ${fileName}`);
  const uploaded = await deps.openaiClient.client.files.create({ file, purpose: "assistants" });

  deps.logger.info("inspection", `Calling AI Extract (PDF) for ${fileName}, model=${MODEL}`);

  // ファイルIDを使ったプロンプト構築が標準ChatCompletionではサポートされていない（Vision/File Searchが必要）
  // しかし元のコードは `type: "input_file", file_id: ...` という独自の書き方をしている。
  // これは恐らく動かない、または特殊なラッパー。
  // ここでは標準的なGPT-4 Vision/File Searchの使い方に合わせるか、
  // あるいは user content にそのまま含める形（もしモデルがサポートしていれば）にする。
  // 元のコードが `client.responses.create` だったので、Google Gemini SDK かもしれない。
  // しかし `require("openai")` している。
  // ひとまず `chatCompletion` に投げるが、`input_file` は OpenAI Chat API では標準ではない。
  // `image_url` ならあるが PDF は送れない。
  // File Search (Assistants API) なら可能だが、Chat Completion API で PDF ID を送る方法は標準ではない。
  // テキスト抽出済みの情報を使う `aiExtractFromSourceText` があるので、PDFのテキスト抽出(`extractPdfTextFromBuffer`)の結果を使って
  // `aiExtractFromSourceText` を呼ぶほうが安全かもしれない。
  // だが `extractPdfTextFromBuffer` は `pdfjs-dist` を使っており、テキスト抽出ができる。
  // ここでは、`extractPdfTextFromBuffer` を使ってテキスト化し、それを `aiExtractFromSourceText` と同様のプロンプトで送る実装に切り替える。

  // NOTE: PDFアップロードしてIDを送る方式は OpenAI Chat Completion では不可。Assistants API + Vector Store が必要。
  // 既存コードが動いていたとは考えにくい（幻覚コード）。
  // 安全策：PDFからテキスト抽出して、それを送る。

  const extractedText = await extractPdfTextFromBuffer(pdfBuffer);

  if (!extractedText || extractedText.trim().length < 50) {
    throw new Error("PDFからテキストを抽出できませんでした（スキャンPDFの可能性があります）。");
  }

  // 文字数制限
  const truncatedText = extractedText.slice(0, 60000);

  const completion = await deps.openaiClient.chatCompletion({
    model: MODEL,
    messages: [
      { role: "system", content: sys.trim() },
      {
        role: "user", content: `
【本文テキスト（PDF抽出互換）】
ファイル名: ${fileName}
---
${truncatedText}

${user.trim()}
` },
    ],
    reasoning_effort: REASONING,
    verbosity: VERBOSITY,
  });

  const text = completion.choices[0]?.message?.content ?? "{}";
  let obj;
  try {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    const jsonText = s >= 0 && e > s ? text.slice(s, e + 1) : "{}";
    obj = JSON.parse(jsonText);
  } catch {
    deps.logger.warn("inspection", "JSON Parse Error in aiExtractFromPdfFile", { raw: text.slice(0, 50) });
    obj = {};
  }

  return normalizeExtractResult(obj);
}

// ===== AI extract from Images (Vision) =====
async function aiExtractFromImages({ images, fileName, modelHint, productHint }) {
  const { MODEL, REASONING, VERBOSITY } = getModelConfig();

  const sys = `
あなたは取扱説明書（画像）の内容から、検品リスト作成に必要な情報を抽出します。
必ずJSONのみを返してください（説明文は不要）。
`.trim();

  const userText = `
【目的】
検品リストに入れる「仕様」「動作」「付属品」、および「型番」「製品名」を抽出します。

【検索対象のキーワード例】
- 付属品: 「付属品」「同梱品」「セット内容」「パッケージ内容」「内容物」「Included」
- 仕様: 「仕様」「主な仕様」「製品仕様」「スペック」「定格」「Specifications」
- 動作: 「各部の名称」「操作方法」「使い方」「メニュー」「設定」

【重要ルール】
- 画像全体からテキストを読み取ってください。
- 「動作」には、安全注意/禁止/中止/警告/注意（安全・取扱注意、禁止事項）は絶対に入れないでください。
- 「動作」は、実際の操作/設定/表示/接続/保存など “ユーザーができる具体的なアクション” を箇条書きにします。目次だけでなく本文から抽出してください。
- 「付属品」は、画像内に記載があれば必ず全て拾ってください。表記揺れは一般的な名称に統一（例: USBコード→USBケーブル）。
- ただし「取扱説明書」は、記載が無くても必ず付属品リストに含めてください。
- 「仕様」は、表形式や箇条書きで書かれている技術仕様（サイズ、重量、電源、解像度など）をできるだけ多く抽出してください。
- 型番/製品名は、画像内の表記（例：3R-XXXX）やタイトルから推定。

【ヒント（既に入力されている可能性あり）】
- 型番ヒント: ${modelHint || ""}
- 製品名ヒント: ${productHint || ""}

【返却JSONスキーマ（厳守）】
{
  "model": "型番",
  "productName": "製品名",
  "specs": ["サイズ: WxHxD", "重量: xx g", "仕様項目: 値", ...],
  "ops": [{"title":"大分類","items":["動作1","動作2","..."]}],
  "accs": ["付属品1","付属品2","...","取扱説明書"]
}

【ファイル情報】
ファイル名: ${fileName}
`.trim();

  // Construct message with images
  const content = [{ type: "text", text: userText }];
  for (const base64Image of images) {
    // base64Image is expected to be "data:image/jpeg;base64,..." or just base64
    // OpenAI API expects just the base64 part for image_url or passed as url if public
    // Here we assume it's a data URL, we need to pass it as image_url with url field
    content.push({
      type: "image_url",
      image_url: {
        url: base64Image, // data:image/jpeg;base64,... is supported
        detail: "high"
      }
    });
  }

  deps.logger.info("inspection", `Calling AI Extract (Vision) for ${fileName}, model=${MODEL}, images=${images.length}`);

  const completion = await deps.openaiClient.chatCompletion({
    model: MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: content },
    ],
    reasoning_effort: REASONING,
    verbosity: VERBOSITY,
  });

  const text = completion.choices[0]?.message?.content ?? "{}";
  let obj;
  try {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    const jsonText = s >= 0 && e > s ? text.slice(s, e + 1) : "{}";
    obj = JSON.parse(jsonText);
  } catch {
    deps.logger.warn("inspection", "JSON Parse Error in aiExtractFromImages", { raw: text.slice(0, 50) });
    obj = {};
  }

  return normalizeExtractResult(obj);
}

function normalizeExtractResult(obj) {
  const model = norm(obj.model);
  const productName = norm(obj.productName);
  const specs = dedupeKeepOrder(Array.isArray(obj.specs) ? obj.specs : []);
  const opsIn = Array.isArray(obj.ops) ? obj.ops : [];
  const ops = [];
  for (const g0 of opsIn) {
    const title = norm(g0?.title);
    let items = Array.isArray(g0?.items) ? g0.items.map(norm) : [];
    items = items.filter(x => x && !shouldSkipOpItem(x));
    items = dedupeKeepOrder(items);
    if (!title && items.length === 0) continue;
    ops.push({ title, items });
  }
  let accs = Array.isArray(obj.accs) ? obj.accs.map(normalizeManualAccessory).map(norm) : [];
  accs = accs.map(normalizeManualAccessory);
  accs.push("取扱説明書");
  accs = dedupeKeepOrder(accs);
  accs = accs.map(a => {
    if (a.includes("USB") && (a.includes("コード") || a.includes("ケーブル") || a === "ケーブル")) return "USBケーブル";
    if (a === "ケーブル") return "USBケーブル";
    return a;
  });
  accs = dedupeKeepOrder(accs);
  return { model, productName, specs, ops, accs };
}

// ===== Proxy Handler =====
async function handleFetch(req, res) {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  // SSRF防止: 外部URLの安全性検証
  const urlCheck = validateExternalUrl(url);
  if (!urlCheck.safe) {
    deps.logger.warn("inspection", `Blocked unsafe URL: ${url}`, { reason: urlCheck.reason });
    return res.status(403).json({ error: "ForbiddenURL", detail: urlCheck.reason });
  }

  try {
    const fetchRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      }
    });

    if (!fetchRes.ok) {
      throw new Error(`Failed to fetch PDF: ${fetchRes.statusText}`);
    }

    const buffer = await fetchRes.arrayBuffer();
    const contentType = fetchRes.headers.get("content-type") || "application/pdf";

    res.setHeader("Content-Type", contentType);
    res.send(Buffer.from(buffer));

  } catch (e) {
    deps.logger.error("inspection", "Proxy fetch failed", { url, error: e.message });
    res.status(500).json({ error: "FetchError", detail: e.message });
  }
}

function findMarkerRow(ws, marker) {
  // A列完全一致で探す
  for (let r = 1; r <= ws.rowCount; r++) {
    const v = norm(ws.getRow(r).getCell(1).value);
    if (v === marker) return r;
  }
  return -1;
}

function buildRowsFromSimpleList(kind, arr) {
  // kind: "仕様" | "動作" | "付属品"
  const rows = [];
  for (const t0 of arr || []) {
    const t = norm(t0);
    if (!t) continue;
    rows.push({
      B: kind,
      C: t,
      E: "",
      F: 1,
      G: "必須",
    });
  }
  return rows;
}

function applyRowStyle(ws, rowNumber, colCount) {
  const row = ws.getRow(rowNumber);
  for (let c = 1; c <= colCount; c++) {
    const cell = row.getCell(c);
    cell.border = thinBorder();
  }
}

function setWorkbookFontAll(wb, fontName, fontSize) {
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        cell.font = { ...(cell.font || {}), name: fontName, size: fontSize };
      });
    });
  });
}

function centerGFromRow14(ws) {
  // G列 = 7、14行目以降のみ中央揃え
  const col = 7;
  for (let r = 14; r <= ws.rowCount; r++) {
    const cell = ws.getRow(r).getCell(col);
    cell.alignment = { ...(cell.alignment || {}), horizontal: "center", vertical: "middle" };
  }
}

async function generateExcel({
  model, productName,
  selectedLabels,
  selectedSelectionItems,
  specText,
  opTitles,
  opItems,
  accText
}) {
  const buf = await downloadTemplateBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  const wsMain = wb.getWorksheet("検品リスト");
  const wsList = wb.getWorksheet("検品項目リスト");
  if (!wsMain) throw new Error("SheetError: 検品リスト が見つかりません");
  if (!wsList) throw new Error("SheetError: 検品項目リスト が見つかりません");

  // ①選択リストの元行（A=選択リスト）をテンプレから拾い、C列一致で “検品リスト” に挿入するための行データへ変換
  // ※ここは「C列の内容をHTMLで表示」要件に合わせる。
  // 　Excelに入れる際は、シンプルに「区分/検品内容」へ落とす（余計なスタイル崩れ回避）。
  const selectionInsertRows = [];
  const selSet = new Set((selectedSelectionItems || []).map(norm).filter(Boolean));
  if (selSet.size) {
    wsList.eachRow((row) => {
      const a = norm(row.getCell(1).value);
      if (a !== "選択リスト") return;
      const c = norm(row.getCell(3).value);
      if (!c || !selSet.has(c)) return;

      // 区分はテンプレB列があれば使う。無ければ「安全」ではなく空にする（任意）
      const b = norm(row.getCell(2).value) || "";
      selectionInsertRows.push({
        B: b || "安全",   // 迷う場合は安全側。不要ならテンプレBを埋めて運用。
        C: c,
        E: "",
        F: 1,
        G: "必須",
      });
    });
  }

  // ②ラベル選択（A列完全一致）→ B列以降コピー（テンプレの意図を尊重）
  // ただし、このテンプレは「検品リスト」シートへ挿入する仕様なので、ここでは同様の “簡易行” として展開
  const labelInsertRows = [];
  const labelSet = new Set((selectedLabels || []).map(norm).filter(Boolean));
  if (labelSet.size) {
    wsList.eachRow((row) => {
      const a = norm(row.getCell(1).value);
      if (!a || !labelSet.has(a)) return;

      // A列はコピーしない。B以降のうち、少なくともB/Cがある前提で使う
      const b = norm(row.getCell(2).value);
      const c = norm(row.getCell(3).value);
      if (!b && !c) return;

      labelInsertRows.push({
        B: b || "安全",
        C: c || "",
        E: "",
        F: 1,
        G: "必須",
      });
    });
  }

  // ③spec/op/acc
  const specRows = buildRowsFromSimpleList("仕様", specText);
  const accRows = buildRowsFromSimpleList("付属品", (accText || []).map(normalizeManualAccessory));

  // ④動作（タイトル+アイテム）
  // - Excelではタイトルを太字/下線にしない（要件）
  // - タイトルも行として入れる（要件）
  const opRows = [];
  const tSet = new Set((opTitles || []).map(norm).filter(Boolean));
  const iSet = new Set((opItems || []).map(norm).filter(Boolean));

  // タイトル→その下に items が来るように並べる（UI側でグループは崩れている可能性があるので、ここは “選ばれたもの順” を尊重）
  // ただし最低限、タイトルは先に全部入れて、その後itemsを入れる（見た目の安定）
  for (const t of tSet) {
    if (!t) continue;
    opRows.push({ B: "動作", C: t, E: "", F: 1, G: "必須" });
  }
  for (const it of iSet) {
    if (!it) continue;
    if (shouldSkipOpItem(it)) continue; // 最終ガード
    opRows.push({ B: "動作", C: it, E: "", F: 1, G: "必須" });
  }

  // ⑤挿入処理（マーカー行に挿入→マーカー行を削除）
  function insertAtMarker(marker, rowsToInsert) {
    const r0 = findMarkerRow(wsMain, marker);
    if (r0 < 0) throw new Error(`MarkerError: ${marker} が見つかりません`);
    const styleSources = [9, 10, 11].map((col) => wsMain.getRow(r0).getCell(col));
    const styleClones = styleSources.map((cell) =>
      cell && cell.style ? JSON.parse(JSON.stringify(cell.style)) : null
    );

    // マーカー行の位置に行を挿入し、最後にマーカー行を消す
    // ExcelJS: spliceRows(start, deleteCount, ...rows)
    const mapped = rowsToInsert.map(r => {
      // A列は空、B/C/E/F/Gを入れる
      // ※テンプレに列が多いので、最低限の列だけ渡す（既存の枠線/列幅を崩しにくい）
      return [
        "",           // A
        r.B || "",    // B
        r.C || "",    // C
        "",           // D
        r.E || "",    // E
        r.F ?? "",    // F
        r.G || "",    // G
      ];
    });

    // まずマーカー行を削除し、同じ場所へ挿入する
    wsMain.spliceRows(r0, 1, ...mapped);

    // 追加した行に枠線を強制（格子崩れ対策）
    const colCount = Math.max(wsMain.columnCount, 11); // A〜K相当まで
    for (let i = 0; i < mapped.length; i++) {
      applyRowStyle(wsMain, r0 + i, colCount);
      for (let idx = 0; idx < styleClones.length; idx++) {
        const style = styleClones[idx];
        if (!style) continue;
        const col = 9 + idx;
        const cell = wsMain.getRow(r0 + i).getCell(col);
        const border = cell.border;
        cell.style = style;
        if (border) cell.border = border;
      }
    }
  }

  insertAtMarker("__INS_SPEC__", specRows);
  insertAtMarker("__INS_OP__", opRows);
  insertAtMarker("__INS_ACC__", accRows);

  // __INS_SELECT__ は「ラベル選択」＋「選択リスト」をまとめて入れる（要件の運用に合わせる）
  const selectRows = [...labelInsertRows, ...selectionInsertRows];
  insertAtMarker("__INS_SELECT__", selectRows);

  // ⑥書体/サイズ（全シート）
  setWorkbookFontAll(wb, "游ゴシック", 10);

  // ⑦G列センター（14行目以降のみ）
  centerGFromRow14(wsMain);

  // ⑧不要シート削除（出力はこの3つだけ）
  const keep = new Set(["検品リスト", "検品用画像", "検品外観基準"]);
  wb.worksheets
    .map(s => s.name)
    .filter(name => !keep.has(name))
    .forEach(name => wb.removeWorksheet(name));

  const mainIndex = wb.worksheets.findIndex((s) => s.name === "検品リスト");
  wb.views = [{ activeTab: mainIndex >= 0 ? mainIndex : 0 }];

  // ファイル名
  const safeModel = cleanFileNamePart(model);
  const safeProduct = cleanFileNamePart(productName);
  const fileName = `検品リスト_${safeModel}_${safeProduct}.xlsx`;

  const out = await wb.xlsx.writeBuffer();
  const fileBase64 = Buffer.from(out).toString("base64");
  return { fileName, fileBase64 };
}


async function handleMeta(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });
  const items = await getSelectionItemsFromTemplate();
  return res.status(200).json({ selectionItems: items });
}

async function handleExtract(req, res) {
  // New payload format: { text: string, images: string[], fileName: string, modelHint: string, productHint: string }
  // Old payload format (fallback): PDF binary body or { pdfUrl: string }

  // Allow simple CORS if needed (though nextjs handles it usually)
  if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });

  let body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

  // Check if it's the new client-side extracted payload
  if (body.text !== undefined || body.images !== undefined) {
    const { text, images, fileName, modelHint, productHint } = body;

    let result;
    if (images && images.length > 0) {
      // Vision API
      result = await aiExtractFromImages({ images, fileName, modelHint, productHint });
    } else if (text) {
      // Text API
      result = await aiExtractFromSourceText({ sourceText: text, fileName, modelHint, productHint });
    } else {
      return res.status(400).json({ error: "BadRequest", detail: "No text or images provided" });
    }

    // Add notice if text was empty but no images provided
    if (!images && (!text || text.length < 100)) {
      result.notice = "テキスト情報が少なすぎます。スキャンPDFの可能性があります。";
    }

    return res.json({ ok: true, ...result });
  }

  // Legacy Logic
  const { pdfUrl } = body;

  try {
    const { buffer, sourceType, htmlText } = await getPdfBufferFromRequest(req, { pdfUrl });
    const fileName = "manual.pdf";
    const modelHint = "";
    const productHint = "";

    if (sourceType === "pdf") {
      // Server-side PDF extraction (fallback)
      // Note: aiExtractFromPdfFile uses pdf-parse now
      const data = await aiExtractFromPdfFile({ pdfBuffer: buffer, fileName, modelHint, productHint });
      return res.status(200).json(data);
    } else {
      const text = htmlToText(htmlText).slice(0, 30000);
      const data = await aiExtractFromSourceText({ sourceText: text, fileName: "page.html", modelHint, productHint });
      return res.status(200).json(data);
    }
  } catch (e) {
    deps.logger.error("inspection", "Extract failed", { error: e.message });
    return res.status(500).json({ error: e.message });
  }
}

async function handleGenerate(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  const result = await generateExcel({
    model: body.model,
    productName: body.productName,
    selectedLabels: body.selectedLabels,
    selectedSelectionItems: body.selectedSelectionItems,
    specText: body.specText,
    opTitles: body.opTitles,
    opItems: body.opItems,
    accText: body.accText
  });

  return res.status(200).json(result);
}

module.exports = handler;
module.exports._deps = deps;
