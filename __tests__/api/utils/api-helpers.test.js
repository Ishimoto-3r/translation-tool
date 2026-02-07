const nodeMocks = require('node-mocks-http');
const { handleCorsPreFlight, setCorsHeaders, validatePostMethod, sendErrorResponse, getRequiredEnvVar } = require('../../../api/utils/api-helpers');

describe('API Helpers (api-helpers.js)', () => {

    describe('setCorsHeaders', () => {
        test('適切なCORSヘッダーを設定する', () => {
            const { req, res } = nodeMocks.createMocks();
            setCorsHeaders(res);

            expect(res.getHeader('Access-Control-Allow-Credentials')).toBe('true');
            expect(res.getHeader('Access-Control-Allow-Origin')).toBe('*');
            expect(res.getHeader('Access-Control-Allow-Methods')).toBe('GET,OPTIONS,POST');
            expect(res.getHeader('Access-Control-Allow-Headers')).toContain('Content-Type');
        });
    });

    describe('handleCorsPreFlight', () => {
        test('OPTIONSメソッドの場合、200を返してtrueを返す', () => {
            const { req, res } = nodeMocks.createMocks({ method: 'OPTIONS' });
            const result = handleCorsPreFlight(req, res);

            expect(result).toBe(true);
            expect(res._getStatusCode()).toBe(200);
            expect(res._isEndCalled()).toBe(true);
            expect(res.getHeader('Access-Control-Allow-Origin')).toBe('*');
        });

        test('OPTIONS以外のメソッドの場合、falseを返す', () => {
            const { req, res } = nodeMocks.createMocks({ method: 'POST' });
            const result = handleCorsPreFlight(req, res);

            expect(result).toBe(false);
            expect(res._isEndCalled()).toBe(false);
        });
    });

    describe('validatePostMethod', () => {
        test('POSTメソッドの場合、trueを返す', () => {
            const { req, res } = nodeMocks.createMocks({ method: 'POST' });
            const result = validatePostMethod(req, res);
            expect(result).toBe(true);
        });

        test('POST以外のメソッドの場合、405を返してfalseを返す', () => {
            const { req, res } = nodeMocks.createMocks({ method: 'GET' });
            const result = validatePostMethod(req, res);

            expect(result).toBe(false);
            expect(res._getStatusCode()).toBe(405);
            // _getData()は文字列で返る可能性があるためパースする
            const data = JSON.parse(res._getData());
            expect(data.error).toBe('Method Not Allowed');
        });
    });

    describe('getRequiredEnvVar', () => {
        const originalEnv = process.env;

        beforeEach(() => {
            jest.resetModules();
            process.env = { ...originalEnv };
        });

        afterAll(() => {
            process.env = originalEnv;
        });

        test('環境変数が存在する場合、その値を返す', () => {
            process.env.TEST_ENV_VAR = 'test-value';
            const { req, res } = nodeMocks.createMocks();
            const result = getRequiredEnvVar('TEST_ENV_VAR', res, 'TestContext');
            expect(result).toBe('test-value');
        });

        test('環境変数がない場合、500を返してnullを返す', () => {
            delete process.env.TEST_ENV_VAR;
            const { req, res } = nodeMocks.createMocks();

            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

            const result = getRequiredEnvVar('TEST_ENV_VAR', res, 'TestContext');

            expect(result).toBeNull();
            expect(res._getStatusCode()).toBe(500);
            const data = JSON.parse(res._getData());
            expect(data.error).toContain('設定されていません');

            consoleSpy.mockRestore();
        });
    });

    describe('sendErrorResponse', () => {
        test('エラーメッセージとステータスコードを正しく返す', () => {
            const { req, res } = nodeMocks.createMocks();
            const error = new Error('Test Error');

            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

            sendErrorResponse(res, 500, 'Internal Server Error', 'TestContext', error);

            expect(res._getStatusCode()).toBe(500);
            const data = JSON.parse(res._getData());
            expect(data.error).toBe('Internal Server Error');
            // NODE_ENVによってdetailsが含まれるか変わるが、通常テスト環境では含まれるかもしれない
            // api-helpers.jsの実装: process.env.NODE_ENV !== 'production' && error ? { details: error.message } : {}
            // JestのデフォルトNODE_ENVは 'test' なので details は含まれるはず
            if (process.env.NODE_ENV !== 'production') {
                expect(data.details).toBe('Test Error');
            }

            consoleSpy.mockRestore();
        });
    });
});
