// api/kensho-generate.js（全文置き換え）
import OpenAI from "openai";
import ExcelJS from "exceljs";

const MODEL = process.env.MODEL_MANUAL_CHECK || "gpt-5.2";
const REASONING = process.env.MANUAL_CHECK_REASONING || "medium";
const VERBOSITY = process.env.MANUAL_CHECK_VERBOSITY || "low";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

async function aiSuggest({ productInfo, selectedLabels, existingChecks, images }) {
 const sys =
  "あなたは品質検証（検品・評価）のプロです。\n" +
  "入力（選択ラベル・ユーザー入力・画像）から、この製品に必要な検証ポイントを要点だけでまとめてください。\n" +
  "汎用テンプレの丸写しは禁止。入力に根拠がない観点（例：車輪、走行など）は出さないでください。\n\n" +
  "【コメント作成ルール】\n" +
  "1) 章タイトルは製品に合わせて自由に作る（例：安全性、操作性、耐久、表示/法規、付属品、使用環境など）\n" +
  "2) 各章の箇条書きは最大5行。各行は短く、可能なら具体例（例：〜のときは〜）を含める\n" +
  "3) 文末に「〜を検証する」「〜であることを検証する」「確認する」を付けない（冗長禁止）\n" +
  "4) 既に検証項目として書かれている内容と同義でも“コメントとして重要なら”書いてよい（あとでこちらで(提案済)を付ける）\n" +
  "5) 出力は必ずJSONのみ\n\n" +
"【出力形式】\n" +
"{\n" +
'  "items":[{"text":"...","note":"..."}],\n' +
'  "commentLines":[\n' +
'    "重要な検証ポイントを簡潔に記載",\n' +
'    "必要に応じて具体例を1つ含める",\n' +
'    "製品特性に依存しない汎用文は書かない"\n' +
"  ]\n" +
"}\n";




  const payload = {
    productInfo,
    selectedLabels,
    existingChecks: (existingChecks || []).slice(0, 300),
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

  const text = completion.choices[0]?.message?.content ?? "{}";

  const m = text.match(/\{[\s\S]*\}$/);
  const jsonText = m ? m[0] : text;

  const obj = JSON.parse(jsonText);
const items = Array.isArray(obj.items) ? obj.items : [];
const commentLines = Array.isArray(obj.commentLines) ? obj.commentLines : [];

return { items, commentLines };

}

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
    const wsTpl  = wb.getWorksheet("初回検証フォーマット");
    if (!wsList) throw new Error("SheetError: 検証項目リスト が見つかりません");
    if (!wsTpl)  throw new Error("SheetError: 初回検証フォーマット が見つかりません");

    // C1 に選択語句（カンマ区切り）
    wsTpl.getCell("C1").value = `選択語句：${selectedLabels.join(",")}`;

    // 3) 検証項目リストから抽出（A=大分類、B〜Hを機械コピー）
    const chosen = new Set(selectedLabels);
    const extracted = [];

    // 1行目空、2行目ヘッダ想定 → 3行目以降データ
    for (let r = 3; r <= wsList.rowCount; r++) {
      const row = wsList.getRow(r);
      const major = (row.getCell(1).value ?? "").toString().trim(); // A
      if (!major) continue;

      if (chosen.has(major)) {
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
    }

    // 4) テンプレ末尾を探して追記
    const last = findLastUsedRowBH(wsTpl);
    const styleRowNo = last; // 既存最終行の書式をコピー元にする
    const styleRow = wsTpl.getRow(styleRowNo);

    let writeRowNo = last + 1;

    for (const r of extracted) {
      const newRow = wsTpl.getRow(writeRowNo);

      // 値：A空、B〜H機械コピー
      newRow.getCell(1).value = "";
      newRow.getCell(2).value = r.B;
      newRow.getCell(3).value = r.C;
      newRow.getCell(4).value = r.D;
      newRow.getCell(5).value = r.E;
      newRow.getCell(6).value = r.F;
      newRow.getCell(7).value = r.G;
      newRow.getCell(8).value = r.H;

      // 書式コピー＋追記分は格子（罫線）を付与（B〜H）
      for (let c = 1; c <= 8; c++) {
        copyCellStyle(styleRow.getCell(c), newRow.getCell(c));
      }
      for (let c = 2; c <= 8; c++) {
        newRow.getCell(c).border = thinBorder();
      }

      newRow.commit?.();
      writeRowNo++;
    }

   // ===== AIコメント（最下段・1行1セル・枠なし） =====

// 既存の確認内容（C列）を正規化して収集
const existingSet = new Set();
wsTpl.eachRow((row) => {
  const v = row.getCell(3).value;
  if (v) {
    existingSet.add(
      String(v)
        .replace(/\s+/g, "")
        .replace(/[、。．，\.\-ー—_]/g, "")
        .replace(/(を)?(検証|確認|チェック)(する|します)?$/g, "")
        .toLowerCase()
    );
  }
});

function isDuplicate(line) {
  const norm = String(line)
    .replace(/\s+/g, "")
    .replace(/[、。．，\.\-ー—_]/g, "")
    .replace(/(を)?(検証|確認|チェック)(する|します)?$/g, "")
    .toLowerCase();

  for (const e of existingSet) {
    if (norm.includes(e) || e.includes(norm)) return true;
  }
  return false;
}

// 空行
writeRowNo += 1;

// 見出し
wsTpl.getRow(writeRowNo).getCell(2).value = "検証ポイント（簡潔版）";
writeRowNo++;

// 本文
for (const line of aiCommentLines) {
  if (!line) continue;
  const suffix = isDuplicate(line) ? " (提案済)" : "";
  wsTpl.getRow(writeRowNo).getCell(2).value = `・${line}${suffix}`;
  writeRowNo++;
}


   // 6) AIコメント（結合なし・枠なし・1行=1セル）
// 既存の確認内容（C列）＋AI提案（C列）を既出判定に使う
function normalizeLite(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[、。．，\.\-ー—_]/g, "")
    .replace(/(を)?(検証|確認|チェック)(する|します|した|してください)?$/g, "")
    .trim()
    .toLowerCase();
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

function writeLine(ws, r, c, text, styleRefCell) {
  const cell = ws.getCell(r, c);
  cell.value = text;
  cell.alignment = { vertical: "top", horizontal: "left", wrapText: true };
  // 書体などはテンプレを踏襲（枠は触らない）
  if (styleRefCell) cell.style = { ...styleRefCell.style };
  return cell;
}

const existingSetForComment = buildExistingSet(wsTpl);
const styleRefCell = styleRow.getCell(2); // B列の既存書式を流用

const hasComment =
  (aiCommentSections && aiCommentSections.length > 0) ||
  (aiCommentNotes && aiCommentNotes.length > 0);

if (hasComment) {
  // 空行を1行
  writeRowNo += 1;

  // タイトル
  writeLine(wsTpl, writeRowNo, 2, aiCommentTitle || "検証ポイント（簡潔版）", styleRefCell);
  writeRowNo++;

  // セクション
  for (const sec of aiCommentSections) {
    const title = String(sec?.title || "").trim();
    const bullets = Array.isArray(sec?.bullets) ? sec.bullets : [];

    if (title) {
      writeLine(wsTpl, writeRowNo, 2, title, styleRefCell);
      writeRowNo++;
    }

    for (const b of bullets) {
      const raw = String(b || "").trim();
      if (!raw) continue;

      const suffix = isSameMeaning(raw, existingSetForComment) ? " (提案済)" : "";
      writeLine(wsTpl, writeRowNo, 2, `・${raw}${suffix}`, styleRefCell);
      writeRowNo++;
    }

    // セクション区切り（不要ならこの1行を削除）
    writeRowNo++;
  }

  // 注意点（重要）など
  for (const n of aiCommentNotes) {
    const raw = String(n || "").trim();
    if (!raw) continue;

    const suffix = isSameMeaning(raw, existingSetForComment) ? " (提案済)" : "";
    writeLine(wsTpl, writeRowNo, 2, `${raw}${suffix}`, styleRefCell);
    writeRowNo++;
  }
}



    // 7) 出力は「初回検証」シートのみ、名称変更
    wsTpl.name = "初回検証";
    wb.worksheets
      .filter((ws) => ws.name !== "初回検証")
      .forEach((ws) => wb.removeWorksheet(ws.id));

    // 8) 出力ファイル名
    const name = (productInfo?.name || "無題").toString();
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
