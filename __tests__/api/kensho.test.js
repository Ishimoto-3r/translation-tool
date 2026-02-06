// 環境変数のダミー設定
process.env.OPENAI_API_KEY = "dummy-key";
process.env.MANUAL_TENANT_ID = "dummy-tenant";
process.env.MANUAL_CLIENT_ID = "dummy-client";
process.env.MANUAL_CLIENT_SECRET = "dummy-secret";
process.env.MANUAL_SHAREPOINT_FILE_URL = "dummy-sharepoint-url";

const nodeMocks = require('node-mocks-http');
const fs = require('fs');

// ==== Mocks ====

// OpenAI Mock
jest.mock('openai');
const OpenAI = require('openai');
const mockChatCompletionsCreate = jest.fn();
OpenAI.mockImplementation(() => ({
    chat: {
        completions: {
            create: mockChatCompletionsCreate
        }
    }
}));

// xlsx Mock
jest.mock('xlsx', () => ({
    read: jest.fn().mockReturnValue({
        Sheets: {
            "検証ラベル分類": {},
            "検証項目リスト": {},
            "初回検証フォーマット": {},
            "量産前検証フォーマット": {}
        },
        SheetNames: ["検証ラベル分類", "検証項目リスト", "初回検証フォーマット", "量産前検証フォーマット"]
    }),
    utils: {
        sheet_to_json: jest.fn().mockImplementation((sheet, opts) => {
            // ダミーデータ返却
            // verify label logic
            if (sheet === undefined) return []; // safety
            // 簡易的に空配列か、必要なら中身を返すロジックを入れるが、今回はモック側で制御せずともテスト側でモック戻り値を調整可能ならそうする
            // ここではデフォルト空配列を返し、テストケース別にmockReturnValueOnceで上書きする設計にするか、
            // 引数のsheetオブジェクトを見て判断するか。
            // xlsx.readが返すSheetsオブジェクトの参照を見て判断するのは難しい（mockReturnValueなので）。
            // よって、sheet_to_jsonはデフォルト配列を返し、テスト内でspyOnして上書きする戦略をとる。
            return [];
        })
    }
}));
const xlsx = require('xlsx');

// ExcelJS Mock
jest.mock('exceljs', () => ({
    Workbook: jest.fn().mockImplementation(() => ({
        xlsx: {
            load: jest.fn().mockResolvedValue(),
            writeBuffer: jest.fn().mockResolvedValue(Buffer.from('dummy-excel-buffer'))
        },
        getWorksheet: jest.fn().mockImplementation((name) => {
            const mockRow = {
                getCell: jest.fn().mockReturnValue({ value: "", style: {}, border: {}, font: {}, alignment: {} }),
            };
            return {
                name: name,
                id: 1,
                rowCount: 10,
                getRow: jest.fn().mockReturnValue(mockRow),
                eachRow: jest.fn(),
                getCell: jest.fn().mockReturnValue({ value: "" })
            };
        }),
        worksheets: [], // removeWorksheet用
        removeWorksheet: jest.fn()
    }))
}));

// fetch Mock (global)
global.fetch = jest.fn();

// Import Handler
const handler = require('../../api/kensho');

describe('検証項目作成ツール (kensho.js)', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        // Default Fetch Mock
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({ access_token: "dummy-token" }),
            text: jest.fn().mockResolvedValue("dummy-text"),
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
            headers: { get: () => '' }
        });
    });

    test('POST以外のメソッドは404エラー (handler直下で判定せず、各op関数内で判定しているが、opなしやunknown opの場合)', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'GET',
            query: { op: 'unknown' }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(404);
    });

    // op=db
    test('op=db: GET (SharePointから取得)', async () => {
        // xlsxのモック戻り値を設定
        xlsx.utils.sheet_to_json.mockReturnValue([
            { "ラベル名": "L1", "ジャンル名": "G1", "ジャンル表示順": 1, "ジャンル内表示順": 1 }
        ]);

        const { req, res } = nodeMocks.createMocks({
            method: 'GET',
            query: { op: 'db' }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.labelMaster).toHaveLength(1);
    });

    test('op=db: POST (Base64アップロード)', async () => {
        xlsx.utils.sheet_to_json.mockReturnValue([]);
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'db' },
            body: { base64: "ZHVtbXk=" } // dummy base64
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
    });

    // op=template
    test('op=template: GET (テンプレートDL)', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'GET',
            query: { op: 'template', type: 'first' }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        // buffer check
        expect(Buffer.isBuffer(res._getData())).toBe(true);
    });

    // op=ai
    test('op=ai: POST (AIコメント生成)', async () => {
        mockChatCompletionsCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify({ commentPoints: ["Point 1"] })
                }
            }]
        });

        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'ai' },
            body: { productInfo: { name: "Test" } }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        const inner = JSON.parse(data.text);
        expect(inner.commentPoints).toContain("Point 1");
    });

    // op=generate
    test('op=generate: POST (検証ファイル生成)', async () => {
        // AI suggest mock
        mockChatCompletionsCreate.mockResolvedValue({
            choices: [{
                message: {
                    content: JSON.stringify({ items: [{ text: "Item 1", note: "Note 1" }] })
                }
            }]
        });

        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'generate' },
            body: {
                selectedLabels: ["L1"],
                productInfo: { name: "Test Product" }
            }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
    });

});
