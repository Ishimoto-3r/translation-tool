// api/inspection.js（全文）
// op=select_options : GET  選択リスト（検品項目リスト A列=選択リスト のC列）を返す
// op=extract_text   : POST {filename,text} → AI抽出（仕様/動作/付属品 + 型番/製品名）
// op=generate_text  : POST {filename,text,selectedLabels,aiPicked,model,product} → Excel生成（必要シートのみ）
//
// 注意：フロント側でPDF→text抽出（pdf.js）済みテキストを送る想定（413回避）
// 既存ツールと同じく SharePoint は ReadOnly

import ExcelJS from "exceljs";
import OpenAI from "openai";

// ===== OpenAI =====
const INSPECTION_MODEL = process.env.INSPECTION_MODEL || process.env.MODEL_MANUAL_CHECK || "gpt-5.2";
const INSPECTION_REASONING = process.env.INSPECTION_REASONING || process.env.MANUAL_CHECK_REASONING || "medium";
const INSPECTION_VERBOSITY = process.env.INSPECTION_VERBOSITY || process.env.MANUAL_CHECK_VERBOSITY || "low";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

function pickSharePointUrlEnv() {
  // 既存ツール互換（どれか1つ入っていればOK）
  const candidates = [
    process.env.MANUAL_DATABASE_URL,
    process.env.MANUAL_SHAREPOINT_URL,
    process.env.SHAREPOINT_FILE_URL,
    process.env.SP_FILE_URL,
    process.env.DATABASE_XLSX_URL,
    process.env.MANUAL_SHAREPOINT_FILE_URL, // kensho.js 互換
  ].filter(Boolean);

  return candidates.length ? candidates[0] : "";
}

async function downloadTemplateExcelBuffer() {
  // 優先：ID指定（設計方針）
  const siteId = process.env.INSPECTION_SITE_ID;
  const driveId = process.env.INSPECTION_DRIVE_ID;
  const itemId = process.env.INSPECTION_TEMPLATE_ITEM_ID;

  const accessToken = await getAccessToken();

  if (siteId && driveId && itemId) {
    const url = `https://graph.microsoft.com/v1.0/sites/${siteId}/drives/${driveId}/items/${itemId}/content`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`GraphError(${r.status}): ${t}`);
    }
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  }

  // フォールバック：ShareリンクURL（既存ツール互換）
  const fileUrl = pickSharePointUrlEnv();
  if (!fileUrl) {
    throw new Error(
      "ConfigError: SharePoint URL env が不足（候補: MANUAL_DATABASE_URL / MANUAL_SHAREPOINT_URL / SHAREPOINT_FILE_URL / SP_FILE_URL / DATABASE_XLSX_URL / MANUAL_SHAREPOINT_FILE_URL）"
    );
  }

  const shareId = Buffer.from(fileUrl).toString("base64").replace(/=+$/, "");
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/shares/u!${shareId}/driveItem/content`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GraphError(${r.status}): ${t}`);
  }

  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

// ===== Utils =====
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function normalizeStringArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .map((x) => (x == null ? "" : String(x)).trim())
      .filter((x) => x.length > 0);
  }
  return [String(v).trim()].filter((x) => x.length > 0);
}

