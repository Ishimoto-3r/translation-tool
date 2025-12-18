// api/kensho-db.js
import xlsx from "xlsx";

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
  if (!tokenData.access_token) {
    throw new Error("TokenError: " + JSON.stringify(tokenData));
  }
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

  const arrayBuffer = await graphRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export default async function handler(req, res) {
  try {
    const buf = await downloadExcelBuffer();
    const wb = xlsx.read(buf, { type: "buffer" });

    const sheetLabel = wb.Sheets["検証ラベル分類"];
    const sheetList  = wb.Sheets["検証項目リスト"];
    const sheetFirst = wb.Sheets["初回検証フォーマット"];
    const sheetMass  = wb.Sheets["量産前検証フォーマット"];

    if (!sheetLabel) return res.status(500).json({ error: "SheetError", detail: "検証ラベル分類 が見つかりません" });
    if (!sheetList)  return res.status(500).json({ error: "SheetError", detail: "検証項目リスト が見つかりません" });
    if (!sheetFirst) return res.status(500).json({ error: "SheetError", detail: "初回検証フォーマット が見つかりません" });
    if (!sheetMass)  return res.status(500).json({ error: "SheetError", detail: "量産前検証フォーマット が見つかりません" });

    // 1) UI用：検証ラベル分類（manualのラベル分類と同じ発想）
    const labelJson = xlsx.utils.sheet_to_json(sheetLabel, { defval: "" });
    const labelMaster = labelJson
      .map((row, idx) => {
        const label = (row["ラベル名"] ?? "").toString().trim();
        const uiGenre = (row["ジャンル名"] ?? "").toString().trim();
        const uiGenreOrder = safeNumber(row["ジャンル表示順"]);
        const uiItemOrder = safeNumber(row["ジャンル内表示順"]);
        const hiddenRaw = (row["ジャンル表示対象外"] ?? "").toString().trim();
        const uiHidden = hiddenRaw !== "" && hiddenRaw !== "0";
        if (!label || !uiGenre) return null;
        return { id: idx, label, uiGenre, uiGenreOrder, uiItemOrder, uiHidden };
      })
      .filter(Boolean);

    // 2) 抽出用：検証項目リスト（A=大分類、B〜Hを保持）
    // 1行目空、2行目ヘッダ想定（sheet_to_jsonでOK）
    const listJson = xlsx.utils.sheet_to_json(sheetList, { defval: "" });
    const itemList = listJson
      .map((row, idx) => {
        const major = (row["大分類"] ?? "").toString().trim();
        if (!major) return null;
        return {
          id: idx,
          major,
          // ユーザー指示：B〜Hを「初回検証フォーマット」のB列以降へ機械コピー
          B: (row["項目"] ?? "").toString(),
          C: (row["確認内容"] ?? "").toString(),
          D: (row["確認"] ?? "").toString(),
          E: (row["結論"] ?? "").toString(),
          F: (row["最終確認"] ?? "").toString(),
          G: (row["確認結果"] ?? "").toString(),
          H: (row["質問"] ?? "").toString(),
        };
      })
      .filter(Boolean);

    return res.status(200).json({
      sheetNames: wb.SheetNames,
      labelMaster,
      itemList,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "UnexpectedError", detail: String(err) });
  }
}
