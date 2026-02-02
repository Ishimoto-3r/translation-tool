// api/pdftranslate.js

import OpenAI from "openai";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

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

async function extractText(pdfBuffer) {
    try {
        const data = new Uint8Array(pdfBuffer);
        const loadingTask = pdfjsLib.getDocument({
            data: data,
            disableWorker: true,
            useSystemFonts: true,
            isEvalSupported: false,
        });
        const pdf = await loadingTask.promise;
        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(" ");
            if (pageText.trim()) fullText += pageText + "\n";
        }
        return fullText.normalize("NFKC").trim();
    } catch (e) {
        console.error("Extraction error:", e.message);
        return "";
    }
}

async function createPdf(text, lang, isError = false) {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const fontData = await loadFontData(lang);
    let font;
    if (fontData) {
        try { font = await pdfDoc.embedFont(fontData); } catch (e) {}
    }
    if (!font) font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    let page = pdfDoc.addPage();
    const { height } = page.getSize();
    const margin = 50;
    const fontSize = 10;
    let y = height - margin;

    const lines = text.split("\n");
    for (let line of lines) {
        const maxChars = 50;
        for (let i = 0; i < line.length; i += maxChars) {
            const subLine = line.substring(i, i + maxChars).trim();
            if (!subLine) continue;
            if (y < margin + 20) { page = pdfDoc.addPage(); y = height - margin; }
            page.drawText(subLine, { x: margin, y, size: fontSize, font });
            y -= fontSize * 1.5;
        }
    }
    return Buffer.from(await pdfDoc.save());
}

export default async function handler(req, res) {
    if (req.url.includes("ping=true")) return res.status(200).json({ status: "alive" });

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
                console.log("[pdftranslate] Fetching PDF:", body.pdfUrl);
                const r = await fetch(body.pdfUrl);
                if (r.ok) {
                    pdfBuffer = Buffer.from(await r.arrayBuffer());
                    console.log("[pdftranslate] Fetch success. Bytes:", pdfBuffer.length);
                } else {
                    throw new Error(`PDF URL fetch failed with status ${r.status}: ${body.pdfUrl}`);
                }
            } else if (body.file && body.file.content) {
                pdfBuffer = Buffer.from(body.file.content);
            }
        } 

        if (!pdfBuffer || pdfBuffer.length === 0) {
            throw new Error(`PDFデータが特定できませんでした。(Content-Type: ${contentType}, BodyLength: ${bodyBuffer.length})`);
        }

        const extractedText = await extractText(pdfBuffer);

        if (debugMode === "smoke") {
            return res.status(200).json({ status: "success", textLength: extractedText.length, bytes: pdfBuffer.length });
        }

        if (!extractedText || extractedText.length < 5) {
            const warningMsg = "【抽出不可】PDFにテキストが含まれていないか、画像のみの形式です。";
            const errorPdf = await createPdf(warningMsg, direction, true);
            res.setHeader("Content-Type", "application/pdf");
            return res.status(200).send(errorPdf);
        }

        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const targetLang = direction === "ja-zh" ? "中国語（簡体字）" : "日本語";
        const model = process.env.MODEL_TRANSLATE || "gpt-4o";
        
        const response = await client.chat.completions.create({
            model: model,
            messages: [
                { role: "system", content: `翻訳専門家として${targetLang}に翻訳してください。` },
                { role: "user", content: extractedText.slice(0, 3000) }
            ],
            temperature: 0.1,
        });
        const translated = response.choices[0]?.message?.content || "翻訳結果なし";

        const finalPdf = await createPdf(translated, direction);
        res.setHeader("Content-Type", "application/pdf");
        res.status(200).send(finalPdf);

    } catch (error) {
        console.error("[pdftranslate] Error:", error.message);
        if (debugMode) return res.status(500).json({ error: error.message, stack: error.stack });
        const finalPdf = await createPdf("Error: " + error.message, "ja-zh", true);
        res.setHeader("Content-Type", "application/pdf").status(200).send(finalPdf);
    }
}