function safeFilePart(s) {
  return (s || "")
    .toString()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function isOperationNoise(s) {
  const t = (s || "").toString().trim();
  if (!t) return true;
  if (/^(安全|注意|警告|禁止|中止|危険)/.test(t)) return true;
  if (/安全.*取扱.*注意/.test(t)) return true;
  if (/(使用しない|使用を中止|しないでください|禁止|分解|改造|修理しない|感電|火災|高温|濡れた手|水にかけない)/.test(t)) return true;
  return false;
}

function normalizeAccessoriesEnsureManual(list) {
  const arr = normalizeStringArray(list);
  // 表記ブレの追記は不要（ユーザー指示）→ ただし「説明書」系がなければ追加する
  const hasManual = arr.some((x) => /取扱|取り扱い|説明書|マニュアル/.test(x));
  if (!hasManual) arr.push("取扱説明書");
  return arr;
}

// ===== Select options =====
async function getSelectOptionsFromTemplate() {
  const buf = await downloadTemplateExcelBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  const ws = wb.getWorksheet("検品項目リスト");
  if (!ws) throw new Error("SheetError: 検品項目リスト が見つかりません");

  // A列=「選択リスト」の行の C列を返す
  const options = [];
  ws.eachRow((row, rowNumber) => {
    const a = (row.getCell(1).value ?? "").toString().trim();
    if (a !== "選択リスト") return;

    const cVal = row.getCell(3).value;
    const c = (cVal ?? "").toString().trim();
    if (c) options.push(c);
  });

  // 重複排除（順序維持）
  const seen = new Set();
  return options.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

// ===== AI Extract (text mode) =====
async function extractFromTextToPayload({ filename, text }) {
  const sys =
    "あなたは日本語の取扱説明書（技術文書）から、検品リスト用の抜粋を作る担当です。\n" +
    "次の情報を抽出してください。\n\n" +
    "A) 検品項目（短文）を3区分で漏れなく\n" +
    "  - 仕様（specText）\n" +
    "  - 動作（opText）※安全/注意/警告/禁止/中止などの注意喚起は含めない\n" +
    "  - 付属品（accText）※取扱説明書は常に候補に入れる\n\n" +
    "B) 型番（model）と製品名（product）\n\n" +
    "【動作のグルーピング】\n" +
    "動作（opText）については、関連する項目のまとまりごとに「タイトル」を作って opGroups にまとめる。\n" +
    "タイトルは短く要点のみ。タイトルもチェック対象として使うため、抽象的すぎる語は避ける。\n\n" +
    "出力はJSONのみ。";

  const response = await client.responses.create({
    model: INSPECTION_MODEL,
    reasoning: { effort: INSPECTION_REASONING },
    text: { verbosity: INSPECTION_VERBOSITY },
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: sys },
          { type: "input_text", text: `ファイル名: ${filename}` },
          { type: "input_text", text: "以下がPDFから抽出した本文テキストです。\n---\n" + text.slice(0, 250000) },
          {
            type: "input_text",
            text:
              "出力JSONスキーマ:\n" +
              "{\n" +
              '  "model": string,\n' +
              '  "product": string,\n' +
              '  "specText": string[],\n' +
              '  "opText": string[],\n' +
              '  "opGroups": { "title": string, "items": string[] }[],\n' +
              '  "accText": string[]\n' +
              "}\n",
          },
        ],
      },
    ],
  });

  const out = (response.output_text || "").trim();
  let obj;
  try {
    obj = JSON.parse(out);
  } catch {
    const first = out.indexOf("{");
    const last = out.lastIndexOf("}");
    if (first >= 0 && last > first) obj = JSON.parse(out.slice(first, last + 1));
    else throw new Error("AIParseError: JSON解析に失敗");
  }

  const specText = normalizeStringArray(obj.specText);

  const opText = normalizeStringArray(obj.opText).filter((x) => !isOperationNoise(x));

  let opGroups = [];
  if (Array.isArray(obj.opGroups)) {
    const tmp = [];
    for (const g of obj.opGroups) {
      const titleRaw = (g?.title ?? "").toString().trim();
      const title = titleRaw && !isOperationNoise(titleRaw) ? titleRaw : "";
      const items = normalizeStringArray(g?.items).filter((x) => !isOperationNoise(x));
      if (!title && items.length === 0) continue;
      tmp.push({ title, items });
    }
    opGroups = tmp;
  }

  const accText = normalizeAccessoriesEnsureManual(obj.accText);

  return {
    model: (obj.model ?? "").toString().trim(),
    product: (obj.product ?? "").toString().trim(),
    specText,
    opText,
    opGroups,
    accText,
  };
}

