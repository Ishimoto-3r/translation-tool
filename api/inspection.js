// api/inspection.js（全文）

import ExcelJS from "exceljs";
import OpenAI from "openai";

export const config = {
  api: { bodyParser: false },
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INSPECTION_MODEL = process.env.INSPECTION_MODEL || "gpt-5.2";
const INSPECTION_REASONING = process.env.INSPECTION_REASONING || "medium";
const INSPECTION_VERBOSITY = process.env.INSPECTION_VERBOSITY || "low";

const OUTPUT_KEEP_SHEETS = new Set([
  "検品リスト",
  "検品用画像",
  "検品ルールブック",
  "検品外観基準",
]);

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ===== SharePoint =====
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

async function downloadTemplateExcelBuffer() {
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

// ===== Excel helpers =====
function findMarkerRow(ws, markerText) {
  const max = ws.rowCount || 0;
  for (let r = 1; r <= max; r++) {
    const v = ws.getCell(r, 1).value;
    const s = (v ?? "").toString().trim();
    if (s === markerText) return r;
  }
  return null;
}

function cloneRowStyle(row) {
  const style = { ...row.style };
  const cellStyles = {};
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    cellStyles[colNumber] = { ...cell.style };
  });
  return { style, cellStyles };
}

function applyRowStyle(ws, rowNumber, styleSnapshot, upToCol) {
  const row = ws.getRow(rowNumber);
  row.style = { ...styleSnapshot.style };
  for (let c = 1; c <= upToCol; c++) {
    const cell = row.getCell(c);
    const st = styleSnapshot.cellStyles[c];
    if (st) cell.style = { ...st };
  }
}

function normalizeStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (x ?? "").toString().trim()).filter((x) => x.length > 0);
}

