process.env.OPENAI_API_KEY = "sk-dummy-key-for-local-test";
const handler = require('./api/pdftranslate.js');
const fs = require('fs');
const path = require('path');

async function run() {
    console.log("Starting Local Verification...");

    // Mock Request
    // テスト用の小さなPDFファイルを作成または読み込む必要がありますが、
    // ここでは単純なテキストPDFを動的に作ってバッファにするか、既存のPDFがあればそれを使います。
    // 面倒なのでpdf-libで空のPDFを作って渡します。
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([600, 400]);
    const pdfBytes = await doc.save();

    // Create a mock request object that is distinct from API Gateway request structure
    // Since api/pdftranslate.js reads from req iterator directly!
    const req = {
        headers: {
            host: 'localhost',
            'content-type': 'application/pdf',
            'x-debug-mode': 'true'
        },
        method: 'POST',
        url: 'http://localhost/api/pdftranslate?direction=ja-zh',
        [Symbol.asyncIterator]: async function* () {
            yield Buffer.from(pdfBytes);
        }
    };

    // Mock Response
    const res = {
        setHeader: (key, val) => console.log(`[Header] ${key}: ${val}`),
        status: (code) => {
            console.log(`[Status] ${code}`);
            return res;
        },
        send: (buffer) => {
            console.log(`[Send] Buffer length: ${buffer.length} bytes`);
            fs.writeFileSync('local_verify_output.pdf', buffer);
            console.log("Saved local_verify_output.pdf");
            return res;
        },
        json: (obj) => {
            console.log(`[JSON]`, obj);
            return res;
        },
        end: () => console.log("[End]")
    };

    try {
        await handler(req, res);
        console.log("Handler finished successfully.");
    } catch (e) {
        console.error("Handler crashed:", e);
    }
}

run();