// ===== Excel generation helpers =====
function findMarkerRow(ws, marker) {
  const max = ws.rowCount || 0;
  for (let r = 1; r <= max; r++) {
    const v = ws.getCell(r, 1).value;
    const s = (v ?? "").toString().trim();
    if (s === marker) return r;
  }
  return 0;
}

function cloneRowStyle(row) {
  // セル単位で必要（border等）
  const snap = {
    rowHeight: row.height,
    cells: {},
  };
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    snap.cells[colNumber] = {
      style: { ...cell.style },
      numFmt: cell.numFmt,
      alignment: cell.alignment ? { ...cell.alignment } : undefined,
      border: cell.border ? { ...cell.border } : undefined,
      fill: cell.fill ? { ...cell.fill } : undefined,
      font: cell.font ? { ...cell.font } : undefined,
      protection: cell.protection ? { ...cell.protection } : undefined,
    };
  });
  return snap;
}

function applyRowStyle(ws, rowNumber, styleSnap, maxCols) {
  const row = ws.getRow(rowNumber);
  if (styleSnap.rowHeight != null) row.height = styleSnap.rowHeight;

  for (let c = 1; c <= maxCols; c++) {
    const cell = row.getCell(c);
    const s = styleSnap.cells[c];
    if (!s) continue;

    // ExcelJSは style を丸ごとコピーすると一部欠けることがあるので個別に
    if (s.font) cell.font = { ...s.font };
    if (s.alignment) cell.alignment = { ...s.alignment };
    if (s.border) cell.border = { ...s.border };
    if (s.fill) cell.fill = { ...s.fill };
    if (s.protection) cell.protection = { ...s.protection };
    if (s.numFmt) cell.numFmt = s.numFmt;
  }
}

function buildExcerptRows(kind, pickedArr) {
  // kind: "仕様" / "動作" / "付属品"
  // pickedArr: [{text,isTitle}]
  // 既定列: B=区分, C=本文, E空, F=1, G=必須
  const rows = [];
  for (const p of pickedArr) {
    const text = (p?.text ?? "").toString().trim();
    if (!text) continue;

    // 動作のノイズはここで最終除外（念のため）
    if (kind === "動作" && isOperationNoise(text)) continue;

    rows.push({
      isTitle: !!p.isTitle,
      values: {
        2: kind,
        3: text,
        6: 1,
        7: "必須",
      },
    });
  }
  return rows;
}

function readSelectMapFromWs(wsList) {
  // 検品項目リストの A列=ラベル（完全一致）→ B以降の行データ（Aはコピーしない）
  const map = new Map();
  wsList.eachRow((row) => {
    const a = (row.getCell(1).value ?? "").toString().trim();
    if (!a) return;

    // A列はコピーしない：B列以降を values へ
    const obj = {};
    for (let c = 2; c <= 11; c++) {
      const v = row.getCell(c).value;
      if (v != null && v !== "") obj[c] = v;
    }
    map.set(a, obj);
  });
  return map;
}

function buildSelectedRows(wsList, selectedLabels, warnings) {
  const map = readSelectMapFromWs(wsList);
  const out = [];
  for (const label of selectedLabels) {
    if (!map.has(label)) {
      warnings.push(`未一致ラベル: ${label}`);
      continue;
    }
    out.push(map.get(label));
  }
  return out;
}

function splitAiPicked(aiPicked) {
  const spec = [];
  const op = [];
  const acc = [];

  for (const p of aiPicked || []) {
    const kind = (p?.kind ?? "").toString().trim();
    const text = (p?.text ?? "").toString();
    const isTitle = !!p?.isTitle;

    if (!kind || !text.trim()) continue;

    if (kind === "仕様") spec.push({ text, isTitle: false });
    else if (kind === "動作") op.push({ text, isTitle });
    else if (kind === "付属品") acc.push({ text, isTitle: false });
  }

  return { spec, op, acc };
}

function forceCenterAlignColumnG(ws) {
  const col = 7; // G
  const max = ws.rowCount || 0;

  // 14行目以降のみ
  for (let r = 14; r <= max; r++) {
    const cell = ws.getCell(r, col);
    const cur = cell.alignment || {};
    cell.alignment = { ...cur, horizontal: "center", vertical: "middle" };
  }
}