function safeFilePart(s) {
  const t = (s ?? "").toString().trim();
  if (!t) return "";
  return t.replace(/[\\\/\:\*\?\"\<\>\|]/g, " ").replace(/\s+/g, " ").trim();
}

function buildExcerptRows(kindLabel, lines) {
  return lines.map((line) => {
    const values = [];
    values[1] = "";
    values[2] = kindLabel;
    values[3] = line;
    values[5] = "";
    values[6] = 1;
    values[7] = "必須";
    return values;
  });
}

// ②：選択肢は「検品項目リスト」A=選択リスト の C列
function extractSelectOptions(wsList) {
  const opts = [];
  const max = wsList.rowCount || 0;
  for (let r = 1; r <= max; r++) {
    const a = (wsList.getCell(r, 1).value ?? "").toString().trim();
    if (a !== "選択リスト") continue;
    const c = (wsList.getCell(r, 3).value ?? "").toString().trim();
    if (!c) continue;
    opts.push(c);
  }
  const seen = new Set();
  return opts.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

// ⑤：__INS_SELECT__ に差し込み
// - A=選択リスト の行は「C列が選択値と一致」した行を対象
// - A列はコピーしない（B以降コピー）
function buildSelectedRows(wsList, selectedValues, warnings) {
  const wanted = new Set(selectedValues);
  const hit = new Set();
  const rows = [];

  const max = wsList.rowCount || 0;
  const lastCol = Math.max(2, wsList.columnCount || 2);

  for (let r = 1; r <= max; r++) {
    const a = (wsList.getCell(r, 1).value ?? "").toString().trim();

    // 旧方式（A列そのものがラベル）も残す：固定ラベルに対応
    if (a && wanted.has(a)) {
      hit.add(a);
      const values = [];
      values[1] = "";
      for (let c = 2; c <= lastCol; c++) values[c] = wsList.getCell(r, c).value;
      rows.push(values);
      continue;
    }

    // 新方式：A=選択リスト かつ C が選択値
    if (a === "選択リスト") {
      const cText = (wsList.getCell(r, 3).value ?? "").toString().trim();
      if (cText && wanted.has(cText)) {
        hit.add(cText);
        const values = [];
        values[1] = "";
        for (let c = 2; c <= lastCol; c++) values[c] = wsList.getCell(r, c).value;
        rows.push(values);
      }
    }
  }

  for (const v of selectedValues) {
    if (!hit.has(v)) warnings.push(`未一致ラベル: ${v}`);
  }

  return rows;
}

function keepOnlySheets(workbook) {
  const names = workbook.worksheets.map((w) => w.name);
  for (const name of names) {
    if (!OUTPUT_KEEP_SHEETS.has(name)) {
      const ws = workbook.getWorksheet(name);
      if (ws) workbook.removeWorksheet(ws.id);
    }
  }
}

// ===== OpenAI: PDF→抽出（file_id） =====
async function extractFromPdfToArrays({ filename, pdfBuffer }) {
  const fileObj = new File([pdfBuffer], filename, { type: "application/pdf" });

  let uploaded = null;
  try {
    uploaded = await client.files.create({ file: fileObj, purpose: "assistants" });

    const sys =
      "あなたは日本語の技術文書から検品リスト用の抜粋を作る担当です。\n" +
      "PDFを読み、次の3区分の検品項目（短文）を抽出してください。\n" +
      "- 仕様\n- 動作\n- 付属品\n\n" +
      "【重要】\n" +
      "- 推測しない。根拠があるものだけ。\n" +
      "- 1行は短く。重複は統合。\n" +
      "- 型番/数値/単位は原文どおり。\n" +
      "- 出力はJSONのみ。";

    const response = await client.responses.create({
      model: INSPECTION_MODEL,
      reasoning: { effort: INSPECTION_REASONING },
      text: { verbosity: INSPECTION_VERBOSITY },
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: sys + "\n\nJSONで返してください。" },
            { type: "input_file", file_id: uploaded.id },
            {
              type: "input_text",
              text:
                "出力JSONスキーマ:\n" +
                "{\n" +
                '  "specText": string[],\n' +
                '  "opText": string[],\n' +
                '  "accText": string[],\n' +
                '  "warnings": string[]\n' +
                "}\n",
            },
          ],
        },
      ],
    });

    const text = (response.output_text || "").trim();

    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      const first = text.indexOf("{");
      const last = text.lastIndexOf("}");
      if (first >= 0 && last > first) obj = JSON.parse(text.slice(first, last + 1));
      else throw new Error("AIParseError: JSON解析に失敗");
    }

    return {
      specText: normalizeStringArray(obj.specText),
      opText: normalizeStringArray(obj.opText),
      accText: normalizeStringArray(obj.accText),
      aiWarnings: normalizeStringArray(obj.warnings),
    };
  } finally {
    try {
      if (uploaded?.id) await client.files.del(uploaded.id);
    } catch {}
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-filename, x-selected-labels, x-model, x-product"
  );

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // ②：選択リスト取得（HTML用）
    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const op = url.searchParams.get("op") || "";
      if (op !== "select_options") {
        return res.status(400).json({ error: "BadRequest", detail: "op が不正" });
      }

      const templateBuf = await downloadTemplateExcelBuffer();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(templateBuf);

      const wsList = wb.getWorksheet("検品項目リスト");
      if (!wsList) throw new Error("SheetError: 検品項目リスト が見つかりません");

      const options = extractSelectOptions(wsList);
      return res.status(200).json({ options });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });

    const ct = String(req.headers["content-type"] || "");
    if (!ct.includes("application/pdf")) {
      return res.status(400).json({ error: "BadRequest", detail: "Content-Type は application/pdf" });
    }

    const pdfBuffer = await readRawBody(req);

    const hdrLabels = req.headers["x-selected-labels"];
    const selectedLabels = hdrLabels
      ? normalizeStringArray(JSON.parse(decodeURIComponent(String(hdrLabels))))
      : [];

    const pdfFilename = req.headers["x-filename"]
      ? decodeURIComponent(String(req.headers["x-filename"]))
      : "manual.pdf";

    const model = safeFilePart(decodeURIComponent(String(req.headers["x-model"] || "")));
    const product = safeFilePart(decodeURIComponent(String(req.headers["x-product"] || "")));

    const warnings = [];

    // PDF→AI抽出
    const { specText, opText, accText, aiWarnings } = await extractFromPdfToArrays({
      filename: pdfFilename,
      pdfBuffer,
    });
    for (const w of aiWarnings) warnings.push(`AI抽出: ${w}`);

    // テンプレ取得→Excelロード
    const templateBuf = await downloadTemplateExcelBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(templateBuf);

    const wsMain = wb.getWorksheet("検品リスト");
    const wsList = wb.getWorksheet("検品項目リスト");
    if (!wsMain) throw new Error("SheetError: 検品リスト が見つかりません");
    if (!wsList) throw new Error("SheetError: 検品項目リスト が見つかりません");

    // マーカー
    const mSpec = findMarkerRow(wsMain, "__INS_SPEC__");
    const mOp = findMarkerRow(wsMain, "__INS_OP__");
    const mAcc = findMarkerRow(wsMain, "__INS_ACC__");
    const mSel = findMarkerRow(wsMain, "__INS_SELECT__");

    if (!mSpec) throw new Error("MarkerError: __INS_SPEC__ が見つかりません");
    if (!mOp) throw new Error("MarkerError: __INS_OP__ が見つかりません");
    if (!mAcc) throw new Error("MarkerError: __INS_ACC__ が見つかりません");
    if (!mSel) throw new Error("MarkerError: __INS_SELECT__ が見つかりません");

    // ①：罫線維持（K列=11まで固定）
    const STYLE_COLS = 11;

    // 下から差し込み
    const tasks = [
      { row: mSel, type: "select" },
      { row: mAcc, type: "acc" },
      { row: mOp, type: "op" },
      { row: mSpec, type: "spec" },
    ].sort((a, b) => b.row - a.row);

    for (const t of tasks) {
      const r = t.row;
      const styleSnap = cloneRowStyle(wsMain.getRow(r));

      if (t.type === "spec") {
        const rows = buildExcerptRows("仕様", specText);
        wsMain.spliceRows(r, 1, ...rows);
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, STYLE_COLS);
        continue;
      }

      if (t.type === "op") {
        const rows = buildExcerptRows("動作", opText);
        wsMain.spliceRows(r, 1, ...rows);
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, STYLE_COLS);
        continue;
      }

      if (t.type === "acc") {
        const rows = buildExcerptRows("付属品", accText);
        wsMain.spliceRows(r, 1, ...rows);
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, STYLE_COLS);
        continue;
      }

      if (t.type === "select") {
        const picked = buildSelectedRows(wsList, selectedLabels, warnings);
        if (picked.length === 0) {
          wsMain.spliceRows(r, 1);
          continue;
        }
        wsMain.spliceRows(r, 1, ...picked);
        for (let i = 0; i < picked.length; i++) applyRowStyle(wsMain, r + i, styleSnap, STYLE_COLS);
      }
    }

    // ②：必要シートのみ残す
    keepOnlySheets(wb);

    const outBuf = await wb.xlsx.writeBuffer();

    // ④：ファイル名
    const fnModel = model || "型番未入力";
    const fnProduct = product || "製品名未入力";
    const outName = `検品リスト_${fnModel}_${fnProduct}.xlsx`;

    res.setHeader("X-Warnings", encodeURIComponent(JSON.stringify(warnings)));
    res.setHeader("X-Warnings-Count", String(warnings.length));
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(outName)}`);
    return res.status(200).send(Buffer.from(outBuf));
  } catch (e) {
    console.error("[inspection] error", e);
    return res.status(500).json({
      error: "InspectionError",
      detail: e?.message ? String(e.message) : "UnknownError",
    });
  }
}
