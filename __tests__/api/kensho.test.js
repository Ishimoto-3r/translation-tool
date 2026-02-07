// 環境変数のダミー設定
process.env.OPENAI_API_KEY = "dummy-key";
process.env.MANUAL_TENANT_ID = "dummy-tenant";
process.env.MANUAL_CLIENT_ID = "dummy-client";
process.env.MANUAL_CLIENT_SECRET = "dummy-secret";
process.env.MANUAL_SHAREPOINT_FILE_URL = "https://dummy-sharepoint";

const nodeMocks = require('node-mocks-http');
const handler = require('../../api/kensho');

// モック
global.fetch = jest.fn();

describe('検証ツール (kensho.js)', () => {
    let mockOpenAIClient;

    beforeEach(() => {
        jest.clearAllMocks();

        mockOpenAIClient = {
            chatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            commentPoints: ["Point 1", "Point 2"],
                            specCandidates: ["Spec 1"],
                            gatingQuestions: ["Question 1"]
                        })
                    }
                }]
            })
        };
        handler._deps.openaiClient = mockOpenAIClient;

        // Fetch モック (SharePoint用)
        global.fetch.mockResolvedValue({
            ok: true,
            json: jest.fn().mockResolvedValue({ access_token: "dummy-token" }),
            text: jest.fn().mockResolvedValue(""),
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
        });
    });

    // xlsx, exceljsの処理まで含めるとテストが非常に大きくなるため、
    // ここでは handler のルーティングと AI 呼び出し部分を中心にテストする。
    // シート処理自体はライブラリ依存なので、リファクタリングの影響範囲は少ないと仮定。

    test('op=ai: 正常系 (AIコメント生成)', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'ai' },
            body: {
                productInfo: { name: "Test Product" },
                selectedLabels: ["L1", "L2"],
                currentRows: []
            }
        });

        await handler(req, res);

        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.text).toContain("commentPoints");

        expect(mockOpenAIClient.chatCompletion).toHaveBeenCalledWith(
            expect.objectContaining({
                model: expect.any(String),
                messages: expect.any(Array)
            })
        );
    });

    test('op=unknown: 404エラー', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'GET',
            query: { op: 'invalid' }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(404);
    });

    test('op=db: POST (base64なし) -> 400エラー', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'db' },
            body: {}
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(400);
    });
});
