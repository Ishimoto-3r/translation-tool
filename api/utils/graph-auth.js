// api/utils/graph-auth.js
// Microsoft Graph API のアクセストークン取得を一元管理
// 使用箇所: inspection.js, kensho.js

const logger = require("./logger");

/**
 * Azure AD からアクセストークンを取得
 * 環境変数: MANUAL_TENANT_ID, MANUAL_CLIENT_ID, MANUAL_CLIENT_SECRET
 * @returns {Promise<string>} アクセストークン
 */
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

    logger.info("graph-auth", "Access token acquired successfully");
    return tokenData.access_token;
}

module.exports = { getAccessToken };
