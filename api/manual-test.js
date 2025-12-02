import * as XLSX from "xlsx";

export default async function handler(req, res) {
  try {
    const tenantId = process.env.MANUAL_TENANT_ID;
    const clientId = process.env.MANUAL_CLIENT_ID;
    const clientSecret = process.env.MANUAL_CLIENT_SECRET;
    const fileUrl = process.env.MANUAL_SHAREPOINT_FILE_URL;

    // --- Token取得 ---
    const tokenResponse = await fetch(
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

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return res.status(500).json({ error: "TokenError", detail: tokenData });
    }

    // --- 共有リンク → base64url ---
    const base64 = Buffer.from(fileUrl).toString("base64");
    const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const shareId = `u!${base64url}`;

    // --- ファイル取得 ---
    const graphResponse = await fetch(
      `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem/content`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!graphResponse.ok) {
      const text = await graphResponse.text();
      return res.status(500).json({ error: "GraphError", detail: text });
    }

    const buffer = Buffer.from(await graphResponse.arrayBuffer());

    // --- ここから Excel 解析 ---
    const workbook = XLSX.read(buffer, { type: "buffer" });

    const sheetNames = workbook.SheetNames;
    const firstSheet = workbook.Sheets[sheetNames[0]];

    const json = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });

    return res.status(200).json({
      message: "Excel parsed successfully",
      sheets: sheetNames,
      firstSheetName: sheetNames[0],
      previewFirst10Rows: json.slice(0, 10),
    });

  } catch (err) {
    return res.status(500).json({ error: "UnexpectedError", detail: err.toString() });
  }
}
