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

// --- Consolidated Configuration & Utilities ---

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
    const filename = `noto-${fontKey}-cache.otf`;
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
            const body = JSON.parse(bodyBuffer.toString() || "{}");
            direction = body.direction || "ja-zh";
            if (body.pdfUrl) {
                const r = await fetch(body.pdfUrl);
                if (r.ok) pdfBuffer = Buffer.from(await r.arrayBuffer());
                else throw new Error("Could not fetch PDF from URL: " + r.status);
            }
        } else {
            pdfBuffer = bodyBuffer;
        }

        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("No PDF content received.");

        // 2. Extract Text
        let extractedText = "";
        let errorMsg = null;
        try {
            const parsed = await pdfParse(pdfBuffer);
            extractedText = (parsed.text || "").trim();
        } catch (e) {
            errorMsg = "PDF Parse Error: " + e.message;
        }

        if (!extractedText && !errorMsg) {
            errorMsg = "No selectable text found. This PDF might be an image/scan.";
        }

        if (debugMode === "smoke") {
            return res.status(200).json({ 
                status: extractedText ? "success" : "warning", 
                length: extractedText.length, 
                message: errorMsg,
                preview: extractedText.slice(0, 200)
            });
        }

        // 3. Prepare Display Content
        let displayContent = "";
        if (errorMsg) {
            displayContent = `[!] Error: ${errorMsg}\n\n(Note: OCR is currently not supported. Please use a PDF with selectable text.)`;
        } else {
            const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            const target = direction === "ja-zh" ? "Simplified Chinese" : "Japanese";
            
            const completion = await client.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: `Translate text to ${target}. Keep technical terms where appropriate.` },
                    { role: "user", content: extractedText.slice(0, 3000) }
                ]
            });
            displayContent = completion.choices[0]?.message?.content || "No translation produced.";
        }

        // 4. Generate Result PDF
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        
        const fontBytes = await loadFontWithCache(direction);
        const font = await pdfDoc.embedFont(fontBytes);

        const page = pdfDoc.addPage();
        const { width, height } = page.getSize();
        const margin = 50;
        const fontSize = 11;

        page.drawText(displayContent, {
            x: margin,
            y: height - margin,
            size: fontSize,
            font: font,
            maxWidth: width - (margin * 2),
            lineHeight: 16
        });

        const finalBytes = await pdfDoc.save();
        
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="translated_results.pdf"`);
        return res.status(200).send(Buffer.from(finalBytes));

    } catch (err) {
        console.error("API Error Trace:", err);
        if (debugMode) return res.status(500).json({ error: err.message });
        res.status(500).send("Critical API Error: " + err.message);
    }
}
