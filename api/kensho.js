// api/kensho.js（統合版 OK-CommonJS）
// op=db        : GET=SharePointからDB / POST=アップロードExcel(base64)からDB
// op=template  : GET=テンプレDL（first/mass）
// op=generate  : POST=初回検証ファイル生成
// op=ai        : POST=AIコメント生成（単体）

const xlsx = require("xlsx");
const ExcelJS = require("exceljs");
const logger = require("./utils/logger");
const openaiClient = require("./utils/openai-client");

// 依存関係コンテナ
const deps = {
  logger,
  openaiClient
};

// ===== OpenAI =====
const MODEL = process.env.MODEL_MANUAL_CHECK || "gpt-5.2";
const REASONING = process.env.MANUAL_CHECK_REASONING || "medium";
const VERBOSITY = process.env.MANUAL_CHECK_VERBOSITY || "low";

// ===== SharePoint (Microsoft Graph) =====
async function getAccessToken() {
  const tenantId = process.env.MANUAL_TENANT_ID;
  const clientId = process.env.MANUAL_CLIENT_ID;
  const clientSecret = process.env.MANUAL_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("ConfigError: MANUAL_TENANT_ID / MANUAL_CLIENT_ID / MANUAL_CLIENT_SECRET が不足");
  }

  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  );

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("TokenError: " + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function downloadExcelBufferFromSharePoint() {
  // DEBUG: Mainで何が入っているか確認（秘密情報は表示しない）
  const has = (v) => (v ? "OK" : "MISSING");
  deps.logger.info("kensho", "env check", {
    MANUAL_SHAREPOINT_FILE_URL: has(process.env.MANUAL_SHAREPOINT_FILE_URL),
    MANUAL_TENANT_ID: has(process.env.MANUAL_TENANT_ID),
    MANUAL_CLIENT_ID: has(process.env.MANUAL_CLIENT_ID),
    MANUAL_CLIENT_SECRET: has(process.env.MANUAL_CLIENT_SECRET),
  });

  const fileUrl = process.env.MANUAL_SHAREPOINT_FILE_URL;
  if (!fileUrl) throw new Error("ConfigError: MANUAL_SHAREPOINT_FILE_URL が不足");

  const accessToken = await getAccessToken();
  const shareId = Buffer.from(fileUrl).toString("base64").replace(/=+$/, "");

  const graphRes = await fetch(
    `https://graph.microsoft.com/v1.0/shares/u!${shareId}/driveItem/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!graphRes.ok) {
    const txt = await graphRes.text();
    throw new Error(`GraphError(${graphRes.status}): ${txt}`);
  }

  const ab = await graphRes.arrayBuffer();
  return Buffer.from(ab);
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// ===== DB parse (xlsx) =====
function parseKenshoDbFromBuffer(buf) {
  const wb = xlsx.read(buf, { type: "buffer" });

  const sheetLabel = wb.Sheets["検証ラベル分類"];
  const sheetList = wb.Sheets["検証項目リスト"];
  const sheetFirst = wb.Sheets["初回検証フォーマット"];
  const sheetMass = wb.Sheets["量産前検証フォーマット"];

  if (!sheetLabel) throw new Error("SheetError: 検証ラベル分類 が見つかりません");
  if (!sheetList) throw new Error("SheetError: 検証項目リスト が見つかりません");
  if (!sheetFirst) throw new Error("SheetError: 初回検証フォーマット が見つかりません");
  if (!sheetMass) throw new Error("SheetError: 量産前検証フォーマット が見つかりません");

  const labelJson = xlsx.utils.sheet_to_json(sheetLabel, { defval: "" });
  const labelMaster = labelJson
    .map((row, idx) => {
      const label = (row["ラベル名"] ?? "").toString().trim();
      const uiGenre = (row["ジャンル名"] ?? "").toString().trim();
      const uiGenreOrder = safeNumber(row["ジャンル表示順"]);
      const uiItemOrder = safeNumber(row["ジャンル内表示順"]);
      const hiddenRaw = (row["ジャンル表示対象外"] ?? "").toString().trim();
      const uiHidden = hiddenRaw !== "" && hiddenRaw !== "0";
      if (!label || !uiGenre) return null;
      return { id: idx, label, uiGenre, uiGenreOrder, uiItemOrder, uiHidden };
    })
    .filter(Boolean);

  const listJson = xlsx.utils.sheet_to_json(sheetList, { defval: "" });
  const itemList = listJson
    .map((row, idx) => {
      const major = (row["大分類"] ?? "").toString().trim();
      if (!major) return null;
      return {
        id: idx,
        major,
        B: (row["項目"] ?? "").toString(),
        C: (row["確認内容"] ?? "").toString(),
        D: (row["確認"] ?? "").toString(),
        E: (row["結論"] ?? "").toString(),
        F: (row["最終確認"] ?? "").toString(),
        G: (row["確認結果"] ?? "").toString(),
        H: (row["質問"] ?? "").toString(),
      };
    })
    .filter(Boolean);

  return { sheetNames: wb.SheetNames, labelMaster, itemList };
}



// ===== Generate helpers (ExcelJS) =====
function thinBorder() {
  return {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };
}

function findLastUsedRowBH(ws) {
  let last = 1;
  ws.eachRow((row, rowNumber) => {
    for (let col = 2; col <= 8; col++) {
      const v = row.getCell(col).value;
      if (v !== null && v !== undefined && String(v).trim() !== "") {
        if (rowNumber > last) last = rowNumber;
      }
    }
  });
  return last;
}

function copyCellStyle(src, dst) {
  dst.style = { ...src.style };
}

function normalizeLite(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[、。．，\.\-ー—_]/g, "")
    .replace(/(を)?(検証|確認|チェック)(する|します|した|してください)?$/g, "")
    .trim()
    .toLowerCase();
}

function stripVerifyEnding(s) {
  return String(s || "")
    .replace(/(であること)?(を)?(検証|確認|チェック)(する|します|した|してください)?$/g, "")
    .trim();
}

function buildExistingSet(ws) {
  const set = new Set();
  ws.eachRow((row) => {
    const v = row.getCell(3).value; // C列：確認内容
    if (v !== null && v !== undefined && String(v).trim() !== "") {
      set.add(normalizeLite(v));
    }
  });
  return set;
}

function isSameMeaning(line, existingSet) {
  const p = normalizeLite(line);
  if (!p) return false;
  if (existingSet.has(p)) return true;

  for (const k of existingSet) {
    if (k.length < 4) continue;
    if (p.includes(k) || k.includes(p)) return true;
  }
  return false;
}

// ===== AI suggest（generate用）=====
async function aiSuggest({ productInfo, selectedLabels, existingChecks, images }) {
  const sys =
    "あなたは品質・検証のプロです。\n" +
    "入力情報（一般名称/特徴/備考/選択ラベル）と画像、既存の検証項目を踏まえ、\n" +
    "1) 表に追記する追加検証項目（items）\n" +
    "2) Excel末尾に記載するAIコメント（検証ポイント・仕様観点）\n" +
    "を作成してください。\n" +
    "\n" +
    "【重要】出力は JSON（オブジェクト）1つのみ。余計な文章は禁止。\n" +
    "形式：{\n" +
    '  "items":[{"text":"...","note":"..."}],\n' +
    '  "commentPoints":["..."],\n' +
    '  "specCandidates":["..."],\n' +
    '  "gatingQuestions":["..."]\n' +
    "}\n" +
    "\n" +
    "【制約】\n" +
    "・各配列要素は1文（日本語）で、80文字以内。超える場合は自然な位置で分割して別要素にする。\n" +
    "・commentPoints：用途を一言→品質の最重要事項→最大負荷→具体事例の順。\n" +
    "・specCandidates：一般名称から他社類似品で一般的に並ぶスペック項目名だけ。\n" +
    "・gatingQuestions：メーカー回答次第で案件進行可否が変わる確認事項だけ。\n" +
    "・既存の検証項目と重複してもOK。\n" +
    "・語尾に「検証する」「確認する」は付けない（体言止め/観点の形）。\n";

  const payload = {
    productInfo,
    selectedLabels,
    existingChecks: (existingChecks || []).slice(0, 600),
  };

  const content = [{ type: "text", text: JSON.stringify(payload, null, 2) }];

  if (Array.isArray(images)) {
    for (const img of images) {
      if (typeof img === "string" && (img.startsWith("data:image/") || img.startsWith("http"))) {
        content.push({ type: "image_url", image_url: { url: img } });
      }
    }
  }

  deps.logger.info("kensho", `Calling AI Suggest with model ${MODEL}`);

  const completion = await deps.openaiClient.chatCompletion({
    model: MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content },
    ],
    reasoning_effort: REASONING,
    verbosity: VERBOSITY,
    // jsonMode: true // Optional but useful if model supports it robustly. Current prompt asks for JSON.
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  const jsonText = s >= 0 && e > s ? raw.slice(s, e + 1) : "{}";

  let obj = {};
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    deps.logger.warn("kensho", "JSON Parse Error in aiSuggest", { raw: raw.slice(0, 100) });
  }

  return {
    items: Array.isArray(obj.items) ? obj.items : [],
    commentPoints: Array.isArray(obj.commentPoints) ? obj.commentPoints : [],
    specCandidates: Array.isArray(obj.specCandidates) ? obj.specCandidates : [],
    gatingQuestions: Array.isArray(obj.gatingQuestions) ? obj.gatingQuestions : [],
  };
}

// ===== op handlers =====
async function handleDb(req, res) {
  if (req.method === "GET") {
    const buf = await downloadExcelBufferFromSharePoint();
    const data = parseKenshoDbFromBuffer(buf);
    return res.status(200).json(data);
  }

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { base64 } = body || {};
    if (!base64) return res.status(400).json({ error: "BadRequest", detail: "base64 がありません" });

    const buf = Buffer.from(base64, "base64");
    const data = parseKenshoDbFromBuffer(buf);
    return res.status(200).json(data);
  }

  return res.status(405).json({ error: "MethodNotAllowed" });
}

async function handleTemplate(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "MethodNotAllowed" });

  const type = (req.query?.type || "first").toString();
  const targetSheet = type === "mass" ? "量産前検証フォーマット" : "初回検証フォーマット";
  const filename = type === "mass" ? "量産前検証フォーマット.xlsx" : "初回検証フォーマット.xlsx";

  // 1) SharePointのdatabase.xlsxを取得
  const buf = await downloadExcelBufferFromSharePoint();

  // 2) ExcelJSで読み込み（書式をできるだけ保持）
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  const ws = wb.getWorksheet(targetSheet);
  if (!ws) throw new Error(`SheetNotFound: ${targetSheet}`);

  // 3) 対象シート以外を削除（後ろから消す）
  for (let i = wb.worksheets.length - 1; i >= 0; i--) {
    const w = wb.worksheets[i];
    if (w.name !== targetSheet) wb.removeWorksheet(w.id);
  }

  // 4) 出力（書式付き）
  const out = await wb.xlsx.writeBuffer();

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  return res.status(200).send(Buffer.from(out));
}


async function handleAi(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { productInfo, selectedLabels, currentRows, images } = body;

  const sys =
    "あなたは品質・検証のプロです。\n" +
    "入力情報（一般名称/特徴/備考/選択ラベル）と画像、既存の検証項目を踏まえ、\n" +
    "Excel末尾に記載する『AIコメント（検証ポイント・仕様観点）』を作成してください。\n" +
    "\n" +
    "【重要】出力は JSON（オブジェクト）1つのみ。余計な文章は禁止。\n" +
    "形式：{\n" +
    '  "commentPoints": ["..."],\n' +
    '  "specCandidates": ["..."],\n' +
    '  "gatingQuestions": ["..."]\n' +
    "}\n" +
    "【制約】各配列要素は1文=80文字以内。語尾に「検証する」は付けない。\n";

  const content = [
    { type: "text", text: JSON.stringify({ productInfo, selectedLabels, currentRows }, null, 2) },
  ];

  if (Array.isArray(images)) {
    for (const img of images) {
      if (typeof img === "string" && (img.startsWith("data:image/") || img.startsWith("http"))) {
        content.push({ type: "image_url", image_url: { url: img } });
      }
    }
  }

  deps.logger.info("kensho", "Calling AI (handleAi) endpoint");

  const completion = await deps.openaiClient.chatCompletion({
    model: MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content },
    ],
    reasoning_effort: REASONING,
    verbosity: VERBOSITY,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  const jsonText = (s >= 0 && e > s) ? raw.slice(s, e + 1) : "{}";

  return res.status(200).json({ text: jsonText });
}

async function handleGenerate(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { selectedLabels, productInfo, images } = body;

  // selectedLabels は未選択でも許可する（未選択=抽出0件のテンプレ生成）
  const safeLabels = Array.isArray(selectedLabels)
    ? selectedLabels.filter(v => (v ?? "").toString().trim())
    : [];


  // 1) SharePointのdatabase.xlsxを取得
  const buf = await downloadExcelBufferFromSharePoint();

  // 2) ExcelJSで読み込み（書式保持）
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  const wsList = wb.getWorksheet("検証項目リスト");
  const wsTpl = wb.getWorksheet("初回検証フォーマット");
  if (!wsList) throw new Error("SheetError: 検証項目リスト が見つかりません");
  if (!wsTpl) throw new Error("SheetError: 初回検証フォーマット が見つかりません");

  // C1 に選択語句（カンマ区切り）
  wsTpl.getCell("C1").value = `選択語句：${safeLabels.length ? safeLabels.join(",") : "（なし）"}`;


  // 3) 検証項目リストから抽出（A=大分類、B〜Hを機械コピー）
  const chosen = new Set(safeLabels);

  const extracted = [];
  for (let r = 3; r <= wsList.rowCount; r++) {
    const row = wsList.getRow(r);
    const major = (row.getCell(1).value ?? "").toString().trim(); // A
    if (!major) continue;
    if (!chosen.has(major)) continue;

    extracted.push({
      B: row.getCell(2).value ?? "",
      C: row.getCell(3).value ?? "",
      D: row.getCell(4).value ?? "",
      E: row.getCell(5).value ?? "",
      F: row.getCell(6).value ?? "",
      G: row.getCell(7).value ?? "",
      H: row.getCell(8).value ?? "",
    });
  }

  // 4) テンプレ末尾を探して追記（書式保持 + 追記分だけ罫線）
  const last = findLastUsedRowBH(wsTpl);
  const styleRow = wsTpl.getRow(last);
  let writeRowNo = last + 1;

  for (const r of extracted) {
    const newRow = wsTpl.getRow(writeRowNo);

    newRow.getCell(1).value = "";
    newRow.getCell(2).value = r.B;
    newRow.getCell(3).value = r.C;
    newRow.getCell(4).value = r.D;
    newRow.getCell(5).value = r.E;
    newRow.getCell(6).value = r.F;
    newRow.getCell(7).value = r.G;
    newRow.getCell(8).value = r.H;

    for (let c = 1; c <= 8; c++) {
      copyCellStyle(styleRow.getCell(c), newRow.getCell(c));
    }
    for (let c = 2; c <= 8; c++) {
      newRow.getCell(c).border = thinBorder();
    }

    writeRowNo++;
  }

  // 5) AI提案（重複OK）
  const existingSet = buildExistingSet(wsTpl);

  const existingChecks = [];
  wsTpl.eachRow((row) => {
    const b = row.getCell(2).value;
    const c = row.getCell(3).value;
    if (b || c) existingChecks.push({ B: String(b || ""), C: String(c || "") });
  });

  const {
    items: aiItemsRaw,
    commentPoints: aiCommentPointsRaw,
    specCandidates: aiSpecCandidatesRaw,
    gatingQuestions: aiGatingQuestionsRaw,
  } = await aiSuggest({
    productInfo,
    selectedLabels,
    existingChecks,
    images,
  });

  for (const it of aiItemsRaw) {
    const text = stripVerifyEnding(it?.text || "");
    if (!text) continue;

    const note = stripVerifyEnding(it?.note || "");

    const newRow = wsTpl.getRow(writeRowNo);
    for (let c = 1; c <= 8; c++) copyCellStyle(styleRow.getCell(c), newRow.getCell(c));

    newRow.getCell(1).value = "";
    newRow.getCell(2).value = "AI提案";
    newRow.getCell(3).value = text;
    newRow.getCell(7).value = note;

    for (let c = 2; c <= 8; c++) newRow.getCell(c).border = thinBorder();

    existingSet.add(normalizeLite(text));
    writeRowNo++;
  }

  // 6) 最下段コメント（ルールそのまま移植）
  const MAX_SENTENCE_LEN = 80;

  function enforceMaxLen(sentence, maxLen = MAX_SENTENCE_LEN) {
    const s = String(sentence || "").trim();
    if (!s) return [];
    if (s.length <= maxLen) return [s];

    const chunks = [];
    let rest = s;

    while (rest.length > maxLen) {
      const window = rest.slice(0, maxLen + 1);
      let cut = Math.max(
        window.lastIndexOf("、"),
        window.lastIndexOf("・"),
        window.lastIndexOf("："),
        window.lastIndexOf(":"),
        window.lastIndexOf("／"),
        window.lastIndexOf("/"),
        window.lastIndexOf(" "),
        window.lastIndexOf("）"),
        window.lastIndexOf(")")
      );
      if (cut < Math.floor(maxLen * 0.6)) cut = maxLen;

      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks.filter(Boolean);
  }

  function asBullet(s) {
    const t = String(s || "").trim();
    if (!t) return "";
    return t.startsWith("・") ? t : `・${t}`;
  }

  function writeB(text) {
    const r = wsTpl.getRow(writeRowNo);
    const c = r.getCell(2);

    c.value = text;

    copyCellStyle(styleRow.getCell(2), c);
    c.font = { ...(c.font || {}), size: 16 };
    c.alignment = { vertical: "top", horizontal: "left", wrapText: false };
    c.border = {}; // 枠なし
    writeRowNo++;
  }

  function writeBlankLine() { writeB(""); }

  function writeTitle(titleText) {
    writeBlankLine();
    writeB(titleText);
  }

  function writeBullets(lines) {
    for (const line of lines) {
      const parts = enforceMaxLen(line, MAX_SENTENCE_LEN);
      for (const p of parts) {
        const suffix = isSameMeaning(p, existingSet) ? " (提案済)" : "";
        writeB(asBullet(`${p}${suffix}`));
      }
    }
  }

  const commentPoints = (aiCommentPointsRaw || []).map(x => String(x || "").trim()).filter(Boolean);
  const specCandidates = (aiSpecCandidatesRaw || []).map(x => String(x || "").trim()).filter(Boolean);
  const gatingQuestions = (aiGatingQuestionsRaw || []).map(x => String(x || "").trim()).filter(Boolean);

  const hasAny = commentPoints.length || specCandidates.length || gatingQuestions.length;

  if (hasAny) {
    writeTitle("AIコメント（検証ポイント・仕様観点）");
    writeBullets(commentPoints);

    if (specCandidates.length) {
      writeTitle("重要スペック候補");
      writeBullets(specCandidates);
    }

    if (gatingQuestions.length) {
      writeTitle("案件可否に影響");
      writeBullets(gatingQuestions);
    }
  }

  // 7) 出力は「初回検証」シートのみ、名称変更
  wsTpl.name = "初回検証";
  wb.worksheets
    .filter((ws) => ws.name !== "初回検証")
    .forEach((ws) => wb.removeWorksheet(ws.id));

  // 8) ファイル名
  const name = (productInfo?.name || "無題").toString().trim() || "無題";
  const filename = `検証_${name}.xlsx`;

  const out = await wb.xlsx.writeBuffer();

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return res.status(200).send(Buffer.from(out));
}

// ===== main handler =====
async function handler(req, res) {
  // 最低限のCORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const op = (req.query?.op || "").toString();
    deps.logger.info("kensho", `Request received op=${op}`);

    if (op === "db") return await handleDb(req, res);
    if (op === "template") return await handleTemplate(req, res);
    if (op === "generate") return await handleGenerate(req, res);
    if (op === "ai") return await handleAi(req, res);

    deps.logger.warn("kensho", `Unknown op: ${op}`);
    return res.status(404).json({ error: "NotFound", detail: "Unknown op" });
  } catch (err) {
    deps.logger.error("kensho", "Unexpected error", { error: err.message });
    return res.status(500).json({ error: "UnexpectedError", detail: String(err?.message || err) });
  }
}

module.exports = handler;
module.exports._deps = deps;

