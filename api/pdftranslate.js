// api/pdftranslate.js

import OpenAI from "openai";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const config = {
    api: {
        bodyParser: false,
    },
};

/**
 * 外部フォントのロード
 */
async function loadFontData(lang) {
    const isZh = lang.includes("zh");
    const urls = isZh 
        ? [
            "https://github.com/asfadmin/noto-sans-sc-subset/raw/master/fonts/NotoSansSC-Regular.ttf",
            "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf"
          ]
        : [
            "https://github.com/mizdra/noto-sans-jp-subset-for-vercel/raw/main/public/NotoSansJP-Regular.ttf",
            "https://github.com/shogo82148/noto-sans-jp-subset/blob/master/fonts/NotoSansJP-Regular.ttf?raw=true"
          ];

    for (const url of urls) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); 
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (res.ok) return await res.arrayBuffer();
        } catch (e) {}
    }
    return null;
}

/**
 * PDFからテキスト抽出 (pdfjs使用)
 */
async function extractText(pdfBuffer) {
    console.log("[pdftranslate] Extraction start. Buffer size:", pdfBuffer.length);
    try {
        const data = new Uint8Array(pdfBuffer);
        const loadingTask = pdfjsLib.getDocument({
            data: data,
            disableWorker: true,
            useSystemFonts: true,
            isEvalSupported: false,
        });
        
        const pdf = await loadingTask.promise;
        console.log("[pdftranslate] Pages:", pdf.numPages);
        
        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(" ");
            if (pageText.trim()) fullText += pageText + "\n";
        }
        return fullText.normalize("NFKC").trim();
    } catch (e) {
        console.error("[pdftranslate] PDFJS error:", e.message);
        return "";
    }
}

/**
 * OpenAI翻訳
 */
async function translateText(text, direction) {
    if (!text) return "Translation failed: No text extracted.";
    const isToZh = direction === "ja-zh";
    const targetLang = isToZh ? "中国語（簡体字）" : "日本語";

    try {
        const response = await client.chat.completions.create({
            model: process.env.MODEL_TRANSLATE || "gpt-5.1",
            messages: [
                { role: "system", content: `あなたはプロの翻訳者です。原文を${targetLang}に翻訳してください。` },
                { role: "user", content: text.slice(0, 3000) }
            ],
            temperature: 0.1,
        });
        return response.choices[0]?.message?.content || "";
    } catch (e) {
        console.error("[pdftranslate] OpenAI error:", e.message);
        return "Error: " + e.message;
    }
}

/**
 * PDF生成
 */
async function createPdf(text, lang) {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const fontData = await loadFontData(lang);
    let font;
    if (fontData) {
        try { font = await pdfDoc.embedFont(fontData); } catch (e) {}
    }
    if (!font) font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    let page = pdfDoc.addPage();
    const { width, height } = page.getSize();
    const margin = 50;
    const fontSize = 10;
    const lineHeight = fontSize * 1.5;
    let y = height - margin;

    const lines = text.split("\n");
    for (let line of lines) {
        const maxChars = 50;
        for (let i = 0; i < line.length; i += maxChars) {
            const subLine = line.substring(i, i + maxChars).trim();
            if (!subLine) continue;
            if (y < margin + lineHeight) { page = pdfDoc.addPage(); y = height - margin; }
            try { page.drawText(subLine, { x: margin, y, size: fontSize, font, color: rgb(0, 0, 0) }); } catch (e) {}
            y -= lineHeight;
        }
    }
    return Buffer.from(await pdfDoc.save());
}

/**
 * マルチパートパース
 */
async function parseMultipart(req) {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return {};
    const boundary = Buffer.from("--" + boundaryMatch[1]);
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);
    const result = {};
    let pos = 0;
    while (true) {
        pos = buffer.indexOf(boundary, pos);
        if (pos === -1) break;
        pos += boundary.length;
        let nextPos = buffer.indexOf(boundary, pos);
        if (nextPos === -1) break;
        const part = buffer.slice(pos, nextPos);
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) { pos = nextPos; continue; }
        const headerText = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4, part.length - 2);
        const nameMatch = headerText.match(/name="([^"]+)"/);
        const filenameMatch = headerText.match(/filename="([^"]+)"/);
        if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) result[name] = { filename: filenameMatch[1], content: body };
            else result[name] = body.toString();
        }
        pos = nextPos;
    }
    return result;
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    try {
        const parts = await parseMultipart(req);
        const direction = parts.direction || "ja-zh";
        const filePart = parts.file;
        const pdfUrl = parts.pdfUrl;

        let pdfBuffer;
        if (filePart) pdfBuffer = filePart.content;
        else if (pdfUrl) {
            const r = await fetch(pdfUrl);
            if (!r.ok) throw new Error("Fetch failed: " + r.status);
            pdfBuffer = Buffer.from(await r.arrayBuffer());
        }

        if (!pdfBuffer) throw new Error("Missing PDF data.");

        const text = await extractText(pdfBuffer);
        const translated = await translateText(text, direction);
        const finalPdf = await createPdf(translated, direction);

        res.setHeader("Content-Type", "application/pdf");
        res.status(200).send(finalPdf);

    } catch (error) {
        console.error("[pdftranslate] Fatal:", error.message);
        try {
            const pdfDoc = await PDFDocument.create();
            const page = pdfDoc.addPage();
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            page.drawText("Error: " + error.message, { x: 50, y: 700, size: 12, font });
            const bytes = await pdfDoc.save();
            res.setHeader("Content-Type", "application/pdf").status(200).send(Buffer.from(bytes));
        } catch (e) {
            res.status(500).send("Critical error");
        }
    }
}
