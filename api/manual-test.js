// api/manual-test.js

export default async function handler(req, res) {
  try {
    // --- 1. 環境変数の取得 ---
    const tenantId = process.env.MANUAL_TENANT_ID;
    const clientId = process.env.MANUAL_CLIENT_ID;
    const clientSecret = process.env.MANUAL_CLIENT_SECRET;
    const fileUrl = process.env.MANUAL_SHAREPOINT_FILE_URL;

    if (!tenantId || !clientId || !clientSecret || !fileUrl) {
      return res.status(500).json({
        error: "EnvError",
        detail: "MANUAL_* 系の環境変数が不足しています。",
      });
    }

    // --- 2. アクセストークン取得 (client_credentials) ---
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

    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(500).json({
        error: "TokenError",
        status: tokenResponse.status,
        detail: tokenData,
      });
    }

    const accessToken = tokenData.access_token;

    // --- 3. 共有リンク(URL) → base64url 変換 ---
    //   Graph の /shares/{id} 形式にするためのお約束
    const base64 = Buffer.from(fileUrl).toString("base64");
    const base64url = base64
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const shareId = `u!${base64url}`;

    // --- 4. Graph API でファイル本体を取得 ---
    const graphResponse = await fetch(
      `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem/content`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!graphResponse.ok) {
      const text = await graphResponse.text();
      return res.status(graphResponse.status).json({
        error: "GraphError",
        status: graphResponse.status,
        detail: text,
      });
    }

    // 実ファイルはバイナリなので、ここでは長さなどのメタ情報だけ返す
    const arrayBuffer = await graphResponse.arrayBuffer();
    const byteLength = arrayBuffer.byteLength;
    const contentType = graphResponse.headers.get("content-type");

    return res.status(200).json({
      message: "Success: File retrieved from SharePoint.",
      byteLength,
      contentType,
    });
  } catch (err) {
    return res.status(500).json({
      error: "UnexpectedError",
      detail: err.toString(),
    });
  }
}
