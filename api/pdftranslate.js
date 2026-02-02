// api/pdftranslate.js

import OpenAI from "openai";
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import pdfParse from "pdf-parse";
import path from "path";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

export const config = {
    api: { bodyParser: false },
};

// --- Consolidated Logic: Font Management ---

const FONT_URLS = {
    jp: "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf", 
    sc: "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf"
};

async function downloadFont(url, dest) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch font: ${res.statusText}`);
    const stream = createWriteStream(dest);
    await pipeline(res.body, stream);
}

async function loadFontWithCache(lang) {
    const isZh = lang.includes("zh");
    const fontKey = isZh ? "sc" : "jp";
    const filename = `font-${fontKey}-v2.otf`;
    const tmpPath = path.join("/tmp", filename);
    
    try {
        await fs.access(tmpPath);
    } catch {
        await downloadFont(FONT_URLS[fontKey], tmpPath);
    }
    
    return await fs.readFile(tmpPath);
}

// --- Main Handler ---

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
                else throw new Error("Fetch failed for pdfUrl: " + r.status);
            }
        } else {
            pdfBuffer = bodyBuffer;
        }

        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("PDF data is empty.");

        // 2. Extract Text
        let extractedText = "";
        let extractError = null;
        try {
            const parsed = await pdfParse(pdfBuffer);
            extractedText = (parsed.text || "").trim();
        } catch (e) {
            extractError = e.message;
        }

        if (!extractedText && !extractError) {
            extractError = "No text found (Possible image-based PDF)";
        }

        if (debugMode === "smoke") {
            return res.status(200).json({ 
                status: "success", 
                length: extractedText.length, 
                error: extractError,
                preview: extractedText.slice(0, 200)
            });
        }

        if (extractError) {
            throw new Error(`PDF Extraction Failed: ${extractError}`);
        }

        // 3. Translate
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const targetLangName = direction === "ja-zh" ? "Simplified Chinese" : "Japanese";
        
        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: `You are a professional translator. Translate to ${targetLangName}.` },
                { role: "user", content: extractedText.slice(0, 2000) }
            ]
        });
        const translatedContent = completion.choices[0]?.message?.content || "No translation produced.";

        // 4. Generate PDF
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        const fontBytes = await loadFontWithCache(direction);
        const customFont = await pdfDoc.embedFont(fontBytes);

        const page = pdfDoc.addPage();
        const { width, height } = page.getSize();
        const margin = 50;

        page.drawText(translatedContent.slice(0, 2000), {
            x: margin,
            y: height - margin,
            size: 10,
            font: customFont,
            maxWidth: width - (margin * 2),
            lineHeight: 14
        });

        const finalPdfBytes = await pdfDoc.save();
        res.setHeader("Content-Type", "application/pdf");
        return res.status(200).send(Buffer.from(finalPdfBytes));

    } catch (err) {
        if (debugMode) return res.status(500).json({ error: err.message });
        res.status(500).send("Error: " + err.message);
    }
}
