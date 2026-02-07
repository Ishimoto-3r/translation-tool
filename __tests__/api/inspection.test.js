// 環境変数のダミー設定
process.env.OPENAI_API_KEY = "dummy-key";
process.env.INSPECTION_TEMPLATE_URL = "https://dummy-sharepoint/template.xlsx";
process.env.MANUAL_TENANT_ID = "dummy-tenant";
process.env.MANUAL_CLIENT_ID = "dummy-client";
process.env.MANUAL_CLIENT_SECRET = "dummy-secret";

const nodeMocks = require('node-mocks-http');

// モックの定義
const mockWorksheet = {
    eachRow: jest.fn(),
    getCell: jest.fn(),
    getRow: jest.fn(),
    rowCount: 100,
    spliceRows: jest.fn(),
    columnCount: 20
};

const mockWorkbook = {
    xlsx: {
        load: jest.fn().mockResolvedValue(),
        writeBuffer: jest.fn().mockResolvedValue(Buffer.from("dummy-excel"))
    },
    getWorksheet: jest.fn().mockReturnValue(mockWorksheet),
    eachSheet: jest.fn() // generateExcelで使用
};

const mockPDFPage = {
    getTextContent: jest.fn().mockResolvedValue({
        items: [{ str: "Test PDF Content" }]
    })
};

const mockPDFDocument = {
    numPages: 1,
    getPage: jest.fn().mockResolvedValue(mockPDFPage)
};

const mockPDFJS = {
    getDocument: jest.fn().mockReturnValue({
        promise: Promise.resolve(mockPDFDocument)
    })
};

// モジュールモック
jest.mock('exceljs', () => {
    return {
        Workbook: jest.fn().mockImplementation(() => mockWorkbook)
    };
});

jest.mock('pdfjs-dist/legacy/build/pdf.js', () => mockPDFJS);

// fetchのグローバルモック
global.fetch = jest.fn();

// ハンドラーの読み込み（モック定義後）
const handler = require('../../api/inspection');

