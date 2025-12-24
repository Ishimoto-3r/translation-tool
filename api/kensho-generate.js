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
    "次の制約を厳守して、追加すべき検証項目だけを提案してください。\n\n" +
    "【制約】\n" +
    "1) 既存の確認内容（existingChecks）と同義・重複する提案は出さない\n" +
    "2) 文末に「〜を検証する」「〜であることを検証する」「確認する」等を付けない（冗長禁止）\n" +
    "3) 提案文は短く、チェック観点そのものを名詞句または簡潔な文で書く\n" +
    "4) 出力は必ずJSONオブジェクトのみ\n\n" +
    "【出力形式】\n" +
    "{\n" +
    '  "items":[{"text":"...","note":"..."}],\n' +
    '  "comment":"（検証のプロとしての所感・注意点を1段落）"\n' +
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
  const comment = (obj.comment || "").toString();

  return { items, comment };
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

    // 既存の確認内容（主にC列）を収集して重複排除に使う
    const existingChecks = [];
    wsTpl.eachRow((row) => {
      const v = row.getCell(3).value; // C列
      if (v !== null && v !== undefined && String(v).trim() !== "") {
        existingChecks.push(String(v));
      }
    });

    const normalize = (s) => {
      return String(s || "")
        .replace(/\s+/g, "")
        .replace(/[、。．，\.\-ー—_]/g, "")
        .replace(/(を)?(検証|確認|チェック)(する|します|した|してください)?$/g, "")
        .trim()
        .toLowerCase();
    };
    const existingSet = new Set(existingChecks.map(normalize));

    // 5) AI提案（同義・重複は出さない／「検証する」等禁止）
    const aiResult = await aiSuggest({
      productInfo: productInfo || {},
      selectedLabels,
      existingChecks,
      images,
    });

    const aiItems = aiResult.items || [];
    const aiComment = (aiResult.comment || "").toString().trim();

    for (const it of aiItems) {
      let text = (it?.text || "").toString().trim();
      let note = (it?.note || "").toString().trim();
      if (!text) continue;

      // 末尾の「検証する/確認する」等を除去（念のため）
      text = text.replace(/(を)?(検証|確認|チェック)(する|します|した|してください)?$/g, "").trim();
      if (!text) continue;

      // 同義・重複は除外（正規化して一致レベルで弾く）
      const key = normalize(text);
      if (!key) continue;
      if (existingSet.has(key)) continue;
      existingSet.add(key);

      const newRow = wsTpl.getRow(writeRowNo);
      newRow.getCell(1).value = "";
      newRow.getCell(2).value = "AI提案";
      newRow.getCell(3).value = text;
      newRow.getCell(7).value = note;

      for (let c = 1; c <= 8; c++) {
        copyCellStyle(styleRow.getCell(c), newRow.getCell(c));
      }
      for (let c = 2; c <= 8; c++) {
        newRow.getCell(c).border = thinBorder();
      }

      newRow.commit?.();
      writeRowNo++;
    }

    // 6) プロコメント（格子外・最下段にテキストボックス風）
    if (aiComment) {
      writeRowNo += 1;

      const r = writeRowNo;
      wsTpl.mergeCells(r, 2, r, 8); // B:H 結合

      const cell = wsTpl.getCell(r, 2);
      cell.value = `【AIコメント（検証のプロ視点）】\n${aiComment}`;
      cell.alignment = { vertical: "top", horizontal: "left", wrapText: true };

      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      cell.border = {
        top: { style: "medium" },
        left: { style: "medium" },
        bottom: { style: "medium" },
        right: { style: "medium" },
      };

      wsTpl.getRow(r).height = 80;
      writeRowNo++;
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
