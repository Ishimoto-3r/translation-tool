// api/pdftranslate.js

import OpenAI from "openai";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

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
            const timeoutId = setTimeout(() => controller.abort(), 12000); 
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (res.ok) return await res.arrayBuffer();
        } catch (e) {}
    }
    return null;
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
 * バイナリセーフなパース
 */
async function parseRequest(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const buffer = Buffer.concat(chunks);
    
    const contentType = req.headers["content-type"] || "";
    if (contentType.includes("multipart/form-data")) {
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) return {};
        const boundary = Buffer.from("--" + boundaryMatch[1]);
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
    } else {
        try {
            return JSON.parse(buffer.toString() || "{}");
        } catch (e) {
            return {};
        }
    }
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();

    try {
        console.log("[pdftranslate] Handler started.");
        const data = await parseRequest(req);
        const direction = data.direction || "ja-zh";
        let pdfBuffer = null;

        if (data.file) {
            pdfBuffer = data.file.content;
            console.log("[pdftranslate] Received multipart file.");
        } else if (data.pdfUrl) {
            console.log("[pdftranslate] Fetching URL:", data.pdfUrl);
            const r = await fetch(data.pdfUrl);
            if (r.ok) {
                pdfBuffer = Buffer.from(await r.arrayBuffer());
                console.log("[pdftranslate] URL fetch success. Size:", pdfBuffer.length);
            } else {
                throw new Error("URL fetch failed: " + r.status);
            }
        }

        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("No PDF data content.");

        let extractedText = "";
        try {
            const pdfData = await pdfParse(pdfBuffer);
            extractedText = (pdfData.text || "").normalize("NFKC").trim();
            console.log("[pdftranslate] pdf-parse finished. Chars:", extractedText.length);
        } catch (pe) {
            console.error("[pdftranslate] pdf-parse error:", pe.message);
            throw new Error("PDF parsing engine failed.");
        }

        if (!extractedText || extractedText.length < 5) {
            extractedText = "【警告】スキャン画像のみのPDF、またはテキストを抽出できない形式です。OCR(文字認識)機能が必要ですが、現在はテキストベースのPDFのみ対応しています。";
        }

        const isToZh = direction === "ja-zh";
        const targetLang = isToZh ? "中国語（簡体字）" : "日本語";

        console.log("[pdftranslate] Translating...");
        const response = await client.chat.completions.create({
            model: process.env.MODEL_TRANSLATE || "gpt-5.1",
            messages: [
                { role: "system", content: `あなたはマニュアル翻訳の専門家です。原文を${targetLang}に簡潔に翻訳してください。` },
                { role: "user", content: extractedText.slice(0, 3000) }
            ],
            temperature: 0.1,
        });
        const translated = response.choices[0]?.message?.content || "Translation empty.";
        
        console.log("[pdftranslate] Generating PDF response.");
        const finalPdf = await createPdf(translated, direction);

        res.setHeader("Content-Type", "application/pdf");
        res.status(200).send(finalPdf);

    } catch (error) {
        console.error("[pdftranslate] Fatal Error:", error.message);
        try {
            const pdfDoc = await PDFDocument.create();
            const page = pdfDoc.addPage();
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            page.drawText("Operation Failed: " + error.message, { x: 50, y: 700, size: 12, font });
            res.setHeader("Content-Type", "application/pdf").status(200).send(Buffer.from(await pdfDoc.save()));
        } catch (e) {
            res.status(500).send("Critical error during error handling.");
        }
    }
}
