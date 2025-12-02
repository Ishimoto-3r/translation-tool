// api/manual-test.js
import xlsx from "xlsx";

export default async function handler(req, res) {
  try {
    // 1) Azure AD でアクセストークン取得
    const tenantId = process.env.MANUAL_TENANT_ID;
    const clientId = process.env.MANUAL_CLIENT_ID;
    const clientSecret = process.env.MANUAL_CLIENT_SECRET;
    const fileUrl = process.env.MANUAL_SHAREPOINT_FILE_URL;

    if (!tenantId || !clientId || !clientSecret || !fileUrl) {
      return res.status(500).json({
        error: "ConfigError",
        detail: "MANUAL_* 系の環境変数が不足しています。",
      });
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
      return res.status(500).json({
        error: "TokenError",
        detail: tokenData,
      });
    }

    const accessToken = tokenData.access_token;

    // 2) SharePoint の Excel を取得
    const shareId = Buffer.from(fileUrl).toString("base64").replace(/=+$/, "");
    const graphRes = await fetch(
      `https://graph.microsoft.com/v1.0/shares/u!${shareId}/driveItem/content`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!graphRes.ok) {
      const txt = await graphRes.text();
      return res.status(graphRes.status).json({
        error: "GraphError",
        status: graphRes.status,
        detail: txt,
      });
    }

    const arrayBuffer = await graphRes.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    // 3) xlsx でパース（1枚目のシート）
    const wb = xlsx.read(buf, { type: "buffer" });
    const firstSheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[firstSheetName];
    const json = xlsx.utils.sheet_to_json(sheet); // 見出し行をヘッダに

    // 期待する列名: 「ラベル」「項目名」「内容」
    const rows = json
      .map((row, idx) => ({
        id: idx,
        label: row["ラベル"] ?? "",
        category: row["項目名"] ?? "",
        content: row["内容"] ?? "",
      }))
      .filter(r => (r.label || r.category || r.content));

    return res.status(200).json({
      message: "Excel parsed successfully",
      sheetNames: wb.SheetNames,
      firstSheetName,
      rows,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "UnexpectedError",
      detail: err.toString(),
    });
  }
}
