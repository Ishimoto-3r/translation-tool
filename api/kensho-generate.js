// api/kensho-generate.js（全文置き換え）
import OpenAI from "openai";
import ExcelJS from "exceljs";

const MODEL = process.env.MODEL_MANUAL_CHECK || "gpt-5.2";
const REASONING = process.env.MANUAL_CHECK_REASONING || "medium";
const VERBOSITY = process.env.MANUAL_CHECK_VERBOSITY || "low";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== SharePoint download =====
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

async function downloadExcelBuffer() {
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
  // 「〜を検証する」「〜であることを検証する」等を除去（冗長禁止）
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

  // 部分一致（誤爆抑制：4文字以上）
  for (const k of existingSet) {
    if (k.length < 4) continue;
    if (p.includes(k) || k.includes(p)) return true;
  }
  return false;
}

// ===== AI suggest =====
async function aiSuggest({ productInfo, selectedLabels, existingChecks, images }) {
  const sys =
    "あなたは品質検証（検品・評価）のプロです。\n" +
    "\n" +
    "【やること】\n" +
    "1) 既存の検証項目に追加すべき『検証項目（表の行として追記するもの）』を提案\n" +
    "2) その商品の『検証ポイント（コメント欄として末尾に出すもの）』を、わかりやすく詳しく説明\n" +
    "\n" +
    "【重要ルール】\n" +
    "・入力情報（一般名称/特徴/備考/選択ラベル/画像）に基づき、関連が薄い観点は出さない\n" +
    "・文末に「〜を検証する」「〜であることを検証する」「確認する」を付けない（冗長禁止）\n" +
    "・『一般名称』から、市場で一般的に求められる仕様/スペックや、メーカー回答次第で案件可否に影響する確認事項も含める\n" +
    "  ※あなたはWeb閲覧できない前提なので、一般に想定される仕様項目を“候補”として挙げ、必要に応じて『要メーカー確認』を明記\n" +
    "・出力は必ずJSONのみ（余計な文章禁止）\n" +
    "\n" +
    "【出力形式】\n" +
    "{\n" +
    '  "items":[{"text":"(表に追記する検証項目)","note":"(任意の補足)"}],\n' +
    '  "commentLines":[\n' +
    '    "製品の特徴（何がポイントか）",\n' +
    '    "検証ポイント（理由付き）",\n' +
    '    "具体例（例：◯◯の場合は△△を見る）",\n' +
    '    "重要スペック候補（要メーカー確認を含める）",\n' +
    '    "案件可否に影響する確認事項（要メーカー確認）"\n' +
    "  ]\n" +
    "}\n";

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

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content },
    ],
    reasoning_effort: REASONING,
    verbosity: VERBOSITY,
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const m = raw.match(/\{[\s\S]*\}$/);
  const jsonText = m ? m[0] : raw;

  const obj = JSON.parse(jsonText);
  const items = Array.isArray(obj.items) ? obj.items : [];
  const commentLines = Array.isArray(obj.commentLines) ? obj.commentLines : [];
  return { items, commentLines };
}

// ===== handler =====
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { selectedLabels, productInfo, images } = body;

    if (!Array.isArray(selectedLabels) || selectedLabels.length === 0) {
      return res.status(400).json({ error: "SelectedLabelsRequired" });
    }

    // 1) SharePointのdatabase.xlsxを取得
    const buf = await downloadExcelBuffer();

    // 2) ExcelJSで読み込み（書式保持）
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const wsList = wb.getWorksheet("検証項目リスト");
    const wsTpl = wb.getWorksheet("初回検証フォーマット");
    if (!wsList) throw new Error("SheetError: 検証項目リスト が見つかりません");
    if (!wsTpl) throw new Error("SheetError: 初回検証フォーマット が見つかりません");

    // C1 に選択語句（カンマ区切り）
    wsTpl.getCell("C1").value = `選択語句：${selectedLabels.join(",")}`;

    // 3) 検証項目リストから抽出（A=大分類、B〜Hを機械コピー）
    const chosen = new Set(selectedLabels);
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

    // 5) AI提案（※重複OKに変更：ここでは重複排除しない）
    const existingSet = buildExistingSet(wsTpl);

    // 既存検証項目（AIに渡す）
    const existingChecks = [];
    wsTpl.eachRow((row) => {
      const b = row.getCell(2).value;
      const c = row.getCell(3).value;
      if (b || c) existingChecks.push({ B: String(b || ""), C: String(c || "") });
    });

    const { items: aiItemsRaw, commentLines: aiCommentLinesRaw } = await aiSuggest({
      productInfo,
      selectedLabels,
      existingChecks,
      images,
    });

    // 追加行（AI提案）
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

      // 追記分だけ罫線（B〜H）
      for (let c = 2; c <= 8; c++) newRow.getCell(c).border = thinBorder();

      // 既出セット更新（コメント側の(提案済)判定に使う）
      existingSet.add(normalizeLite(text));

      writeRowNo++;
    }

