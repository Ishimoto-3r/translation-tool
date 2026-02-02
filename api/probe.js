// api/probe.js
import OpenAI from "openai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

export default async function handler(req, res) {
    const results = {};
    try {
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        results.openai = "CREATED";
        
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        results.pdflib = "FONT_EMBEDDED";
        
        const page = pdfDoc.addPage();
        page.drawText("Hello World", { x: 50, y: 700, size: 10, font });
        results.pdfgen = "PAGE_DRAWN";
        
        const bytes = await pdfDoc.save();
        results.pdfsize = bytes.length;
        
        res.status(200).json(results);
    } catch (e) {
        res.status(500).json({ error: e.message, stack: e.stack });
    }
}
