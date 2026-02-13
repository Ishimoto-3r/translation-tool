// api/utils/logger.js
// Vercelログやローカルデバッグで見やすい統一フォーマットを提供するロガー

const formatMessage = (level, context, message, meta = null) => {
    const timestamp = new Date().toISOString();
    // Vercelのログ直感性を考慮し、JSON形式で出力するのがベストプラクティスだが、
    // 簡易視認性を重視してテキストベースにする。(必要に応じてJSONへ切り替え可)
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    return `[${timestamp}] [${level}] [${context}] ${message}${metaStr}`;
};

const logger = {
    info: (context, message, meta) => {
        console.log(formatMessage("INFO", context, message, meta));
    },
    warn: (context, message, meta) => {
        console.warn(formatMessage("WARN", context, message, meta));
    },
    error: (context, message, meta) => {
        console.error(formatMessage("ERROR", context, message, meta));
    },
    debug: (context, message, meta) => {
        // Vercelの本番環境(NODE_ENV=production)ではdebugログを抑制する制御も可能だが、
        // トラブルシュート用に一旦出力する
        console.log(formatMessage("DEBUG", context, message, meta));
    },
};

module.exports = logger;
