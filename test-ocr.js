// test-ocr.js
const { PDFDocument, PDFName, PDFStream } = require('pdf-lib');
const fs = require('fs');
const zlib = require('zlib');
const Tesseract = require('tesseract.js');

async function run() {
    console.log("Loading PDF...");
    const buffer = fs.readFileSync('local_test.pdf');
    const doc = await PDFDocument.load(buffer);
    const page = doc.getPages()[0];

    // 1. Extract Image
    console.log("Extracting Image...");
    const resources = page.node.Resources();
    const xObjects = resources.lookup(PDFName.of('XObject'));
    const keys = xObjects.dict.keys();

    let jpegBuffer = null;
    let imgWidth = 0;
    let imgHeight = 0;

    for (const key of keys) {
        const ref = xObjects.get(key);
        const obj = doc.context.lookup(ref);

        if (obj instanceof PDFStream) {
            const dict = obj.dict;
            const subtype = dict.lookup(PDFName.of('Subtype'));
            if (subtype.toString() === '/Image') {
                const filter = dict.lookup(PDFName.of('Filter'));
                // Check for DCTDecode (JPEG)
                // Filter can be a Name or Array of Names
                let filters = [];
                if (filter instanceof PDFName) filters.push(filter.toString());
                else if (Array.isArray(filter)) filters = filter.map(f => f.toString());
                else if (filter.array) filters = filter.array.map(f => f.toString()); // pdf-lib array structure

                // Check if DCTDecode is involved
                const hasDCT = filters.some(f => f === '/DCTDecode' || f.toString() === '/DCTDecode');

                if (hasDCT) {
                    let contents = obj.contents; // Raw buffer
                    // If FlateDecode is before DCTDecode, uncompress it
                    // Filter order in PDF is Decode order.
                    // [ /FlateDecode /DCTDecode ] means: Data -> Flate -> DCT -> Image
                    // So stored data is zlib(jpeg). We need to inflate it to get jpeg.
                    if (filters[0].toString() === '/FlateDecode') {
                        console.log("Inflating FlateDecode...");
                        contents = zlib.unzipSync(contents);
                    }

                    jpegBuffer = contents;
                    imgWidth = dict.lookup(PDFName.of('Width')).value();
                    imgHeight = dict.lookup(PDFName.of('Height')).value();
                    console.log(`Extracted JPEG: ${imgWidth}x${imgHeight}`);
                    fs.writeFileSync('extracted.jpg', jpegBuffer);
                    break;
                }
            }
        }
    }

    if (!jpegBuffer) {
        console.log("No JPEG found.");
        return;
    }

    // 2. OCR
    console.log("Running Tesseract...");
    const worker = await Tesseract.createWorker('chi_sim'); // Chinese Simplified
    const ret = await worker.recognize(jpegBuffer);
    console.log("OCR Text length:", ret.data.text.length);
    console.log("First word:", ret.data.words[0]);
    await worker.terminate();

    // 3. Mapping calculation
    // PDF Page Size
    const { width: pageWidth, height: pageHeight } = page.getSize();
    console.log(`Page: ${pageWidth}x${pageHeight}, Image: ${imgWidth}x${imgHeight}`);
    console.log(`Scales: X=${pageWidth / imgWidth}, Y=${pageHeight / imgHeight}`);

    // If we were to draw a bbox for the first word:
    const w = ret.data.words[0];
    if (w) {
        const bbox = w.bbox; // {x0, y0, x1, y1}
        const scaleX = pageWidth / imgWidth;
        const scaleY = pageHeight / imgHeight; // PDF y is usually bottom-up, but images are top-down?

        // PDF-lib coordinate system: (0,0) is bottom-left.
        // Image coordinate system: (0,0) is top-left.
        // So y conversion is: pdfY = pageHeight - (imgY * scaleY)

        const pdfX = bbox.x0 * scaleX;
        const pdfY = pageHeight - (bbox.y1 * scaleY); // bottom of bbox
        const pdfW = (bbox.x1 - bbox.x0) * scaleX;
        const pdfH = (bbox.y1 - bbox.y0) * scaleY;

        console.log(`Word: "${w.text}"`);
        console.log(`Image Box: (${bbox.x0}, ${bbox.y0}) - (${bbox.x1}, ${bbox.y1})`);
        console.log(`PDF  Box: x=${pdfX}, y=${pdfY}, w=${pdfW}, h=${pdfH}`);
    }
}

run().catch(console.error);
