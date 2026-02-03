
import handler from './api/pdftranslate.js';
import fs from 'fs';
import path from 'path';

process.env.OPENAI_API_KEY = 'dummy-key-for-test';


// モック用のRequestクラス
class MockRequest {
    constructor(bodyBuffer, contentType, url = '/') {
        this.bodyBuffer = bodyBuffer;
        this.headers = {
            'content-type': contentType,
            'x-debug-mode': 'true',
            'host': 'localhost:3000'
        };
        this.method = 'POST';
        this.url = url;
    }

    async *[Symbol.asyncIterator]() {
        yield this.bodyBuffer;
    }
}

// モック用のResponseクラス
class MockResponse {
    constructor() {
        this.headers = {};
        this.statusCode = 200;
        this.body = null;
    }

    setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
    }

    status(code) {
        this.statusCode = code;
        return this;
    }

    json(data) {
        this.body = JSON.stringify(data, null, 2);
        console.log('Response JSON:', this.body);
        return this;
    }

    send(data) {
        this.body = data;
        console.log('Response Send:', typeof data === 'string' ? data : `Buffer<${data.length}>`);
        return this;
    }

    end() {
        console.log('Response End');
    }
}

async function runTest() {
    try {
        console.log('Starting test...');

        const pdfPath = 'final_vision_result.pdf';
        let pdfBuffer;

        if (fs.existsSync(pdfPath)) {
            console.log(`Loading PDF from ${pdfPath}`);
            pdfBuffer = fs.readFileSync(pdfPath);
        } else {
            console.log('PDF not found, using dummy buffer');
            // 最低限のvalidなPDFヘッダとフッタ
            pdfBuffer = Buffer.from('%PDF-1.4\n1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n2 0 obj\n<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n3 0 obj\n<<\n/Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 612 792]\n/Resources << >>\n>>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000117 00000 n \ntrailer\n<<\n/Size 4\n/Root 1 0 R\n>>\nstartxref\n223\n%%EOF');
        }

        console.log('Simulating Raw Request with Query Params...');

        // Raw PDF送信 + Query Param
        const req = new MockRequest(pdfBuffer, 'application/pdf', '/api/pdftranslate?direction=ja-zh');
        const res = new MockResponse();

        await handler(req, res);

    } catch (e) {
        // ハンドラ内でキャッチされずに漏れたエラー
        console.error('Test script execution error:', e);
    }
}

runTest();
