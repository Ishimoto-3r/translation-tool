// api/report.js (CommonJS統一版)
const logger = require('../lib/logger');
const openaiClient = require('../lib/openai-client');
const { handleCorsPreFlight, validatePostMethod, sendErrorResponse, sendSuccessResponse } = require('../lib/api-helpers');

// 依存関係コンテナ（テスト用）
const deps = {
  logger,
  openaiClient
};

async function handler(request, response) {
  // CORS preflight処理
  if (handleCorsPreFlight(request, response)) {
    return;
  }

  // POSTメソッドの検証
  if (!validatePostMethod(request, response)) {
    return;
  }

  try {
    const MODEL_REPORT = process.env.MODEL_REPORT || "gpt-5.2";

    // リクエストボディから最終プロンプトを取得
    const { finalPrompt } = request.body;

    if (!finalPrompt) {
      return sendErrorResponse(response, 400, 'finalPromptが必要です', 'report');
    }

    deps.logger.info('report', `Generating report with model: ${MODEL_REPORT}`);

    // OpenAI Client経由でAPIを呼び出し
    const apiResponse = await deps.openaiClient.chatCompletion({
      model: MODEL_REPORT,
      messages: [
        { role: "user", content: finalPrompt }
      ]
    });

    // レスポンスの取得
    const gptResponse = apiResponse.choices?.[0]?.message?.content?.trim();

    if (!gptResponse) {
      return sendErrorResponse(
        response,
        502,
        'AIからレスポンスが得られませんでした',
        'report'
      );
    }

    // 成功レスポンス
    sendSuccessResponse(response, 200, { gptResponse });

  } catch (error) {
    if (error.message === "OPENAI_API_KEY_MISSING") {
      return sendErrorResponse(
        response,
        500,
        'OPENAI_API_KEYが設定されていません',
        'report'
      );
    }

    sendErrorResponse(
      response,
      500,
      'サーバー内部でエラーが発生しました',
      'report',
      error
    );
  }
}

module.exports = handler;
module.exports._deps = deps;

