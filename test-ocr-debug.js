// test-ocr-debug.js
const { PDFDocument, PDFName, PDFStream } = require('pdf-lib');
const fs = require('fs');
const zlib = require('zlib');
const Tesseract = require('tesseract.js');

async function run() {
    // ... (Extraction logic same as before, loading extracted.jpg directly for speed)
    if (!fs.existsSync('extracted.jpg')) {
        console.log("Run test-ocr.js first to extract image.");
        return;
    }
    const jpegBuffer = fs.readFileSync('extracted.jpg');

    console.log("Running Tesseract...");
    const worker = await Tesseract.createWorker('chi_sim');
    const ret = await worker.recognize(jpegBuffer);

    console.log("Text:", ret.data.text);
    console.log("Lines:", ret.data.lines?.length);
    if (ret.data.lines?.length > 0) {
        console.log("First Line Words:", ret.data.lines[0].words?.length);
        if (ret.data.lines[0].words?.length > 0) {
            console.log("First Word bbox:", ret.data.lines[0].words[0].bbox);
        }
    }

    await worker.terminate();
}

run().catch(console.error);
