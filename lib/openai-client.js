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
            logger.error("OpenAI", "OPENAI_API_KEY is not set (Delayed initialization)");
            this.client = null;
        } else {
            this.client = new OpenAI({ apiKey });
        }
    }

    /**
     * チャット補完APIの呼び出し（JSONモード対応）
     */
    async chatCompletion({ model, messages, jsonMode = false, systemPrompt = null, ...rest }) {
        if (!process.env.OPENAI_API_KEY) {
            throw new Error("OPENAI_API_KEY_MISSING");
        }

        const requestModel = model || process.env.MODEL_TRANSLATE || "gpt-5.1";

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
        // ただし、gpt-5系もこれらをサポートするため除去しない
        const isO1Model = requestModel.startsWith("o1-");
        const isGpt5Model = requestModel.startsWith("gpt-5");
        if (!isO1Model && !isGpt5Model) {
            delete options.reasoning_effort;
            delete options.verbosity;
        }

        if (jsonMode) {
            options.response_format = { type: "json_object" };
        }


        try {
            logger.info("OpenAI", `Calling API with model: ${requestModel}, jsonMode: ${jsonMode}`);

            if (!this.client) {
                const apiKey = process.env.OPENAI_API_KEY;
                if (!apiKey) throw new Error("OPENAI_API_KEY_MISSING");
                this.client = new OpenAI({ apiKey });
            }

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
