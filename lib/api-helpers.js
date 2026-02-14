// lib/api-helpers.js
// API共通のヘルパー関数を提供（CORS設定、エラーレスポンス、リクエストバリデーション等）

const logger = require('./logger');

/**
 * CORS設定を統一的に適用
 * @param {Object} res - レスポンスオブジェクト
 */
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );
}

/**
 * OPTIONSリクエストのプリフライトハンドリング
 * @param {Object} req - リクエストオブジェクト
 * @param {Object} res - レスポンスオブジェクト
 * @returns {boolean} - OPTIONSリクエストの場合true
 */
function handleCorsPreFlight(req, res) {
    if (req.method === 'OPTIONS') {
        setCorsHeaders(res);
        res.status(200).end();
        return true;
    }
    return false;
}

/**
 * POSTメソッドのバリデーション
 * @param {Object} req - リクエストオブジェクト
 * @param {Object} res - レスポンスオブジェクト
 * @returns {boolean} - POSTでない場合false
 */
function validatePostMethod(req, res) {
    if (req.method !== 'POST') {
        logger.warn('api-helpers', `Method not allowed: ${req.method}`);
        res.status(405).json({ error: 'Method Not Allowed' });
        return false;
    }
    return true;
}

/**
 * 統一エラーレスポンス送信
 * @param {Object} res - レスポンスオブジェクト
 * @param {number} statusCode - HTTPステータスコード
 * @param {string} message - エラーメッセージ
 * @param {string} context - ログコンテキスト
 * @param {Object} error - エラーオブジェクト（オプション）
 */
function sendErrorResponse(res, statusCode, message, context, error = null) {
    if (error) {
        logger.error(context, message, { error: error.message, stack: error.stack });
    } else {
        logger.error(context, message);
    }

    res.status(statusCode).json({
        error: message,
        ...(process.env.NODE_ENV !== 'production' && error ? { details: error.message } : {})
    });
}

/**
 * 環境変数の検証
 * @param {string} envVarName - 環境変数名
 * @param {Object} res - レスポンスオブジェクト
 * @param {string} context - ログコンテキスト
 * @returns {string|null} - 環境変数の値、または設定されていない場合null
 */
function getRequiredEnvVar(envVarName, res, context) {
    const value = process.env[envVarName];
    if (!value) {
        sendErrorResponse(
            res,
            500,
            `環境変数 ${envVarName} が設定されていません`,
            context
        );
        return null;
    }
    return value;
}

/**
 * 統一レスポンスラッパー（CORS設定を自動適用）
 * @param {Object} res - レスポンスオブジェクト
 * @param {number} statusCode - HTTPステータスコード
 * @param {Object} data - レスポンスデータ
 */
function sendSuccessResponse(res, statusCode, data) {
    setCorsHeaders(res);
    res.status(statusCode).json(data);
}

/**
 * Microsoft Graph API のアクセストークン取得（共通処理）
 * 使用箇所: inspection.js, kensho.js
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

module.exports = {
    setCorsHeaders,
    handleCorsPreFlight,
    validatePostMethod,
    sendErrorResponse,
    sendSuccessResponse,
    getRequiredEnvVar,
    getAccessToken
};
