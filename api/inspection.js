// api/inspection.js（全文置き換え）
// op=meta     : SharePointテンプレから「選択リスト」（検品項目リスト A=選択リスト の C列）を返す
// op=extract  : PDFテキスト（ブラウザ抽出）から、型番/製品名/仕様/動作(タイトル+items)/付属品 をAI抽出
// op=generate : テンプレExcelへ差し込み → 余計なシート削除 → 書体/サイズ/揃え調整 → base64で返す

import ExcelJS from "exceljs";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Graph token =====
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
  const variants = ["取扱説明書","取り扱い説明書","取扱い説明書","取説","マニュアル","説明書"];
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
async function aiExtractFromPdfText({ pdfText, fileName, modelHint, productHint }) {
  const MODEL = process.env.MODEL_MANUAL_CHECK || "gpt-5.2";
  const REASONING = process.env.MANUAL_CHECK_REASONING || "medium";
  const VERBOSITY = process.env.MANUAL_CHECK_VERBOSITY || "low";

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

【PDFテキスト（抜粋元）】
ファイル名: ${fileName}
---
${pdfText}
`;

  const resp = await client.responses.create({
    model: MODEL,
    reasoning: { effort: REASONING },
    // 新Responses API：verbosity/format は text.* に移動（互換のため、指定しない or text.verbosity を使う）
    text: { verbosity: VERBOSITY },
    input: [
      { role: "system", content: sys.trim() },
      { role: "user", content: user.trim() },
    ],
  });

  const text = resp.output_text || "{}";
  let obj;
  try { obj = JSON.parse(text); } catch { obj = {}; }

  const model = norm(obj.model);
  const productName = norm(obj.productName);

  const specs = dedupeKeepOrder(Array.isArray(obj.specs) ? obj.specs : []);

  // ops: filter + dedupe
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

  // accs: normalize + ensure manual
  let accs = Array.isArray(obj.accs) ? obj.accs.map(normalizeManualAccessory).map(norm) : [];
  accs = accs.map(normalizeManualAccessory);
  accs.push("取扱説明書"); // 必ず入れる
  accs = dedupeKeepOrder(accs);

  // USB表記揺れの代表化（AIが揺らした場合の最終ガード）
  accs = accs.map(a => {
    if (a.includes("USB") && (a.includes("コード") || a.includes("ケーブル") || a === "ケーブル")) return "USBケーブル";
    if (a === "ケーブル") return "USBケーブル";
    return a;
  });
  accs = dedupeKeepOrder(accs);

  return { model, productName, specs, ops, accs };
}

// ===== Excel generate =====
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

  // ファイル名
  const safeModel = cleanFileNamePart(model);
  const safeProduct = cleanFileNamePart(productName);
  const fileName = `検品リスト_${safeModel}_${safeProduct}.xlsx`;

  const out = await wb.xlsx.writeBuffer();
  const fileBase64 = Buffer.from(out).toString("base64");
  return { fileName, fileBase64 };
}

// ===== handler =====
export default async function handler(req, res) {
  // CORS（既存ツールに合わせた最小）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const op = (req.query?.op ?? "").toString();

    if (req.method !== "POST") {
      return res.status(405).json({ error: "MethodNotAllowed" });
    }

    if (op === "meta") {
      const selectionItems = await getSelectionItemsFromTemplate();
      return res.status(200).json({ selectionItems });
    }

    if (op === "extract") {
      const { pdfText, fileName, modelHint, productHint } = req.body || {};
      if (!pdfText || typeof pdfText !== "string") {
        return res.status(400).json({ error: "BadRequest", detail: "pdfText is required" });
      }
      const r = await aiExtractFromPdfText({
        pdfText,
        fileName: fileName || "manual.pdf",
        modelHint: modelHint || "",
        productHint: productHint || ""
      });
      return res.status(200).json(r);
    }

    if (op === "generate") {
      const body = req.body || {};
      const model = norm(body.model);
      const productName = norm(body.productName);
      if (!model || !productName) {
        return res.status(400).json({ error: "BadRequest", detail: "model/productName required" });
      }

      const result = await generateExcel({
        model,
        productName,
        selectedLabels: Array.isArray(body.selectedLabels) ? body.selectedLabels : [],
        selectedSelectionItems: Array.isArray(body.selectedSelectionItems) ? body.selectedSelectionItems : [],
        specText: Array.isArray(body.specText) ? body.specText : [],
        opTitles: Array.isArray(body.opTitles) ? body.opTitles : [],
        opItems: Array.isArray(body.opItems) ? body.opItems : [],
        accText: Array.isArray(body.accText) ? body.accText : [],
      });

      return res.status(200).json(result);
    }

    // Unknown op
    return res.status(400).json({ error: "BadRequest", detail: "Unknown op" });
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    console.error("[inspection] error:", msg);
    return res.status(500).json({ error: "InternalError", detail: msg });
  }
}

