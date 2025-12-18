// api/kensho-template.js
import xlsx from "xlsx";

async function getAccessToken() {
  const tenantId = process.env.MANUAL_TENANT_ID;
  const clientId = process.env.MANUAL_CLIENT_ID;
  const clientSecret = process.env.MANUAL_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) throw new Error("ConfigError");

  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error("TokenError");
  return tokenData.access_token;
}

async function downloadExcelBuffer() {
  const fileUrl = process.env.MANUAL_SHAREPOINT_FILE_URL;
  if (!fileUrl) throw new Error("ConfigError: URL missing");
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

export default async function handler(req, res) {
  try {
    const type = (req.query?.type || "first").toString();
    const targetSheet = type === "mass" ? "量産前検証フォーマット" : "初回検証フォーマット";

    const buf = await downloadExcelBuffer();
    const wb = xlsx.read(buf, { type: "buffer" });
    const sheet = wb.Sheets[targetSheet];
    if (!sheet) return res.status(404).json({ error: "SheetNotFound", detail: targetSheet });

    const newWb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(newWb, sheet, targetSheet);

    const out = xlsx.write(newWb, { type: "buffer", bookType: "xlsx" });

    const filename = type === "mass" ? "量産前検証フォーマット.xlsx" : "初回検証フォーマット.xlsx";
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return res.status(200).send(out);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "UnexpectedError", detail: String(err) });
  }
}