function applyGlobalFont(workbook) {
  // 全シート全セル：游ゴシック 10
  workbook.eachSheet((ws) => {
    const maxRow = ws.rowCount || 0;
    const maxCol = ws.columnCount || 0;

    for (let r = 1; r <= maxRow; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= maxCol; c++) {
        const cell = row.getCell(c);
        const cur = cell.font || {};
        cell.font = {
          ...cur,
          name: "游ゴシック",
          size: 10,
        };
      }
    }
  });
}

function keepOnlySheets(workbook) {
  const keep = new Set(["検品リスト", "検品用画像", "検品外観基準"]);
  const toRemove = [];
  workbook.eachSheet((ws) => {
    if (!keep.has(ws.name)) toRemove.push(ws.id);
  });
  for (const id of toRemove) workbook.removeWorksheet(id);
}

function clearBoldUnderlineForOperationTitles(wsMain, insertedRowRanges) {
  // タイトルをExcelに入れる時は太字解除・下線なし（指定）
  // insertedRowRanges: [{start, end, kind}]  kind="動作"
  for (const seg of insertedRowRanges) {
    if (seg.kind !== "動作") continue;
    for (let r = seg.start; r <= seg.end; r++) {
      const kindCell = wsMain.getCell(r, 2).value;
      if ((kindCell ?? "").toString().trim() !== "動作") continue;

      // タイトル判定：aiPickedの isTitle を反映できないので、
      // 「動作」挿入ブロック内でタイトル行にだけフラグ列を使うと理想だが、
      // 今回は簡易に「太字になっているもの」を解除する方式にする。
      const cellC = wsMain.getCell(r, 3);
      const f = cellC.font || {};
      if (f.bold || f.underline) {
        cellC.font = { ...f, bold: false, underline: false };
      }
    }
  }
}

async function generateExcelFromHeadersOnly(req, res, textModePayload) {
  // textModePayload: { filename, selectedLabels, aiPicked, model, product }
  try {
    const warnings = [];

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

    const STYLE_COLS = 11;

    const selectedLabels = Array.isArray(textModePayload.selectedLabels) ? textModePayload.selectedLabels : [];
    const aiPicked = Array.isArray(textModePayload.aiPicked) ? textModePayload.aiPicked : [];

    const { spec, op, acc } = splitAiPicked(aiPicked);

    // 置換は下から（行ズレ回避）
    const tasks = [
      { row: mSel, type: "select" },
      { row: mAcc, type: "acc" },
      { row: mOp, type: "op" },
      { row: mSpec, type: "spec" },
    ].sort((a, b) => b.row - a.row);

    const insertedRanges = []; // タイトル装飾解除のため

    for (const t of tasks) {
      const r = t.row;
      const styleSnap = cloneRowStyle(wsMain.getRow(r));

      if (t.type === "spec") {
        const rows = buildExcerptRows("仕様", spec);
        if (rows.length === 0) {
          wsMain.spliceRows(r, 1);
          continue;
        }
        wsMain.spliceRows(r, 1, ...rows.map((x) => x.values));
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, STYLE_COLS);
        insertedRanges.push({ kind: "仕様", start: r, end: r + rows.length - 1 });
        continue;
      }

      if (t.type === "op") {
        const rows = buildExcerptRows("動作", op);
        if (rows.length === 0) {
          wsMain.spliceRows(r, 1);
          continue;
        }
        wsMain.spliceRows(r, 1, ...rows.map((x) => x.values));
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, STYLE_COLS);
        insertedRanges.push({ kind: "動作", start: r, end: r + rows.length - 1 });
        continue;
      }

      if (t.type === "acc") {
        // 付属品は「取扱説明書」を候補として必ず含める（未チェックでも候補にいるだけ）
        // ただし aiPicked にはチェックされたものだけが来る想定なので、ここで自動追加はしない
        const rows = buildExcerptRows("付属品", acc);
        if (rows.length === 0) {
          wsMain.spliceRows(r, 1);
          continue;
        }
        wsMain.spliceRows(r, 1, ...rows.map((x) => x.values));
        for (let i = 0; i < rows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, STYLE_COLS);
        insertedRanges.push({ kind: "付属品", start: r, end: r + rows.length - 1 });
        continue;
      }

      if (t.type === "select") {
        const pickedRows = buildSelectedRows(wsList, selectedLabels, warnings);
        if (pickedRows.length === 0) {
          wsMain.spliceRows(r, 1);
          continue;
        }
        wsMain.spliceRows(r, 1, ...pickedRows);
        for (let i = 0; i < pickedRows.length; i++) applyRowStyle(wsMain, r + i, styleSnap, STYLE_COLS);
        insertedRanges.push({ kind: "select", start: r, end: r + pickedRows.length - 1 });
      }
    }

    // G列センター（14行目以降のみ）
    forceCenterAlignColumnG(wsMain);

    // 動作タイトルの太字/下線をExcelでは解除
    clearBoldUnderlineForOperationTitles(wsMain, insertedRanges);

    // 必要シートのみ
    keepOnlySheets(wb);

    // フォント統一
    applyGlobalFont(wb);

    const outBuf = await wb.xlsx.writeBuffer();

    const fnModel = safeFilePart(textModePayload.model || "型番未入力");
    const fnProduct = safeFilePart(textModePayload.product || "製品名未入力");
    const outName = `検品リスト_${fnModel}_${fnProduct}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(outName)}`);
    res.setHeader("x-warnings", encodeURIComponent(JSON.stringify(warnings)));

    return res.status(200).send(Buffer.from(outBuf));
  } catch (e) {
    console.error("[inspection generate_text] error", e);
    return res.status(500).json({
      error: "InspectionError",
      detail: e?.message ? String(e.message) : "UnknownError",
    });
  }
}

