// 環境変数を最初に設定 (OpenAI初期化エラー回避)
process.env.OPENAI_API_KEY = "dummy-key";

const nodeMocks = require('node-mocks-http');
const path = require('path');

// モックの設定
jest.mock('openai');
jest.mock('pdf-lib', () => {
    // pdf-libのモック (簡易実装)
    return {
        PDFDocument: {
            create: jest.fn().mockResolvedValue({
                registerFontkit: jest.fn(),
                embedFont: jest.fn().mockResolvedValue({
                    widthOfTextAtSize: (text, size) => text.length * size * 0.5,
                    heightAtSize: (size) => size
                }),
                embedJpg: jest.fn().mockResolvedValue({
                    width: 100,
                    height: 100
                }),
                addPage: jest.fn().mockReturnValue({
                    drawImage: jest.fn(),
                    drawText: jest.fn()
                }),
                save: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
            })
        },
        rgb: jest.fn()
    };
});

jest.mock('fs', () => ({
    existsSync: jest.fn(),
    readFileSync: jest.fn()
}));

const fs = require('fs'); // モック定義の後にrequire

// モック設定後にモジュールを読み込む
const pdftranslate = require('../../api/pdftranslate');
// module.exports = handler なので、pdftranslate 自体が handler関数になる
// かつ、pdftranslate.wrapText などがプロパティとして付与されている
const handler = pdftranslate;
const { wrapText } = pdftranslate;

// OpenAIのモック
const OpenAI = require('openai');
const mockCreate = jest.fn();
OpenAI.mockImplementation(() => ({
    chat: {
        completions: {
            create: mockCreate
        }
    }
}));

describe('PDF翻訳ツール (pdftranslate)', () => {

    describe('wrapText (テキスト折り返しロジック)', () => {
        // フォントのモック
        const mockFont = {
            widthOfTextAtSize: (text, size) => text.length * 10 // 1文字10pxと仮定
        };

        test('指定幅に収まる場合は折り返さない', () => {
            const text = "短いテキスト";
            const lines = wrapText(text, mockFont, 10, 100); // 幅100px, 文字60px
            expect(lines).toEqual(["短いテキスト"]);
        });

        test('指定幅を超える場合は折り返す', () => {
            const text = "これはとても長いテキストです";
            const lines = wrapText(text, mockFont, 10, 50); // 幅50px, 1文字10px -> 5文字で折り返し

            // "これはとても" (6文字) -> 60px > 50px なので折り返されるはず
            expect(lines.length).toBeGreaterThan(1);
            expect(lines[0].length).toBeLessThanOrEqual(5);
        });

        test('空行が含まれる場合も正しく処理する', () => {
            const text = "行1\n\n行2";
            const lines = wrapText(text, mockFont, 10, 100);
            expect(lines).toEqual(["行1", "", "行2"]);
        });
    });

    describe('API Handler', () => {
        beforeEach(() => {
            jest.clearAllMocks();
            process.env.OPENAI_API_KEY = 'test-key';

            // fsモックのデフォルト動作
            const fontPath = path.join(process.cwd(), 'api', 'fonts', 'NotoSansSC-Regular.woff2');
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(Buffer.from('dummy-font'));
        });

        test('POST以外のメソッドは405エラー', async () => {
            const { req, res } = nodeMocks.createMocks({
                method: 'GET'
            });

            await handler(req, res);

            expect(res._getStatusCode()).toBe(405);
        });

        test('必須パラメータ(pages)がない場合は400エラー', async () => {
            const { req, res } = nodeMocks.createMocks({
                method: 'POST',
                body: {}
            });

            await handler(req, res);

            expect(res._getStatusCode()).toBe(400);
        });

        test('正常系: 単純なテキストPDFの翻訳', async () => {
            // OpenAIモックの応答設定
            mockCreate.mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({ translation: "これはテスト翻訳です" })
                    }
                }]
            });

            const { req, res } = nodeMocks.createMocks({
                method: 'POST',
                body: {
                    pages: [
                        { textItems: [{ text: "This is a test" }], width: 595, height: 842 }
                    ],
                    direction: "en-ja"
                }
            });

            await handler(req, res);

            // 成功ステータス
            expect(res._getStatusCode()).toBe(200);

            // PDFバイナリが返されているか
            const headers = res._getHeaders();
            expect(headers['content-type']).toBe('application/pdf');

            // フォント読み込みが呼ばれたか
            expect(fs.existsSync).toHaveBeenCalled();
            expect(fs.readFileSync).toHaveBeenCalled();
        });

        test('異常系: フォントファイルがない場合', async () => {
            fs.existsSync.mockReturnValue(false); // フォントなし

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
});
