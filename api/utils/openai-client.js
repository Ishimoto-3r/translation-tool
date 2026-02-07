// api/utils/openai-client.js
const OpenAI = require("openai");
const logger = require("./logger");

/**
 * OpenAI APIクライアントのラッパー
 * - APIキーの共通チェック
 * - 共通エラーハンドリング
 */
class OpenAIClient {
    constructor() {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            logger.error("OpenAI", "OPENAI_API_KEY is not set");
            // ここでthrowせず、呼び出し時にエラーハンドリングさせる設計
        }
        this.client = new OpenAI({ apiKey });
    }

    /**
     * チャット補完APIの呼び出し（JSONモード対応）
     */
    async chatCompletion({ model, messages, jsonMode = false, systemPrompt = null, ...rest }) {
        if (!process.env.OPENAI_API_KEY) {
            throw new Error("OPENAI_API_KEY_MISSING");
        }

        const requestModel = model || process.env.MODEL_TRANSLATE || "gpt-4-turbo";

        // systemPromptがある場合はmessagesの先頭に追加（破壊的変更を避けるためコピー使用）
        const requestMessages = [...messages];
        if (systemPrompt) {
            requestMessages.unshift({ role: "system", content: systemPrompt });
        }

        const options = {
            model: requestModel,
            messages: requestMessages,
            ...rest
        };

        // ガード処理: o1系モデル以外では reasoning_effort / verbosity を除去する
        // ※OpenAI APIはサポート外のパラメータを送ると400エラーになるため
        const isO1Model = requestModel.startsWith("o1-");
        if (!isO1Model) {
            delete options.reasoning_effort;
            delete options.verbosity;
        }

        if (jsonMode) {
            options.response_format = { type: "json_object" };
        }


        try {
            logger.info("OpenAI", `Calling API with model: ${requestModel}, jsonMode: ${jsonMode}`);
            const response = await this.client.chat.completions.create(options);
            return response;
        } catch (error) {
            logger.error("OpenAI", "API Call Failed", { message: error.message });
            throw error;
        }
    }

    // 必要に応じて他のメソッド（whisper, visionなど）も追加可能
}

// シングルトンとしてエクスポート
module.exports = new OpenAIClient();
