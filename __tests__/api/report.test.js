// __tests__/api/report.test.js
// OpenAI clientがモジュールロード時に初期化されるため、requireの前に環境変数を設定
process.env.OPENAI_API_KEY = 'test-api-key-for-initialization';

const httpMocks = require('node-mocks-http');
const handler = require('../../api/report');

// モックの依存関係
const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
};

const mockOpenAIClient = {
    chatCompletion: jest.fn(),
};

// 依存関係をモックと差し替え
handler._deps.logger = mockLogger;
handler._deps.openaiClient = mockOpenAIClient;

describe('レポートツール (report.js)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // デフォルトで環境変数を設定
        process.env.MODEL_REPORT = 'gpt-5.2';
        process.env.OPENAI_API_KEY = 'test-api-key';
    });

    afterEach(() => {
        // 環境変数をクリーンアップ
        delete process.env.MODEL_REPORT;
        delete process.env.OPENAI_API_KEY;
    });

    test('OPTIONSリクエスト: CORSプリフライトが正常に処理される', async () => {
        const req = httpMocks.createRequest({
            method: 'OPTIONS',
        });
        const res = httpMocks.createResponse();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res._isEndCalled()).toBe(true);
    });

    test('POSTメソッド以外: 405エラー', async () => {
        const req = httpMocks.createRequest({
            method: 'GET',
        });
        const res = httpMocks.createResponse();

        await handler(req, res);

        expect(res.statusCode).toBe(405);
        const data = JSON.parse(res._getData());
        expect(data.error).toBe('Method Not Allowed');
    });

    test('finalPromptなし: 400エラー', async () => {
        const req = httpMocks.createRequest({
            method: 'POST',
            body: {},
        });
        const res = httpMocks.createResponse();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        const data = JSON.parse(res._getData());
        expect(data.error).toBe('finalPromptが必要です');
    });

    test('正常系: AIレポート生成成功', async () => {
        const mockResponse = {
            choices: [
                {
                    message: {
                        content: 'これはAIが生成したレポートです。',
                    },
                },
            ],
        };

        mockOpenAIClient.chatCompletion.mockResolvedValue(mockResponse);

        const req = httpMocks.createRequest({
            method: 'POST',
            body: {
                finalPrompt: '売上データを分析してレポートを作成してください。',
            },
        });
        const res = httpMocks.createResponse();

        await handler(req, res);

        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.gptResponse).toBe('これはAIが生成したレポートです。');
        expect(mockOpenAIClient.chatCompletion).toHaveBeenCalledWith({
            model: 'gpt-5.2',
            messages: [
                {
                    role: 'user',
                    content: '売上データを分析してレポートを作成してください。',
                },
            ],
        });
        expect(mockLogger.info).toHaveBeenCalledWith(
            'report',
            'Generating report with model: gpt-5.2'
        );
    });

    test('AIレスポンスが空: 502エラー', async () => {
        const mockResponse = {
            choices: [
                {
                    message: {
                        content: '',
                    },
                },
            ],
        };

        mockOpenAIClient.chatCompletion.mockResolvedValue(mockResponse);

        const req = httpMocks.createRequest({
            method: 'POST',
            body: {
                finalPrompt: 'テストプロンプト',
            },
        });
        const res = httpMocks.createResponse();

        await handler(req, res);

        expect(res.statusCode).toBe(502);
        const data = JSON.parse(res._getData());
        expect(data.error).toBe('AIからレスポンスが得られませんでした');
    });

    test('OpenAI APIキー未設定: 500エラー', async () => {
        delete process.env.OPENAI_API_KEY;

        mockOpenAIClient.chatCompletion.mockRejectedValue(
            new Error('OPENAI_API_KEY_MISSING')
        );

        const req = httpMocks.createRequest({
            method: 'POST',
            body: {
                finalPrompt: 'テストプロンプト',
            },
        });
        const res = httpMocks.createResponse();

        await handler(req, res);

        expect(res.statusCode).toBe(500);
        const data = JSON.parse(res._getData());
        expect(data.error).toBe('OPENAI_API_KEYが設定されていません');
    });

    test('OpenAI API呼び出しエラー: 500エラー', async () => {
        mockOpenAIClient.chatCompletion.mockRejectedValue(
            new Error('Network error')
        );

        const req = httpMocks.createRequest({
            method: 'POST',
            body: {
                finalPrompt: 'テストプロンプト',
            },
        });
        const res = httpMocks.createResponse();

        await handler(req, res);

        expect(res.statusCode).toBe(500);
        const data = JSON.parse(res._getData());
        expect(data.error).toBe('サーバー内部でエラーが発生しました');
    });
});
