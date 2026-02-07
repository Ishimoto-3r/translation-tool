
const nodeMocks = require('node-mocks-http');
const handler = require('../../api/prompt');

// グローバルfetchのモック
global.fetch = jest.fn();

// TextEncoder / TextDecoder (Node環境では必要)
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

describe('API Prompt (prompt.js)', () => {
    let originalEnv;

    beforeEach(() => {
        originalEnv = process.env;
        process.env = { ...originalEnv, OPENAI_API_KEY: 'test-key' };
        jest.clearAllMocks();
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    test('OPTIONSメソッド: 200 OK', async () => {
        const { req, res } = nodeMocks.createMocks({ method: 'OPTIONS' });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        expect(res._isEndCalled()).toBe(true);
    });

    test('POST以外のメソッド: 405 Method Not Allowed', async () => {
        const { req, res } = nodeMocks.createMocks({ method: 'GET' });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(405);
    });

    test('POSTメソッド (パラメータ不足): 400 Bad Request', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: {}
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(400);
    });

    test('正常系: テキストプロンプトとストリームレスポンス', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: { prompt: "Test prompt", model: "gpt-5.1" }
        });

        // ストリームのモック
        const mockStream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                // 独自フォーマット: SSE形式 (data: prefix + JSON + \n\n)
                const chunk1 = "data: " + JSON.stringify({ type: 'response.output_text.delta', delta: "Hello" }) + "\n\n";
                const chunk2 = "data: " + JSON.stringify({ type: 'response.output_text.delta', delta: " World" }) + "\n\n";

                controller.enqueue(encoder.encode(chunk1));
                controller.enqueue(encoder.encode(chunk2));
                controller.close();
            }
        });

        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: mockStream
        });

        // node-mocks-http は res.write をサポートしているが、イベント駆動ではないので
        // ハンドラー完了後に _getData() で確認する
        await handler(req, res);

        expect(global.fetch).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.any(Object));
        expect(res._getStatusCode()).toBe(200);
        // writeされたデータが結合されているか確認
        expect(res._getData()).toBe("Hello World");
    });

    test('OpenAI APIエラー: 500またはAPIのステータス', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: { prompt: "Test prompt" }
        });

        global.fetch.mockResolvedValue({
            ok: false,
            status: 503,
            text: jest.fn().mockResolvedValue("Service Unavailable")
        });

        await handler(req, res); // ここでエラーがthrowされずにres.status(503)が呼ばれるはず

        expect(res._getStatusCode()).toBe(503);
        expect(res._getData()).toBe("Service Unavailable");
    });
});
