// api/pdftranslate.js

import OpenAI from "openai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import pdfParse from "pdf-parse";
import path from "path";
import fs from "fs/promises";

export const config = {
    api: { bodyParser: false },
};

async function loadLocalFont(lang) {
    const isZh = lang.includes("zh");
    const fontName = isZh ? "NotoSansSC-Regular.ttf" : "NotoSansJP-Regular.ttf";
    
    // Path strategy: Look in "fonts" folder at root (process.cwd())
    const fontPath = path.join(process.cwd(), "fonts", fontName);
    
    try {
        const buffer = await fs.readFile(fontPath);
        return buffer;
    } catch (e) {
        return null;
    }
}

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

        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("No PDF");

        let extractedText = "";
        try {
            const parsed = await pdfParse(pdfBuffer);
            extractedText = (parsed.text || "").trim();
        } catch (e) {
            extractedText = "ERROR: " + e.message;
        }

        if (debugMode === "smoke") {
            return res.status(200).json({ status: "success", length: extractedText.length });
        }

        if (!extractedText || extractedText.length < 2) {
             throw new Error("Extraction empty");
        }

        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const targetDesc = direction === "ja-zh" ? "Chinese" : "Japanese";
        
        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: `Translate to ${targetDesc} (summary only): ${extractedText.slice(0, 300)}` }],
            max_tokens: 300
        });
        const translated = completion.choices[0]?.message?.content || "No translation";

        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        
        const fontData = await loadLocalFont(direction);
        if (!fontData) {
            // Detailed debug for 500 error
            let listing = [];
            try { listing = await fs.readdir(process.cwd()); } catch(e) {}
            let fontsListing = [];
            try { fontsListing = await fs.readdir(path.join(process.cwd(), "fonts")); } catch(e) { fontsListing = [e.message]; }
            
            throw new Error(`Font missing. Searched: fonts/${fontName}. Root: ${JSON.stringify(listing)}. Fonts dir: ${JSON.stringify(fontsListing)}`);
        }
        
        const font = await pdfDoc.embedFont(fontData);

        const page = pdfDoc.addPage();
        const { height } = page.getSize();
        
        page.drawText(translated.slice(0, 500), { x: 50, y: height - 100, size: 12, font });

        const finalBytes = await pdfDoc.save();
        res.setHeader("Content-Type", "application/pdf");
        return res.status(200).send(Buffer.from(finalBytes));

    } catch (err) {
        if (debugMode) return res.status(500).json({ error: err.message });
        res.status(500).send("Error: " + err.message);
    }
}
