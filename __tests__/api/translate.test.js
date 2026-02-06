// 環境変数のダミー設定
process.env.OPENAI_API_KEY = "dummy-key";

const nodeMocks = require('node-mocks-http');
const handler = require('../../api/translate');

// Global fetch mock
global.fetch = jest.fn();

describe('総合翻訳ツール (translate.js)', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        // Default Fetch Mock (OpenAI)
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({ translatedText: "Translated Text", translations: ["T1", "T2"] })
                    }
                }]
            })
        });
    });

    test('opなし: デフォルトでtextモードとして動作', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: { userPrompt: "Hello" }
            // query.op undefined
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.translatedText).toBe("Translated Text");
    });

    test('op=unknown: 400エラー', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'GET',
            query: { op: 'invalid' }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(400);
    });

    // op=text
    test('op=text: 正常系', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'text' },
            body: { userPrompt: "Hello", sourceLang: "en", targetLang: "ja" }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.translatedText).toBe("Translated Text");
    });

    test('op=text: userPromptなしで400エラー', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'text' },
            body: {}
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(400);
    });

    // op=sheet/word/verify (rows translate)
    test('op=sheet: 正常系', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'sheet' },
            body: { rows: ["A", "B"], toLang: "ja" }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.translations).toEqual(["T1", "T2"]);
    });

    test('op=word: 正常系 (プロンプトは内部で切り替わるがレスポンス形式は同じ)', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'word' },
            body: { rows: ["A", "B"], toLang: "ja", context: "Technical" }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.translations).toEqual(["T1", "T2"]);
    });

    test('op=sheet: rowsなしで400エラー', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'sheet' },
            body: { toLang: "ja" }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(400);
    });

    test('OpenAI APIがエラーを返した場合 (502 ParseError)', async () => {
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: "Invalid JSON"
                    }
                }]
            })
        });

        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'text' },
            body: { userPrompt: "Hello" }
        });
        await handler(req, res);
        // textモードは空文字チェックで502になるか、パースエラーは空objになりtranslatedTextが空で502になる
        expect(res._getStatusCode()).toBe(502);
    });
});
