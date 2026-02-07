// 環境変数のダミー設定
process.env.OPENAI_API_KEY = "dummy-key";

const nodeMocks = require('node-mocks-http');
const handler = require('../../api/pdftranslate');

// フォントファイルの存在確認が必要になるため、fsをモックするか、実際のファイルを読み込ませるか。
// ここでは統合テスト的に実際のファイル読み込みを行わせるが、パス解決でエラーになる可能性があるため
// 必要に応じて fs.existsSync をモックする。
const fs = require('fs');
jest.spyOn(fs, 'existsSync').mockReturnValue(true);
jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from("dummy-font-content"));

// pdf-lib もモック化して、実際のPDF生成を行わないようにする（速度向上と複雑さ回避）
// embedFontなどは非同期なのでモックが必要
jest.mock('pdf-lib', () => ({
    PDFDocument: {
        create: jest.fn().mockResolvedValue({
            registerFontkit: jest.fn(),
            embedFont: jest.fn().mockResolvedValue('CustomFont'),
            addPage: jest.fn().mockReturnValue({
                drawText: jest.fn(),
                drawImage: jest.fn(),
                setSize: jest.fn()
            }),
            embedJpg: jest.fn().mockResolvedValue({ width: 100, height: 100 }),
            save: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
        })
    },
    rgb: jest.fn()
}));


describe('PDF翻訳ツール (pdftranslate.js)', () => {
    let mockOpenAIClient;

    beforeEach(() => {
        jest.clearAllMocks();

        // モッククライアント
        mockOpenAIClient = {
            chatCompletion: jest.fn()
        };
        // DI注入
        handler._deps.openaiClient = mockOpenAIClient;
    });

    test('メソッド不正 (非POST): 405エラー', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'GET',
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(405);
    });

    test('pagesなし: 400エラー', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: {}
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(400);
    });

    test('URL指定 (プレビュー用): 正常系', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(10))
        });

        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: { url: "http://example.com/test.pdf" }
        });

        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.contentType).toBe('application/pdf');
        expect(data.pdfBase64).toBeDefined();
    });

    test('テキスト翻訳: 正常系', async () => {
        mockOpenAIClient.chatCompletion.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify({ translation: "Translated Content" })
                }
            }]
        });

        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: {
                pages: [{
                    textItems: [{ text: "Original Content" }],
                    width: 595,
                    height: 842
                }],
                direction: "ja-zh"
            }
        });

        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        // PDFバイナリが返ってくる
        expect(res._getData()).toBeInstanceOf(Buffer);
        // OpenAI呼び出し引数確認
        expect(mockOpenAIClient.chatCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ jsonMode: true })
        );
    });

    test('画像（Vision）翻訳: 正常系', async () => {
        mockOpenAIClient.chatCompletion.mockResolvedValue({
            choices: [{
                message: {
                    content: "Detected Text"
                }
            }]
        });

        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: {
                pages: [{
                    image: "data:image/png;base64,dummyBase64",
                    width: 595,
                    height: 842
                }],
                direction: "ja-en"
            }
        });

        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        expect(mockOpenAIClient.chatCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ jsonMode: false, model: "gpt-4o" })
        );
    });

    test('APIエラー時のハンドリング: 500エラー', async () => {
        mockOpenAIClient.chatCompletion.mockRejectedValue(new Error("API Error"));

        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: {
                pages: [{ textItems: [{ text: "test" }] }]
            }
        });

        await handler(req, res);
        expect(res._getStatusCode()).toBe(500);
        const data = JSON.parse(res._getData());
        expect(data.error).toBe("Translation failed");
    });
});
