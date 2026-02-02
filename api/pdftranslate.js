// api/pdftranslate.js

import OpenAI from "openai";
import { PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import pdfParse from "pdf-parse";

export const config = {
    api: { bodyParser: false },
};

async function loadFontData(lang) {
    const isZh = lang.includes("zh");
    const urls = isZh 
        ? ["https://github.com/asfadmin/noto-sans-sc-subset/raw/master/fonts/NotoSansSC-Regular.ttf"]
        : ["https://github.com/mizdra/noto-sans-jp-subset-for-vercel/raw/main/public/NotoSansJP-Regular.ttf"];
    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (res.ok) return await res.arrayBuffer();
        } catch (e) {}
    }
    return null;
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
            }
        } else {
            pdfBuffer = bodyBuffer;
        }

        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("PDFデータなし");

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

        if (!extractedText || extractedText.length < 5) {
             throw new Error("テキスト抽出失敗：内容が空かスキャンの可能性があります");
        }

        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const targetDesc = direction === "ja-zh" ? "中国語（簡体字）" : "日本語";
        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: `マニュアル翻訳家として${targetDesc}に翻訳してください。` },
                { role: "user", content: extractedText.slice(0, 3000) }
            ],
            temperature: 0.1,
        });
        const translated = completion.choices[0]?.message?.content || "No translation";

        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        
        const fontData = await loadFontData(direction);
        let font;
        if (fontData) {
            try { font = await pdfDoc.embedFont(fontData); } catch (fe) {}
        }
        if (!font) font = await pdfDoc.embedFont(StandardFonts.Helvetica);

        let page = pdfDoc.addPage();
        const { height } = page.getSize();
        const margin = 50;
        const fontSize = 11;
        let y = height - margin;

        const lines = translated.split("\n");
        for (let line of lines) {
            const maxChars = 45;
            for (let i = 0; i < line.length; i += maxChars) {
                const subLine = line.substring(i, i + maxChars).trim();
                if (!subLine) continue;
                if (y < 50) { page = pdfDoc.addPage(); y = height - margin; }
                try {
                    page.drawText(subLine, { x: margin, y, size: fontSize, font });
                } catch(e) {}
                y -= fontSize * 1.5;
            }
        }

        const finalBytes = await pdfDoc.save();
        res.setHeader("Content-Type", "application/pdf");
        return res.status(200).send(Buffer.from(finalBytes));

    } catch (err) {
        if (debugMode) return res.status(500).json({ error: err.message, stack: err.stack });
        res.status(500).send("Error: " + err.message);
    }
}
