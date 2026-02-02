// api/probe.js
import OpenAI from "openai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

export default async function handler(req, res) {
    const results = { start: Date.now() };
    try {
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        
        const startAI = Date.now();
        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: "Say 'Success'" }],
            max_tokens: 5
        });
        results.ai_time = Date.now() - startAI;
        results.ai_resp = completion.choices[0]?.message?.content;

        const startPDF = Date.now();
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const page = pdfDoc.addPage();
        page.drawText(results.ai_resp, { x: 50, y: 700, size: 20, font });
        const bytes = await pdfDoc.save();
        results.pdf_time = Date.now() - startPDF;
        results.pdf_size = bytes.length;
        
        results.total_time = Date.now() - results.start;
        res.status(200).json(results);
    } catch (e) {
        res.status(500).json({ error: e.message, total_time: Date.now() - results.start });
    }
}
