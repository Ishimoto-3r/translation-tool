// 環境変数のダミー設定
process.env.OPENAI_API_KEY = "dummy-key";

// トップレベルでのrequireは削除し、beforeEach内でjest.resetModules()後にrequireする
// const nodeMocks = require('node-mocks-http');
// const handler = require('../../api/pdftranslate');

// fsのモック化はbeforeEachで行うが、jest.mockはhoistingされるためトップレベルに書くのが一般的だが、
// resetModulesを使う場合は注意が必要。
// ここでは、一旦トップレベルのモック定義を削除し、describeブロック内のbeforeEachで
// jest.doMock を使って定義するか、あるいは
// トップレベルのjest.mock定義を残しつつ、実装を操作できるようにする。

// グローバルなモック変数を定義（テストケースからアクセス用）
// これらは module scope 変数として定義しておき、mock implementation 内で参照する。
let globalMockPDFDocumentCreate = jest.fn();

jest.mock('pdf-lib', () => ({
    PDFDocument: {
        create: (...args) => globalMockPDFDocumentCreate(...args)
    },
    rgb: jest.fn()
}));

jest.mock('@pdf-lib/fontkit', () => ({
    register: jest.fn()
}));

jest.mock('../../api/utils/openai-client', () => ({
    chatCompletion: jest.fn()
}));


let mockOpenAIClient;
let nodeMocks;
let fs;
let handler;

beforeEach(() => {
    jest.resetModules(); // キャッシュクリア
    process.env.OPENAI_API_KEY = "dummy-key";

    // モックの実装をリセット＆再設定

    // pdf-lib
    globalMockPDFDocumentCreate.mockReset();
    const mockPDFDocInstance = {
        registerFontkit: jest.fn(),
        embedFont: jest.fn().mockResolvedValue('CustomFont'),
        addPage: jest.fn().mockReturnValue({
            drawText: jest.fn(),
            drawImage: jest.fn(),
            setSize: jest.fn()
        }),
        embedJpg: jest.fn().mockResolvedValue({ width: 100, height: 100 }),
        save: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))
    };
    globalMockPDFDocumentCreate.mockResolvedValue(mockPDFDocInstance);

    // OpenAI Client
    // jest.mockで定義済みなのでrequireしてmockを取得
    mockOpenAIClient = require('../../api/utils/openai-client');
    mockOpenAIClient.chatCompletion.mockReset();

    // fs (Node標準モジュール)
    // resetModulesするとspyOnも消えるので再設定
    fs = require('fs');
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from("dummy-font-content"));

    nodeMocks = require('node-mocks-http');

    // handlerを再require (これでモックが適用された状態の依存関係が読み込まれる)
    handler = require('../../api/pdftranslate');

    // DI注入
    handler._deps.openaiClient = mockOpenAIClient;
});

afterEach(() => {
    jest.clearAllMocks();
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
    // chatCompletionのモックレスポンスを設定
    // pdftranslate.jsの実装では、contentをJSON.parseしているため、
    // 文字列化されたJSONを返す必要がある
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
                // width/heightがないとデフォルト値が使われるが、ロジック上は問題ない
                width: 595,
                height: 842
            }],
            direction: "ja-zh"
        }
    });

    await handler(req, res);

    // エラー時のログ出力を確認するために追加（デバッグ用）
    if (res._getStatusCode() !== 200) {
        console.error("Test failed response:", res._getData());
    }

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

    // ダミーのJPEGデータを用意（有効なJPEGヘッダーを持つBase64）
    // pdf-libの実装がモック化されていても、Buffer.fromなどで処理される際に
    // 形式が不正だとエラーになる可能性があるため、よりそれらしいデータを使う
    const { req, res } = nodeMocks.createMocks({
        method: 'POST',
        body: {
            pages: [{
                // pdf-libがモック化されているため、embedJpgの実装は呼ばれないはず。
                // したがって、データの中身は何でも良いはずだが、
                // handler内で `replace` が走り、`Buffer.from` が走る。
                // Buffer.from が失敗しなければエラーにはならないはず。
                // 前回のエラー "SOI not found" は pdf-lib 内部のエラーメッセージなので、
                // 依然として実物が動いている疑いがある。
                // しかし mockPDFDocumentCreate を導入したので、確実にモックが呼ばれるはず。
                // ここでは念のため、シンプルなデータに戻す。
                image: "data:image/jpeg;base64,DummyJpegBase64",
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

test('APIエラー時のハンドリング: 翻訳APIエラーでもPDF生成は継続（200 OK）', async () => {
    // beforeEachでデフォルト成功するように設定されているため、
    // PDFDocument.createのリセットは不要。

    // OpenAIのエラーのみ設定
    mockOpenAIClient.chatCompletion.mockReset();
    mockOpenAIClient.chatCompletion.mockRejectedValue(new Error("API Error"));

    const { req, res } = nodeMocks.createMocks({
        method: 'POST',
        body: {
            pages: [{
                textItems: [{ text: "test" }],
                width: 595,
                height: 842
            }],
            direction: "ja-zh"
        }
    });

    await handler(req, res);
    // 翻訳APIエラーでも、エラーメッセージ入りのPDFを返して200になる仕様
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData()).toBeInstanceOf(Buffer);
});

test('重大な内部エラー: 500エラー', async () => {
    // PDFDocument.create自体を失敗させて500エラーを誘発
    globalMockPDFDocumentCreate.mockRejectedValueOnce(new Error("Critical PDF Error"));

    const { req, res } = nodeMocks.createMocks({
        method: 'POST',
        body: {
            pages: [{
                textItems: [{ text: "test" }],
                width: 595,
                height: 842
            }],
            direction: "ja-zh"
        }
    });

    await handler(req, res);
    expect(res._getStatusCode()).toBe(500);
    const data = JSON.parse(res._getData());
    expect(data.error).toBe("Translation failed");
});
