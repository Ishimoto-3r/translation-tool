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
    "入力（選択ラベル・ユーザー入力・画像）と既存の検証項目を踏まえ、追加すべき内容だけを提案してください。\n" +
    "入力に根拠がない観点は出さないでください（例：車輪/走行などは必要な場合のみ）。\n" +
    "文末に「〜を検証する」「〜であることを検証する」「確認する」を付けない。\n" +
    "出力は必ずJSONのみ。\n\n" +
    "【出力形式】\n" +
    "{\n" +
    '  "items":[{"text":"...","note":"..."}],\n' +
    '  "commentLines":[\n' +
    '    "重要な検証ポイントを簡潔に1行で",\n' +
    '    "必要なら具体例（例：〜のときは〜）を含める"\n' +
    "  ]\n" +
    "}\n";

  const payload = {
    productInfo,
    selectedLabels,
    existingChecks: (existingChecks || []).slice(0, 400),
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

    // 5) AI提案（重複排除 + 文末「検証する」禁止）
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

      // 同義なら追加しない
      if (isSameMeaning(text, existingSet)) continue;

      const note = stripVerifyEnding(it?.note || "");

      const newRow = wsTpl.getRow(writeRowNo);
      for (let c = 1; c <= 8; c++) copyCellStyle(styleRow.getCell(c), newRow.getCell(c));

      newRow.getCell(1).value = "";
      newRow.getCell(2).value = "AI提案";
      newRow.getCell(3).value = text;
      newRow.getCell(7).value = note;

      // 追記分だけ罫線（B〜H）
      for (let c = 2; c <= 8; c++) newRow.getCell(c).border = thinBorder();

      // 既出セット更新（次の重複排除に効かせる）
      existingSet.add(normalizeLite(text));

      writeRowNo++;
    }

    // 6) 最下段コメント（枠なし・結合なし・1行=1セル、提案済なら(提案済)）
    const aiCommentLines = (aiCommentLinesRaw || [])
      .map((x) => stripVerifyEnding(x))
      .filter((x) => x);

    if (aiCommentLines.length > 0) {
      writeRowNo += 1; // 空行

      // タイトル（B列）
      const titleRow = wsTpl.getRow(writeRowNo);
      titleRow.getCell(2).value = "検証ポイント（簡潔版）";
      copyCellStyle(styleRow.getCell(2), titleRow.getCell(2));
      titleRow.getCell(2).border = {}; // 枠なし
      writeRowNo++;

      for (const line of aiCommentLines) {
        const suffix = isSameMeaning(line, existingSet) ? " (提案済)" : "";
        const row = wsTpl.getRow(writeRowNo);
        row.getCell(2).value = `・${line}${suffix}`;
        copyCellStyle(styleRow.getCell(2), row.getCell(2));
        row.getCell(2).alignment = { vertical: "top", horizontal: "left", wrapText: true };
        row.getCell(2).border = {}; // 枠なし
        writeRowNo++;
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
