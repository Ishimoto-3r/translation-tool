// api/manual-test.js

// ★ これを追加（Node ランタイムを明示）
export const config = {
  runtime: "nodejs20.x",
};

export default async function handler(req, res) {
  try {
    // STEP 1: アクセストークン取得
    const tenantId = process.env.MANUAL_TENANT_ID;
    const clientId = process.env.MANUAL_CLIENT_ID;
    const clientSecret = process.env.MANUAL_CLIENT_SECRET;

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

    if (!tokenData.access_token) {
      return res.status(500).json({
        error: "Token Error",
        detail: tokenData,
      });
    }

    const accessToken = tokenData.access_token;

    // STEP 2: SharePoint ファイルを取得
    const fileUrl = process.env.MANUAL_SHAREPOINT_FILE_URL;

    const graphResponse = await fetch(
      `https://graph.microsoft.com/v1.0/shares/u!${Buffer.from(fileUrl)
        .toString("base64")
        .replace(/=+$/, "")}/driveItem/content`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!graphResponse.ok) {
      const errorDetail = await graphResponse.text();
      return res.status(graphResponse.status).json({
        error: "GraphError",
        status: graphResponse.status,
        detail: errorDetail,
      });
    }

    // STEP 3: とりあえず成功メッセージだけ返す
    return res.status(200).json({
      message: "Success: File retrieved from SharePoint.",
    });
  } catch (err) {
    return res.status(500).json({
      error: "Unexpected Error",
      detail: err.toString(),
    });
  }
}
