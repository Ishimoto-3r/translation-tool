// api/pdftranslate.js

import OpenAI from "openai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import pdfParse from "pdf-parse";

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
                else throw new Error("Fetch failed: " + r.status);
            }
        } else {
            pdfBuffer = bodyBuffer;
        }

        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("PDFデータがありません");

        let extractedText = "";
        try {
            const parsed = await pdfParse(pdfBuffer);
            extractedText = (parsed.text || "").trim();
        } catch (e) {
            extractedText = "ERROR_ENGINE: " + e.message;
        }

        if (debugMode === "smoke") {
            return res.status(200).json({ 
                status: extractedText.length > 5 ? "success" : "failed",
                length: extractedText.length,
                sample: extractedText.slice(0, 100)
            });
        }

        if (!extractedText || extractedText.length < 5 || extractedText.startsWith("ERROR")) {
            return res.status(200).json({ 
                status: "error", 
                message: "テキストが抽出できませんでした。" 
            });
        }

        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const completion = await client.chat.completions.create({
            model: process.env.MODEL_TRANSLATE || "gpt-4o",
            messages: [
                { role: "system", content: "Translate this to Chinese." },
                { role: "user", content: extractedText.slice(0, 2000) }
            ],
            temperature: 0.1,
        });
        const translatedContent = completion.choices[0]?.message?.content || "EmptyResult";

        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const page = pdfDoc.addPage();
        page.drawText(translatedContent.slice(0, 1000), { x: 50, y: 700, size: 10, font });
        const finalPdfBytes = await pdfDoc.save();

        res.setHeader("Content-Type", "application/pdf");
        return res.status(200).send(Buffer.from(finalPdfBytes));

    } catch (err) {
        if (debugMode) return res.status(500).json({ error: err.message, stack: err.stack });
        res.status(500).send("Server Error: " + err.message);
    }
}