// 6) 最下段コメント（枠なし・結合なし・1行=1セル）
// 要望反映：
// ① 折り返しOFF（wrapText:false）
// ② B列固定
// ③ 途中挿入なし（末尾に追記のみ）
// ④ 最大行数制限なし
// ⑤ 文字サイズ 16
// 追加：B列の幅は変更しない。見切れる長文は「下のセルに分割」して出力する。

function isSectionHeader(line) {
  const t = String(line || "").trim();
  // 例： "1. 構造・安全性" / "重要スペック候補（…）" / "案件可否に影響する確認事項（…）"
  if (/^\d+\.\s*/.test(t)) return true;
  if (/^(製品の特徴|検証ポイント|具体例|重要スペック候補|案件可否)/.test(t)) return true;
  // 短めで区切りっぽいものを見出し扱い
  if (t.length <= 22 && /（.*）/.test(t)) return true;
  return false;
}

// 折り返しOFF前提なので、1セルに収めず「複数行（複数セル）」へ分割する。
// なるべく区切り文字で切る。ダメなら文字数で切る。
function splitIntoCells(text, maxChars = 42) {
  const s = String(text || "").trim();
  if (!s) return [];

  // まずは「。」「;」「／」等で粗く分割
  const parts = s
    .replace(/[\r\n]+/g, " ")
    .split(/(?<=[。．\.！!？\?；;])\s*/g)
    .map((x) => x.trim())
    .filter(Boolean);

  const out = [];
  for (const p of parts.length ? parts : [s]) {
    if (p.length <= maxChars) {
      out.push(p);
      continue;
    }
    // 長すぎる場合：maxCharsで分割（できるだけ「、」「・」「：」付近で切る）
    let buf = p;
    while (buf.length > maxChars) {
      let cut = maxChars;
      // 直前付近に区切りがあればそこまで戻す
      const window = buf.slice(0, maxChars + 1);
      const idx = Math.max(
        window.lastIndexOf("、"),
        window.lastIndexOf("・"),
        window.lastIndexOf("："),
        window.lastIndexOf(":"),
        window.lastIndexOf("／"),
        window.lastIndexOf("/"),
        window.lastIndexOf("）"),
        window.lastIndexOf(")")
      );
      if (idx >= Math.floor(maxChars * 0.6)) cut = idx + 1;

      out.push(buf.slice(0, cut).trim());
      buf = buf.slice(cut).trim();
    }
    if (buf) out.push(buf);
  }

  return out.filter(Boolean);
}

const aiCommentLines = (aiCommentLinesRaw || [])
  .map((x) => stripVerifyEnding(x))
  .map((x) => String(x || "").trim())
  .filter(Boolean);

if (aiCommentLines.length > 0) {
  writeRowNo += 1; // 空行（区切り）

  // ★B列の幅は変更しない（要望）
  // wsTpl.getColumn(2).width = ... ← ここは絶対に入れない

  // タイトル行（サイズ16・太字）
  const titleRow = wsTpl.getRow(writeRowNo);
  const titleCell = titleRow.getCell(2);
  titleCell.value = "AIコメント（検証ポイント・仕様観点）";
  copyCellStyle(styleRow.getCell(2), titleCell);
  titleCell.font = { ...(titleCell.font || {}), bold: true, size: 16 };
  titleCell.alignment = { vertical: "top", horizontal: "left", wrapText: false };
  titleCell.border = {}; // 枠なし
  writeRowNo++;

  // 本文：1行ずつ（見切れる可能性がある長文は splitIntoCells で「下のセルへ」分割
  for (const rawLine of aiCommentLines) {
    const suffix = isSameMeaning(rawLine, existingSet) ? " (提案済)" : "";

    // 見出し行：そのまま（分割は必要ならする）
    if (isSectionHeader(rawLine)) {
      writeRowNo += 1; // セクション前に1行空ける（詰めたいなら 0 に）
      const chunks = splitIntoCells(rawLine, 42);
      for (const ch of chunks) {
        const r = wsTpl.getRow(writeRowNo);
        const c = r.getCell(2);
        c.value = ch;
        copyCellStyle(styleRow.getCell(2), c);
        c.font = { ...(c.font || {}), bold: true, size: 16 };
        c.alignment = { vertical: "top", horizontal: "left", wrapText: false };
        c.border = {};
        writeRowNo++;
      }
      continue;
    }

    // 本文（箇条書き）：分割しても「・」は先頭だけに付ける
    const base = String(rawLine || "").trim();
    const chunks = splitIntoCells(base, 42);
    if (chunks.length === 0) continue;

    chunks.forEach((ch, i) => {
      const r = wsTpl.getRow(writeRowNo);
      const c = r.getCell(2);

      const head = i === 0 ? "・" : "  "; // 続き行はインデントだけ
      const tail = i === chunks.length - 1 ? suffix : "";
      c.value = `${head}${ch}${tail}`;

      copyCellStyle(styleRow.getCell(2), c);
      c.font = { ...(c.font || {}), bold: false, size: 16 };
      c.alignment = { vertical: "top", horizontal: "left", wrapText: false };
      c.border = {};
      writeRowNo++;
    });
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
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "GenerateError", detail: String(err) });
  }
}
