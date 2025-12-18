// api/kensho-generate.js（新規）
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
  // B〜H（2〜8列）に値がある最終行
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
  // ExcelJSはstyleオブジェクトを丸ごとコピー可能
  dst.style = { ...src.style };
}

async function aiSuggest({ productInfo, selectedLabels, currentRows, images }) {
  const sys =
    "あなたは製品の検証項目を追加提案する担当者です。\n" +
    "入力情報・画像・既存の検証項目を踏まえて、追加すべき検証項目だけを提案してください。\n" +
    "出力は必ずJSON配列のみ。形式：[{\"text\":\"...\",\"note\":\"...\"}]\n" +
    "noteは任意。textは1項目=1行の検証内容。";

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

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content },
    ],
    reasoning_effort: REASONING,
    verbosity: VERBOSITY,
  });

  const text = completion.choices[0]?.message?.content ?? "[]";
  // 配列部分だけ抽出（保険）
  const m = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  const jsonText = m ? m[0] : text;
  const parsed = JSON.parse(jsonText);
  return Array.isArray(parsed) ? parsed : [];
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

    // 3) 検証項目リストから抽出（A=大分類、B〜Hを機械コピー）
    const chosen = new Set(selectedLabels);
    const extracted = [];

    // ヘッダが2行目想定。データは3行目以降。
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

    // 5) AI提案を追記（無制限）
    const ai = await aiSuggest({
      productInfo: productInfo || {},
      selectedLabels,
      currentRows: { extractedCount: extracted.length },
      images,
    });

    for (const it of ai) {
      const text = (it?.text || "").toString().trim();
      const note = (it?.note || "").toString().trim();
      if (!text) continue;

      const newRow = wsTpl.getRow(writeRowNo);

      // A空 / B=AI提案 / C=提案内容 / G=補足
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

    // 6) 出力ファイル名
    const name = (productInfo?.name || "無題").toString();
    const filename = `検証_${name}.xlsx`;

    // 7) 返却
    const out = await wb.xlsx.writeBuffer();

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return res.status(200).send(Buffer.from(out));

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "GenerateError", detail: String(err) });
  }
}