describe('検品リスト作成ツール (inspection.js)', () => {
    let mockOpenAIClient;

    beforeEach(() => {
        jest.clearAllMocks();

        // fetchのデフォルト動作 (Token & SharePoint)
        global.fetch.mockImplementation((url) => {
            if (url.includes('oauth2/v2.0/token')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ access_token: "dummy-token" })
                });
            }
            if (url.includes('graph.microsoft.com') || url.includes('dummy-sharepoint')) {
                return Promise.resolve({
                    ok: true,
                    arrayBuffer: async () => new ArrayBuffer(10), // Dummy Excel file
                    text: async () => "dummy text",
                    headers: { get: () => "application/pdf" }
                });
            }
            return Promise.resolve({
                ok: true,
                arrayBuffer: async () => new ArrayBuffer(10),
                json: async () => ({}),
                text: async () => "",
                headers: { get: () => "application/pdf" }
            });
        });

        // OpenAI Client Mock
        mockOpenAIClient = {
            chatCompletion: jest.fn().mockResolvedValue({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            model: "Model-123",
                            productName: "Product-X",
                            specs: ["Spec 1"],
                            ops: [{ title: "OpTitle", items: ["OpItem 1"] }],
                            accs: ["Acc 1"]
                        })
                    }
                }]
            }),
            client: {
                files: {
                    create: jest.fn().mockResolvedValue({ id: "file-id-123" })
                }
            }
        };
        handler._deps.openaiClient = mockOpenAIClient;

        // ExcelJS Mock Setup (Default behavior)
        mockWorkbook.getWorksheet.mockReturnValue(mockWorksheet);
        mockWorksheet.getCell.mockReturnValue({ value: "dummy", style: {}, border: {} });
        mockWorksheet.getRow.mockReturnValue({
            getCell: jest.fn().mockReturnValue({ value: "dummy", style: {}, border: {} }),
            eachCell: jest.fn()
        });
    });

    // --- op=meta ---
    test('op=meta: 正常系 - 検品項目リストを取得', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'GET',
            query: { op: 'meta' }
        });

        // Mock sheet behavior for extracting items
        // A列="選択リスト", C列="Item1"
        mockWorksheet.eachRow.mockImplementation((callback) => {
            const rowMock = {
                getCell: (idx) => {
                    if (idx === 1) return { value: "選択リスト" };
                    if (idx === 3) return { value: "Item1" };
                    return { value: "" };
                }
            };
            callback(rowMock, 1);
        });

        await handler(req, res);

        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.selectionItems).toContain("Item1");
        expect(global.fetch).toHaveBeenCalled(); // Template download
        expect(mockWorkbook.xlsx.load).toHaveBeenCalled();
    });

    // --- op=extract ---
    test('op=extract: 正常系 - PDFバッファから抽出', async () => {
        const pdfBuffer = Buffer.from("dummy pdf content");
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'extract' },
            headers: { 'content-type': 'application/pdf' },
            body: pdfBuffer
        });

        await handler(req, res);

        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.model).toBe("Model-123");
        expect(mockPDFJS.getDocument).toHaveBeenCalled();
        expect(mockOpenAIClient.chatCompletion).toHaveBeenCalled();
    });

    test('op=extract: 正常系 - HTML URLから抽出', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'extract' },
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pdfUrl: "http://example.com/page.html" })
        });

        // HTMLレスポンスのモック
        global.fetch.mockImplementation((url) => {
            if (url === "http://example.com/page.html") {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    text: jest.fn().mockResolvedValue("<html><body><h1>Product Info</h1><p>Model: M1</p></body></html>"),
                    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
                    headers: { get: () => "text/html" }
                });
            }
            // 他のfetch (template等)
            if (url.includes('oauth2/v2.0/token')) {
                return Promise.resolve({
                    ok: true,
                    json: async () => ({ access_token: "dummy-token" })
                });
            }
            // default
            return Promise.resolve({
                ok: true,
                arrayBuffer: async () => new ArrayBuffer(10),
                json: async () => ({}),
                text: async () => "",
                headers: { get: () => "application/pdf" }
            });
        });

        await handler(req, res);

        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        // extraction logic uses mockOpenAIClient, which returns standard result
        expect(data.model).toBe("Model-123");
        // HTML path should NOT call PDFJS
        expect(mockPDFJS.getDocument).not.toHaveBeenCalled();
        expect(mockOpenAIClient.chatCompletion).toHaveBeenCalled();
    });

    test('op=extract: 正常系 - HTMLからPDFリンク検出', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'extract' },
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pdfUrl: "http://example.com/manual-page" })
        });

        global.fetch.mockImplementation((url) => {
            if (url === "http://example.com/manual-page") {
                return Promise.resolve({
                    ok: true, status: 200,
                    headers: { get: () => "text/html" },
                    text: jest.fn().mockResolvedValue(`
                        <html><body>
                            <a href="manual.pdf">User Manual</a>
                        </body></html>
                    `)
                });
            }
            if (url.endsWith("manual.pdf")) {
                return Promise.resolve({
                    ok: true, status: 200,
                    headers: { get: () => "application/pdf" },
                    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(100))
                });
            }
            // Default / Other calls
            return Promise.resolve({
                ok: true,
                json: async () => ({ access_token: "dummy" }),
                arrayBuffer: async () => new ArrayBuffer(10),
                text: async () => "",
                headers: { get: () => "application/pdf" }
            });
        });

        await handler(req, res);

        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.model).toBe("Model-123");
        expect(mockPDFJS.getDocument).toHaveBeenCalled();
    });

    test('op=extract: 正常系 - JSON-LDからPDFリンク検出', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'extract' },
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pdfUrl: "http://example.com/jsonld-page" })
        });

        global.fetch.mockImplementation((url) => {
            if (url === "http://example.com/jsonld-page") {
                return Promise.resolve({
                    ok: true, status: 200,
                    headers: { get: () => "text/html" },
                    text: jest.fn().mockResolvedValue(`
                        <html>
                        <script type="application/ld+json">
                            {
                                "@context": "https://schema.org",
                                "@type": "Product",
                                "contentUrl": "http://example.com/manual-json.pdf"
                            }
                        </script>
                        <body>No Link Here</body>
                        </html>
                    `)
                });
            }
            if (url.endsWith("manual-json.pdf")) {
                return Promise.resolve({
                    ok: true, status: 200,
                    headers: { get: () => "application/pdf" },
                    arrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(100))
                });
            }
            return Promise.resolve({
                ok: true,
                json: async () => ({ access_token: "dummy" }),
                arrayBuffer: async () => new ArrayBuffer(10),
                text: async () => "",
                headers: { get: () => "application/pdf" }
            });
        });

        await handler(req, res);
        expect(res._getStatusCode()).toBe(200);
        expect(mockPDFJS.getDocument).toHaveBeenCalled();
    });

    // --- op=generate ---
    test('op=generate: 正常系 - Excel生成', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            query: { op: 'generate' },
            body: {
                model: "M1",
                productName: "P1",
                specText: ["S1"],
                opTitles: ["T1"],
                opItems: ["I1"],
                accText: ["A1"]
            }
        });

        // Mock worksheet for generate
        const wsMain = { ...mockWorksheet, rowCount: 20, spliceRows: jest.fn() };
        const wsList = { ...mockWorksheet };

        mockWorkbook.getWorksheet.mockImplementation((name) => {
            if (name === "検品リスト") return wsMain;
            if (name === "検品項目リスト") return wsList;
            if (name === "検品用画像") return { name: "検品用画像" }; // 削除されないシート
            if (name === "検品外観基準") return { name: "検品外観基準" }; // 削除されないシート
            return { name: "不要シート" }; // 削除されるシート
        });

        mockWorkbook.worksheets = [wsMain, wsList, { name: "検品用画像" }, { name: "検品外観基準" }, { name: "不要シート" }];
        mockWorkbook.removeWorksheet = jest.fn();

        // findMarkerRowでマーカーを見つける
        // __INS_SPEC__, __INS_OP__, __INS_ACC__, __INS_SELECT__
        wsMain.getRow.mockImplementation((r) => {
            let val = "";
            if (r === 5) val = "__INS_SPEC__";
            if (r === 10) val = "__INS_OP__";
            if (r === 15) val = "__INS_ACC__";
            if (r === 18) val = "__INS_SELECT__";
            return {
                getCell: (c) => ({ value: (c === 1 ? val : ""), style: {}, border: {} })
            };
        });

        await handler(req, res);

        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data).toHaveProperty('fileBase64');
        expect(data).toHaveProperty('fileName');
        expect(data.fileName).toContain("M1");
    });

    test('op=unknown: 404エラー', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'GET',
            query: { op: 'invalid' }
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(404);
    });
});

