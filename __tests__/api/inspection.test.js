// 環境変数のダミー設定 (OpenAI初期化より前に実行)
process.env.OPENAI_API_KEY = "dummy-key";
process.env.MANUAL_TENANT_ID = "dummy-tenant";
process.env.MANUAL_CLIENT_ID = "dummy-client";
process.env.MANUAL_CLIENT_SECRET = "dummy-secret";
process.env.INSPECTION_TEMPLATE_URL = "dummy-url";

const nodeMocks = require('node-mocks-http');
const fs = require('fs');

// ==== Mocks ====

// OpenAI Mock
jest.mock('openai');
const OpenAI = require('openai');
const mockResponsesCreate = jest.fn();
const mockFilesCreate = jest.fn().mockResolvedValue({ id: "dummy-file-id" }); // id返却
OpenAI.mockImplementation(() => ({
    responses: {
        create: mockResponsesCreate
    },
    files: {
        create: mockFilesCreate
    }
}));

// ExcelJS Mock
jest.mock('exceljs', () => {
    return {
        Workbook: jest.fn().mockImplementation(() => ({
            xlsx: {
                load: jest.fn().mockResolvedValue(),
                writeBuffer: jest.fn().mockResolvedValue(Buffer.from('dummy-excel'))
            },
            getWorksheet: jest.fn().mockImplementation((name) => {
                if (name === "検品項目リスト") {
                    return {
                        eachRow: jest.fn().mockImplementation((callback) => {
                            // 選択リストのダミーデータ (row, rowNumber)
                            callback({
                                getCell: (col) => {
                                    if (col === 1) return { value: "選択リスト" }; // A列
                                    if (col === 2) return { value: "安全" };       // B列
                                    if (col === 3) return { value: "電源コード" }; // C列
                                    return { value: "" };
                                }
                            }, 1);
                        })
                    };
                }
                if (name === "検品リスト") {
                    return {
                        rowCount: 20,
                        getRow: jest.fn().mockImplementation((r) => {
                            // マーカー行のシミュレーション
                            let val = "";
                            if (r === 10) val = "__INS_SPEC__";
                            if (r === 11) val = "__INS_OP__";
                            if (r === 12) val = "__INS_ACC__";
                            if (r === 13) val = "__INS_SELECT__";

                            return {
                                getCell: jest.fn().mockReturnValue({ value: val, style: {} })
                            };
                        }),
                        spliceRows: jest.fn(), // 行挿入
                        columnCount: 12
                    };
                }
                return { name: name }; // その他シート
            }),
            eachSheet: jest.fn(),
            worksheets: [
                { name: "検品リスト" },
                { name: "検品項目リスト" },
                { name: "不要シート" }
            ],
            removeWorksheet: jest.fn(),
            views: []
        }))
    };
});

// pdfjs-dist Mock
jest.mock('pdfjs-dist/legacy/build/pdf.js', () => ({
    getDocument: jest.fn().mockReturnValue({
        promise: Promise.resolve({
            numPages: 1,
            getPage: jest.fn().mockResolvedValue({
                getTextContent: jest.fn().mockResolvedValue({
                    items: [{ str: "This is a dummy PDF text content." }]
                })
            })
        })
    })
}));

// fetch Mock (global)
global.fetch = jest.fn();

// Import Handler (must be after mocks)
const handler = require('../../api/inspection');

describe('検品リスト作成ツール (inspection.js)', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        // Fetch mock default success
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({ access_token: "dummy-token" }),
            text: jest.fn().mockResolvedValue("dummy-text"),
            arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
            headers: {
                get: (key) => {
                    if (key.toLowerCase() === 'content-type') return 'application/pdf';
                    return '';
                }
            }
        });
    });

    test('POST以外のメソッドは405エラー', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'GET',
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(405);
    });

    test('op=meta: テンプレートから選択リストを取得', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'meta' }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.selectionItems).toEqual(["電源コード"]); // ExcelMockで定義した値
    });

    test('op=extract: 不正なリクエスト (URLなし)', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'extract' },
            body: {}
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(400);
    });

    test('op=extract: 正常系 (PDF URL指定)', async () => {
        // OpenAIのレスポンスモック
        mockResponsesCreate.mockResolvedValue({
            output_text: JSON.stringify({
                model: "3R-TEST",
                productName: "Test Product",
                specs: ["Spec 1"],
                ops: [{ title: "OpTitle", items: ["Op 1"] }],
                accs: ["Acc 1"]
            })
        });

        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'extract' },
            body: { pdfUrl: "https://example.com/manual.pdf" }
        });

        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.model).toBe("3R-TEST");
    });

    test('op=generate: Excel生成', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'generate' },
            body: {
                model: "3R-GEN",
                productName: "Gen Product",
                specText: ["Spec A"],
                opItems: ["Op A"],
                accText: ["Acc A"]
            }
        });

        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.fileName).toContain("3R-GEN");
        expect(data.fileBase64).toBeDefined();
    });

    test('op=generate: 必須パラメータ不足', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'generate' },
            body: {
                // model missing
                productName: "Product"
            }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(400);
    });
});