// ===== Handler =====
export default async function handler(req, res) {
  // CORS（既存ツールと同型）
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const op = (req.query?.op ?? "").toString();

    if (req.method === "GET") {
      if (op === "select_options") {
        const options = await getSelectOptionsFromTemplate();
        return res.status(200).json({ options });
      }
      return res.status(400).json({ error: "BadRequest", detail: "Unknown op" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "MethodNotAllowed" });
    }

    // ===== extract_text =====
    if (op === "extract_text") {
      const bodyBuf = await readRawBody(req);
      const body = JSON.parse(bodyBuf.toString("utf-8"));

      const filename = (body.filename ?? "manual.pdf").toString();
      const text = (body.text ?? "").toString();

      if (!text.trim()) {
        return res.status(400).json({ error: "BadRequest", detail: "text が空です" });
      }

      const payload = await extractFromTextToPayload({ filename, text });
      return res.status(200).json(payload);
    }

    // ===== generate_text =====
    if (op === "generate_text") {
      const bodyBuf = await readRawBody(req);
      const body = JSON.parse(bodyBuf.toString("utf-8"));

      const filename = (body.filename ?? "manual.pdf").toString();
      const text = (body.text ?? "").toString(); // ここでは使用しない（将来拡張用）
      const selectedLabels = Array.isArray(body.selectedLabels) ? body.selectedLabels : [];
      const aiPicked = Array.isArray(body.aiPicked) ? body.aiPicked : [];
      const model = (body.model ?? "").toString();
      const product = (body.product ?? "").toString();

      if (!text.trim()) {
        return res.status(400).json({ error: "BadRequest", detail: "text が空です" });
      }

      return await generateExcelFromHeadersOnly(req, res, {
        filename,
        selectedLabels,
        aiPicked,
        model,
        product,
      });
    }

    return res.status(400).json({ error: "BadRequest", detail: "Unknown op" });
  } catch (e) {
    console.error("[inspection] error", e);
    return res.status(500).json({
      error: "InspectionError",
      detail: e?.message ? String(e.message) : "UnknownError",
    });
  }
}
