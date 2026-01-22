// api/inspection.js
// PDF（バイナリPOST）→ OpenAIで「仕様/動作/付属品」抽出 → テンプレExcelに差し込み → 日本語Excel返却
//
// 仕様(確定版)の差し込みルール：
// - マーカー行（A列完全一致）: __INS_SPEC__/__INS_OP__/__INS_ACC__/__INS_SELECT__
// - マニュアル抜粋：B=区分, C=本文, E=空欄, F=1, G=必須
// - 選択リスト：検品項目リスト!A列 完全一致で、A列はコピーせずB以降を元シート順でコピー
// - 未一致ラベル：warningsへ（エラーにしない）

import ExcelJS from "exceljs";
import OpenAI from "openai";

// ★ PDFバイナリ受信のため（重要）
export const config = {
  api: { bodyParser: false },
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const INSPECTION_MODEL = process.env.INSPECTION_MODEL || "gpt-5.2";
const INSPECTION_REASONING = process.env.INSPECTION_REASONING || "medium";
const INSPECTION_VERBOSITY = process.env.INSPECTION_VERBOSITY || "low";

// ===== raw body =====
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ===== SharePoint (Microsoft Graph) =====
async function getAccessToken() {
  const tenantId = process.env.MANUAL_TENANT_ID;
  const clientId = process.env.MANUAL_CLIENT_ID;
  const clientSecret = process.env.MANUAL_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "ConfigError: MANUAL_TENANT_ID / MANUAL_CLIENT_ID / MANUAL_CLIENT_SECRET が不足"
    );
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
  if (!tokenData.access_token) {
    throw new Error("TokenError: " + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

async function downloadTemplateExcelBuffer() {
  const siteId = process.env.INSPECTION_SITE_ID;
  const driveId = process.env.INSPECTION_DRIVE_ID;
  const itemId = process.env.INSPECTION_TEMPLATE_ITEM_ID;

  if (!siteId || !driveId || !itemId) {
    throw new Error(
      "ConfigError: INSPECTION_SITE_ID / INSPECTION_DRIVE_ID / INSPECTION_TEMPLATE_ITEM_ID が不足"
    );
  }

  const accessToken = await getAccessToken();
  const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/items/${itemId}/content`;

  const graphRes = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

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

function getLastUsedCol(row) {
  let last = 1;
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    const v = cell.value;
    if (v !== null && v !== undefined && v !== "") last = Math.max(last, col);
  });
  return last;
}

function normalizeStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (x ?? "").toString().trim())
    .filter((x) => x.length > 0);
}

function buildExcerptRows(kindLabel, lines) {
  return lines.map((line) => {
    const values = [];
    values[1] = ""; // A
    values[2] = kindLabel; // B
    values[3] = line; // C
    values[5] = ""; // E
    values[6] = 1; // F
    values[7] = "必須"; // G
    return values;
  });
}

function buildSelectedRowsFromListSheet(wsList, selectedLabels, warnings) {
  const selectedSet = new Set(selectedLabels);
  const foundSet = new Set();

  const rows = [];
  const max = wsList.rowCount || 0;

  for (let r = 1; r <= max; r++) {
    const a = (wsList.getCell(r, 1).value ?? "").toString().trim();
    if (!a) continue;
    if (!selectedSet.has(a)) continue;

    foundSet.add(a);

    const row = wsList.getRow(r);
    const lastCol = Math.max(2, getLastUsedCol(row)); // 最低Bまで
    const values = [];
    values[1] = ""; // Aはコピーしない

    for (let c = 2; c <= lastCol; c++) {
      values[c] = wsList.getCell(r, c).value;
    }
    rows.push({ values, lastCol });
  }

  for (const label of selectedLabels) {
    if (!foundSet.has(label)) warnings.push(`未一致ラベル: ${label}`);
  }

  return rows;
}

// ===== OpenAI: PDF→抽出 =====
async function extractFromPdfToArrays({ filename, file_data }) {
  if (!filename || !file_data) {
    throw new Error("InputError: pdf.filename / pdf.file_data が不足");
  }

  // 出力は「配列のみ」：Excel差し込み用
  const sys =
    "あなたは日本語の技術文書から検品リスト用の抜粋を作る担当です。\n" +
    "与えられたPDFを読み、次の3区分の箇条書き（短文）を抽出してください。\n" +
    "- 仕様（サイズ/材質/電源/定格/温度/互換などの仕様）\n" +
    "- 動作（操作手順・挙動・表示・注意点のうち検品で確認すべき内容）\n" +
    "- 付属品（同梱物）\n\n" +
    "【重要】\n" +
    "- 推測しない。PDFに根拠があるものだけ。\n" +
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
          {
            type: "input_file",
            filename,
            file_data,
          },
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
    // JSON以外が混ざった時の救済（最小）
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      obj = JSON.parse(text.slice(first, last + 1));
    } else {
      throw new Error("AIParseError: JSON解析に失敗");
    }
  }

  return {
    specText: normalizeStringArray(obj.specText),
    opText: normalizeStringArray(obj.opText),
    accText: normalizeStringArray(obj.accText),
    aiWarnings: normalizeStringArray(obj.warnings),
  };
}

export default async function handler(req, res) {
  // CORS（既存APIと同等）
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-filename, x-selected-labels"
  );

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });

  try {
    const ct = String(req.headers["content-type"] || "");

    let selectedLabels = [];
    let pdfFilename = "manual.pdf";
    let pdfBase64 = "";

    if (ct.includes("application/pdf")) {
      // ★ バイナリ直受け（413回避）
      const raw = await readRawBody(req);

      const hdrLabels = req.headers["x-selected-labels"];
      if (hdrLabels) {
        selectedLabels = JSON.parse(decodeURIComponent(String(hdrLabels)));
      }

      const hdrName = req.headers["x-filename"];
      if (hdrName) {
        pdfFilename = decodeURIComponent(String(hdrName));
      }

      pdfBase64 = raw.toString("base64");
    } else {
      // 互換：JSON送信が来た場合（保険）
      const body =
        typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      selectedLabels = normalizeStringArray(body.selectedLabels);

      const pdf = body.pdf || {};
      pdfFilename = String(pdf.filename || "manual.pdf");
      pdfBase64 = String(pdf.file_data || "");
    }

    const warnings = [];

    // 1) PDF→AI抽出
    const { specText, opText, accText, aiWarnings } = await extractFromPdfToArrays({
      filename: pdfFilename,
      file_data: pdfBase64,
    });
    for (const w of aiWarnings) warnings.push(`AI抽出: ${w}`);

    // 2) テンプレ取得
    const templateBuf = await downloadTemplateExcelBuffer();

    // 3) Excelロード
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(templateBuf);

    const wsMain = wb.getWorksheet("検品リスト");
    const wsList = wb.getWorksheet("検品項目リスト");
    if (!wsMain) throw new Error("SheetError: 検品リスト が見つかりません");
    if (!wsList) throw new Error("SheetError: 検品項目リスト が見つかりません");

    // 4) マーカー検出（欠落は即エラー）
    const mSpec = findMarkerRow(wsMain, "__INS_SPEC__");
    const mOp = findMarkerRow(wsMain, "__INS_OP__");
    const mAcc = findMarkerRow(wsMain, "__INS_ACC__");
    const mSel = findMarkerRow(wsMain, "__INS_SELECT__");

    if (!mSpec) throw new Error("MarkerError: __INS_SPEC__ が見つかりません");
    if (!mOp) throw new Error("MarkerError: __INS_OP__ が見つかりません");
    if (!mAcc) throw new Error("MarkerError: __INS_ACC__ が見つかりません");
    if (!mSel) throw new Error("MarkerError: __INS_SELECT__ が見つかりません");

    // 5) 下から差し込み（行ズレ対策）
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
        if (rows.length === 0) {
          wsMain.spliceRows(r, 1);
          warnings.push("AI抽出: 仕様が0件");
          continue;
        }
        wsMain.spliceRows(r, 1, ...rows);
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, 7);
        continue;
      }

      if (t.type === "op") {
        const rows = buildExcerptRows("動作", opText);
        if (rows.length === 0) {
          wsMain.spliceRows(r, 1);
          warnings.push("AI抽出: 動作が0件");
          continue;
        }
        wsMain.spliceRows(r, 1, ...rows);
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, 7);
        continue;
      }

      if (t.type === "acc") {
        const rows = buildExcerptRows("付属品", accText);
        if (rows.length === 0) {
          wsMain.spliceRows(r, 1);
          warnings.push("AI抽出: 付属品が0件");
          continue;
        }
        wsMain.spliceRows(r, 1, ...rows);
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, 7);
        continue;
      }

      if (t.type === "select") {
        const picked = buildSelectedRowsFromListSheet(wsList, selectedLabels, warnings);
        if (picked.length === 0) {
          wsMain.spliceRows(r, 1);
          continue;
        }

        wsMain.spliceRows(r, 1, ...picked.map((x) => x.values));
        for (let i = 0; i < picked.length; i++) {
          const upTo = Math.max(7, picked[i].lastCol);
          applyRowStyle(wsMain, r + i, styleSnap, upTo);
        }
      }
    }

    // 6) 書き出し
    const outBuf = await wb.xlsx.writeBuffer();

    res.setHeader("X-Warnings", encodeURIComponent(JSON.stringify(warnings)));
    res.setHeader("X-Warnings-Count", String(warnings.length));
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename*=UTF-8''%E6%A4%9C%E5%93%81%E3%83%AA%E3%82%B9%E3%83%88_%E6%97%A5%E6%9C%AC%E8%AA%9E.xlsx"
    );
    return res.status(200).send(Buffer.from(outBuf));
  } catch (e) {
    console.error("[inspection] error", e);
    return res.status(500).json({
      error: "InspectionError",
      detail: e?.message ? String(e.message) : "UnknownError",
    });
  }
}
