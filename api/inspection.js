// api/inspection.js
// Step1: 検品リスト生成API（日本語Excelのみ）
// - SharePointからテンプレExcel取得（siteId/driveId/itemId）
// - 検品リスト シートのマーカー行に差し込み
// - 選択ラベルは「検品項目リスト!A列 完全一致」で抽出し、B列以降をコピー
// - 不一致ラベルは warnings で返す（X-Warnings ヘッダ）

import ExcelJS from "exceljs";

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
  if (!tokenData.access_token) throw new Error("TokenError: " + JSON.stringify(tokenData));
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

function normalizeStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (x ?? "").toString().trim())
    .filter((x) => x.length > 0);
}

function parseRequestBody(req) {
  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  return {
    selectedLabels: normalizeStringArray(body.selectedLabels),
    specText: normalizeStringArray(body.specText),
    opText: normalizeStringArray(body.opText),
    accText: normalizeStringArray(body.accText),
  };
}

function buildExcerptRows(kindLabel, lines) {
  return lines.map((line) => {
    const values = [];
    values[1] = "";           // A
    values[2] = kindLabel;    // B
    values[3] = line;         // C
    values[5] = "";           // E
    values[6] = 1;            // F
    values[7] = "必須";       // G
    return values;
  });
}

function getLastUsedCol(row) {
  let last = 1;
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    const v = cell.value;
    if (v !== null && v !== undefined && v !== "") last = Math.max(last, col);
  });
  return last;
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

export default async function handler(req, res) {
  // CORS/OPTIONS（既存APIと同等）
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
    res.status(405).json({ error: "MethodNotAllowed" });
    return;
  }

  try {
    const { selectedLabels, specText, opText, accText } = parseRequestBody(req);

    const templateBuf = await downloadTemplateExcelBuffer();

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(templateBuf);

    const wsMain = wb.getWorksheet("検品リスト");
    const wsList = wb.getWorksheet("検品項目リスト");

    if (!wsMain) throw new Error("SheetError: 検品リスト が見つかりません");
    if (!wsList) throw new Error("SheetError: 検品項目リスト が見つかりません");

    const mSpec = findMarkerRow(wsMain, "__INS_SPEC__");
    const mOp = findMarkerRow(wsMain, "__INS_OP__");
    const mAcc = findMarkerRow(wsMain, "__INS_ACC__");
    const mSel = findMarkerRow(wsMain, "__INS_SELECT__");

    if (!mSpec) throw new Error("MarkerError: __INS_SPEC__ が見つかりません");
    if (!mOp) throw new Error("MarkerError: __INS_OP__ が見つかりません");
    if (!mAcc) throw new Error("MarkerError: __INS_ACC__ が見つかりません");
    if (!mSel) throw new Error("MarkerError: __INS_SELECT__ が見つかりません");

    const warnings = [];

    // spliceRowsで行番号がズレるので、下から処理
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
        if (rows.length === 0) { wsMain.spliceRows(r, 1); continue; }
        wsMain.spliceRows(r, 1, ...rows);
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, 7);
        continue;
      }

      if (t.type === "op") {
        const rows = buildExcerptRows("動作", opText);
        if (rows.length === 0) { wsMain.spliceRows(r, 1); continue; }
        wsMain.spliceRows(r, 1, ...rows);
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, 7);
        continue;
      }

      if (t.type === "acc") {
        const rows = buildExcerptRows("付属品", accText);
        if (rows.length === 0) { wsMain.spliceRows(r, 1); continue; }
        wsMain.spliceRows(r, 1, ...rows);
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, 7);
        continue;
      }

      if (t.type === "select") {
        const picked = buildSelectedRowsFromListSheet(wsList, selectedLabels, warnings);
        if (picked.length === 0) { wsMain.spliceRows(r, 1); continue; }

        wsMain.spliceRows(r, 1, ...picked.map((x) => x.values));

        for (let i = 0; i < picked.length; i++) {
          const upTo = Math.max(7, picked[i].lastCol);
          applyRowStyle(wsMain, r + i, styleSnap, upTo);
        }
        continue;
      }
    }

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
    res.status(200).send(Buffer.from(outBuf));
  } catch (e) {
    console.error("[inspection] error", e);
    res.status(500).json({ error: "InspectionError", detail: e?.message ? String(e.message) : "UnknownError" });
  }
}
