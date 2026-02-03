// inspect-pdf-images.js (Robust)
const { PDFDocument, PDFName, PDFDict, PDFStream } = require('pdf-lib');
const fs = require('fs');

async function inspect() {
    try {
        const buffer = fs.readFileSync('local_test.pdf');
        const doc = await PDFDocument.load(buffer);
        const pages = doc.getPages();
        const page = pages[0];

        console.log("Analyzing Page 1...");

        const resources = page.node.Resources();
        if (!resources) { console.log("No Resources"); return; }

        const xObjects = resources.lookup(PDFName.of('XObject'));
        if (!xObjects || !(xObjects instanceof PDFDict)) {
            console.log("No XObjects dict found.");
            return;
        }

        const keys = xObjects.keys(); // Returns PDFName[]
        console.log(`Found ${keys.length} XObject entries.`);

        for (const key of keys) {
            const refOrObj = xObjects.get(key);
            const obj = doc.context.lookup(refOrObj);

            if (obj instanceof PDFStream) {
                const dict = obj.dict;
                const subtype = dict.lookup(PDFName.of('Subtype'));

                if (subtype && subtype.toString() === '/Image') {
                    const width = dict.lookup(PDFName.of('Width'))?.value();
                    const height = dict.lookup(PDFName.of('Height'))?.value();
                    const filter = dict.lookup(PDFName.of('Filter'));

                    console.log(`[IMAGE] Key: ${key.toString()}`);
                    console.log(`  Size: ${width} x ${height}`);
                    console.log(`  Filter: ${filter ? filter.toString() : 'None'}`);
                }
            }
        }
    } catch (e) {
        console.error("Error:", e);
    }
}

inspect();
