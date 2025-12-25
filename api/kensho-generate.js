// api/kensho-generate.js（全文置き換え）
import OpenAI from "openai";
import ExcelJS from "exceljs";

const MODEL = process.env.MODEL_MANUAL_CHECK || "gpt-5.2";
const REASONING = process.env.MANUAL_CHECK_REASONING || "medium";
const VERBOSITY = process.env.MANUAL_CHECK_VERBOSITY || "low";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ===============================
   SharePoint download
================================ */
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
  if (!tokenData.access_token) throw new Error("TokenError");
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

  if (!graphRes.ok) throw new Error("GraphError");
  const ab = await graphRes.arrayBuffer();
  return Buffer.from(ab);
}

/* ===============================
   Excel helpers
================================ */
function thinBorder() {
  return {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };
}

function copyCellStyle(src, dst) {
  dst.style = { ...src.style };
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

function normalizeLite(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[、。．，\.\-ー—_]/g, "")
    .replace(/(を)?(検証|確認|チェック)(する|します|した|してください)?$/g, "")
    .toLowerCase();
}

function stripVerifyEnding(s) {
  return String(s || "")
    .replace(/(であること)?(を)?(検証|確認|チェック)(する|します|した|してください)?$/g, "")
    .trim();
}

function buildExistingSet(ws) {
  const set = new Set();
  ws.eachRow((row) => {
    const v = row.getCell(3).value; // C列
    if (v) set.add(normalizeLite(v));
  });
  return set;
}

function isSameMeaning(line, existingSet) {
  const p = normalizeLite(line);
  if (!p) return false;
  if (existingSet.has(p)) return true;
  for (const k of existingSet) {
    if (k.length >= 4 && (p.includes(k) || k.includes(p))) return true;
  }
  return false;
}

/* ===============================
   AI suggest
================================ */
async function aiSuggest({ productInfo, selectedLabels, existingChecks, images }) {
  const sys =
    "あなたは品質・検証のプロです。\n" +
    "入力情報と画像を踏まえ、Excel末尾に記載するAIコメントを作成してください。\n" +
    "出力はJSONのみ。\n\n" +
    "{\n" +
    '  "items":[{"text":"...","note":"..."}],\n' +
    '  "commentPoints":["..."],\n' +
    '  "specCandidates":["..."],\n' +
    '  "gatingQuestions":["..."]\n' +
    "}\n\n" +
    "制約：\n" +
    "・各要素は1文80文字以内\n" +
    "・commentPointsは5～6行\n" +
    "・specCandidates / gatingQuestions は重要度の高いもののみ\n" +
    "・語尾に「検証する」は付けない";

  const content = [
    { type: "text", text: JSON.stringify({ productInfo, selectedLabels, existingChecks }, null, 2) },
  ];

  if (Array.isArray(images)) {
    for (const img of images) {
      if (typeof img === "string" && img.startsWith("data:image/")) {
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
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  const jsonText = s >= 0 && e > s ? raw.slice(s, e + 1) : "{}";

  const obj = JSON.parse(jsonText);
  return {
    items: Array.isArray(obj.items) ? obj.items : [],
    commentPoints: Array.isArray(obj.commentPoints) ? obj.commentPoints : [],
    specCandidates: Array.isArray(obj.specCandidates) ? obj.specCandidates : [],
    gatingQuestions: Array.isArray(obj.gatingQuestions) ? obj.gatingQuestions : [],
  };
}

/* ===============================
   handler
================================ */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    const { selectedLabels, productInfo, images } = body;

    const buf = await downloadExcelBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);

    const wsList = wb.getWorksheet("検証項目リスト");
    const wsTpl = wb.getWorksheet("初回検証フォーマット");
    if (!wsList || !wsTpl) throw new Error("SheetError");

    wsTpl.getCell("C1").value = `選択語句：${selectedLabels.join(",")}`;

    /* ---- 既存検証項目 ---- */
    const last = findLastUsedRowBH(wsTpl);
    const styleRow = wsTpl.getRow(last);
    let writeRowNo = last + 1;

    const existingSet = buildExistingSet(wsTpl);

    const existingChecks = [];
    wsTpl.eachRow((row) => {
      const b = row.getCell(2).value;
      const c = row.getCell(3).value;
      if (b || c) existingChecks.push({ B: String(b || ""), C: String(c || "") });
    });

    const {
      items,
      commentPoints,
      specCandidates,
      gatingQuestions,
    } = await aiSuggest({
      productInfo,
      selectedLabels,
      existingChecks,
      images,
    });

    /* ---- AI検証項目追記（省略：現状ロジック維持） ---- */
    for (const it of items) {
      const text = stripVerifyEnding(it.text || "");
      if (!text) continue;
      const newRow = wsTpl.getRow(writeRowNo);
      for (let c = 1; c <= 8; c++) copyCellStyle(styleRow.getCell(c), newRow.getCell(c));
      newRow.getCell(2).value = "AI提案";
      newRow.getCell(3).value = text;
      for (let c = 2; c <= 8; c++) newRow.getCell(c).border = thinBorder();
      existingSet.add(normalizeLite(text));
      writeRowNo++;
    }

    /* ===============================
       最下段 AIコメント
       開始位置：B列最下行の「下の下」
    ================================ */
    writeRowNo += 2;

    function writeCommentLine(text) {
      const r = wsTpl.getRow(writeRowNo);
      const c = r.getCell(2);
      copyCellStyle(styleRow.getCell(2), c);
      c.value = text;
      c.font = { size: 16 };
      c.alignment = { vertical: "top", horizontal: "left", wrapText: false };
      c.border = {};
      writeRowNo++;
    }

    writeCommentLine("AIコメント（検証ポイント・仕様観点）");
    commentPoints.forEach((t) => {
      const s = stripVerifyEnding(t);
      writeCommentLine(isSameMeaning(s, existingSet) ? `${s} (提案済)` : s);
    });

    writeRowNo++;

    writeCommentLine("重要スペック候補");
    specCandidates.forEach((t) => writeCommentLine("・" + t));

    writeRowNo++;

    writeCommentLine("案件可否に影響");
    gatingQuestions.forEach((t) => writeCommentLine("・" + t));

    wsTpl.name = "初回検証";
    wb.worksheets.filter((ws) => ws.name !== "初回検証").forEach((ws) => wb.removeWorksheet(ws.id));

    const filename = `検証_${(productInfo?.name || "無題")}.xlsx`;
    const out = await wb.xlsx.writeBuffer();

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.status(200).send(Buffer.from(out));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "GenerateError", detail: String(err) });
  }
}
