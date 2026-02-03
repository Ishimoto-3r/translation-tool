
import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'fs';

async function createSrcPdf() {
    const pdfDoc = await PDFDocument.create();
    const timesRomanFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    const page = pdfDoc.addPage();
    const { width, height } = page.getSize();
    const fontSize = 30;

    page.drawText('This is a test PDF for translation API verification.', {
        x: 50,
        y: height - 4 * fontSize,
        size: fontSize,
        font: timesRomanFont,
    });

    const pdfBytes = await pdfDoc.save();
    fs.writeFileSync('small_test.pdf', pdfBytes);
    console.log('Created small_test.pdf');
}

createSrcPdf();
