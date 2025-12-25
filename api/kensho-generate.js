// /api/kensho-generate.js（全文置き換え）
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

  for (const k of existingSet) {
    if (k.length < 4) continue;
    if (p.includes(k) || k.includes(p)) return true;
  }
  return false;
}

// ===== AI suggest =====
// ここを「commentPoints / specCandidates / gatingQuestions」に分離して返す
async function aiSuggest({ productInfo, selectedLabels, existingChecks, images }) {
  const sys =
    "あなたは品質・検証のプロです。\n" +
    "入力情報（一般名称/特徴/備考/選択ラベル）と画像、既存の検証項目を踏まえ、\n" +
    "1) 表に追記する追加検証項目（items）\n" +
    "2) Excel末尾に記載するAIコメント（検証ポイント・仕様観点）\n" +
    "を作成してください。\n" +
    "\n" +
    "【重要】出力は JSON（オブジェクト）1つのみ。余計な文章は禁止。\n" +
    "形式：{\n" +
    '  "items":[{"text":"...","note":"..."}],\n' +
    '  "commentPoints":["..."],\n' +
    '  "specCandidates":["..."],\n' +
    '  "gatingQuestions":["..."]\n' +
    "}\n" +
    "\n" +
    "【制約】\n" +
    "・各配列要素は1文（日本語）で、80文字以内。超える場合は自然な位置で分割して別要素にする。\n" +
    "・commentPoints：その商品に固有の検証観点。特徴→リスク→見るべき箇所→具体例の順で。背景情報も含めてよい。\n" +
    "・specCandidates：一般名称から、他社類似品で一般的に提示される重要スペック（候補）。なぜ必要かの背景も含めてよい。\n" +
    "・gatingQuestions：メーカー回答次第で案件可否に影響しうる確認事項（安全/法規/保証/交換部品/試験条件など）。背景も含めてよい。\n" +
    "・既存の検証項目と重複してもOK。\n" +
    "・語尾に「検証する」「…であることを検証する」「確認する」は付けない（体言止め/観点の形）。\n";

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

    // 5) AI提案（重複OK）
    const existingSet = buildExistingSet(wsTpl);

    // 既存検証項目（AIに渡す）
    const existingChecks = [];
    wsTpl.eachRow((row) => {
      const b = row.getCell(2).value;
      const c = row.getCell(3).value;
      if (b || c) existingChecks.push({ B: String(b || ""), C: String(c || "") });
    });

    const {
      items: aiItemsRaw,
      commentPoints: aiCommentPointsRaw,
      specCandidates: aiSpecCandidatesRaw,
      gatingQuestions: aiGatingQuestionsRaw,
    } = await aiSuggest({
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

      for (let c = 2; c <= 8; c++) newRow.getCell(c).border = thinBorder();

      existingSet.add(normalizeLite(text));
      writeRowNo++;
    }

    // 6) 最下段コメント（枠なし・結合なし・B列固定・wrap OFF・size 16・「・」付与）
    const MAX_SENTENCE_LEN = 80;

    function enforceMaxLen(sentence, maxLen = MAX_SENTENCE_LEN) {
      const s = String(sentence || "").trim();
      if (!s) return [];
      if (s.length <= maxLen) return [s];

      const chunks = [];
      let rest = s;

      while (rest.length > maxLen) {
        const window = rest.slice(0, maxLen + 1);
        let cut = Math.max(
          window.lastIndexOf("、"),
          window.lastIndexOf("・"),
          window.lastIndexOf("："),
          window.lastIndexOf(":"),
          window.lastIndexOf("／"),
          window.lastIndexOf("/"),
          window.lastIndexOf(" "),
          window.lastIndexOf("）"),
          window.lastIndexOf(")")
        );

        if (cut < Math.floor(maxLen * 0.6)) cut = maxLen;

        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) chunks.push(rest);
      return chunks.filter(Boolean);
    }

    function asBullet(s) {
      const t = String(s || "").trim();
      if (!t) return "";
      return t.startsWith("・") ? t : `・${t}`;
    }

    // 配列は「1要素=1文」前提（ユーザー要望①を採用）
    const commentPoints = (aiCommentPointsRaw || [])
      .map((x) => stripVerifyEnding(x))
      .map((x) => String(x || "").trim())
      .filter(Boolean);

    const specCandidates = (aiSpecCandidatesRaw || [])
      .map((x) => stripVerifyEnding(x))
      .map((x) => String(x || "").trim())
      .filter(Boolean);

    const gatingQuestions = (aiGatingQuestionsRaw || [])
      .map((x) => stripVerifyEnding(x))
      .map((x) => String(x || "").trim())
      .filter(Boolean);

    const hasAny =
      commentPoints.length > 0 || specCandidates.length > 0 || gatingQuestions.length > 0;

    if (hasAny) {
      writeRowNo += 1; // 空行（区切り）

      const writeB = (text) => {
        const r = wsTpl.getRow(writeRowNo);
        const c = r.getCell(2);

        c.value = text;

        copyCellStyle(styleRow.getCell(2), c);
        c.font = { ...(c.font || {}), size: 16 }; // 太字不要
        c.alignment = { vertical: "top", horizontal: "left", wrapText: false }; // ★折り返しOFF
        c.border = {}; // 枠不要
        writeRowNo++;
      };

      // タイトル（1行のみ・「・」なし）
      writeB("AIコメント（検証ポイント・仕様観点）");

      // commentPoints（必ず「・」付き）
      for (const line of commentPoints) {
        const parts = enforceMaxLen(line, MAX_SENTENCE_LEN);
        for (const p of parts) {
          const suffix = isSameMeaning(p, existingSet) ? " (提案済)" : "";
          writeB(asBullet(`${p}${suffix}`));
        }
      }

      // 「重要スペック候補」タイトル（1行のみ・「・」なし）
      if (specCandidates.length > 0) {
        writeB("重要スペック候補");
        for (const line of specCandidates) {
          const parts = enforceMaxLen(line, MAX_SENTENCE_LEN);
          for (const p of parts) {
            const suffix = isSameMeaning(p, existingSet) ? " (提案済)" : "";
            writeB(asBullet(`${p}${suffix}`));
          }
        }
      }

      // 「案件可否に影響」タイトル（1行のみ・「・」なし）
      if (gatingQuestions.length > 0) {
        writeB("案件可否に影響");
        for (const line of gatingQuestions) {
          const parts = enforceMaxLen(line, MAX_SENTENCE_LEN);
          for (const p of parts) {
            const suffix = isSameMeaning(p, existingSet) ? " (提案済)" : "";
            writeB(asBullet(`${p}${suffix}`));
          }
        }
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
