// api/pdftranslate.js

import { createRequire } from "module";
const require = createRequire(import.meta.url);

const OpenAI = require("openai");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const pdfParse = require("pdf-parse");

export const config = {
    api: { bodyParser: false },
};

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-debug-mode, x-vercel-protection-bypass");
    if (req.method === "OPTIONS") return res.status(200).end();

    const debugMode = req.headers["x-debug-mode"];

    try {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bodyBuffer = Buffer.concat(chunks);
        const contentType = req.headers["content-type"] || "";
        
        let pdfBuffer = null;
        let direction = "ja-zh";

        if (contentType.includes("application/json")) {
            const bodyString = bodyBuffer.toString() || "{}";
            const body = JSON.parse(bodyString);
            direction = body.direction || "ja-zh";
            if (body.pdfUrl) {
                const r = await fetch(body.pdfUrl);
                if (r.ok) pdfBuffer = Buffer.from(await r.arrayBuffer());
            }
        } else {
            pdfBuffer = bodyBuffer;
        }

        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("No PDF source");

        let extractedText = "";
        try {
            const data = await pdfParse(pdfBuffer);
            extractedText = (data.text || "").trim();
        } catch (e) {
            extractedText = "ERROR_PARSE: " + e.message;
        }

        if (debugMode === "smoke") {
            return res.status(200).json({ 
                status: extractedText.startsWith("ERROR") ? "failed" : "success",
                length: extractedText.length,
                sample: extractedText.slice(0, 50)
            });
        }

        if (!extractedText || extractedText.length < 5 || extractedText.startsWith("ERROR")) {
            return res.status(200).json({ status: "extraction_failed", error: extractedText });
        }

        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const response = await client.chat.completions.create({
            model: process.env.MODEL_TRANSLATE || "gpt-4o",
            messages: [{ role: "user", content: "Translate: " + extractedText.slice(0, 1000) }]
        });
        const translated = response.choices[0]?.message?.content || "No translation";

        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const page = pdfDoc.addPage();
        page.drawText(translated.slice(0, 500), { x: 50, y: 700, size: 10, font });
        const finalPdf = await pdfDoc.save();

        res.setHeader("Content-Type", "application/pdf");
        return res.status(200).send(Buffer.from(finalPdf));

    } catch (err) {
        if (debugMode) return res.status(500).json({ error: err.message });
        res.status(500).send("Critical: " + err.message);
    }
}
