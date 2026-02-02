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
            console.log(`[pdftranslate] Fetching ${isZh ? 'Chinese' : 'Japanese'} font:`, url);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); 
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (res.ok) {
                const data = await res.arrayBuffer();
                console.log("[pdftranslate] Font loaded:", data.byteLength);
                return data;
            }
        } catch (e) {
            console.warn("[pdftranslate] Font download fail:", url, e.message);
        }
    }
    return null;
}

/**
 * PDFからテキスト抽出 (pdfjs使用)
 */
async function extractText(pdfBuffer) {
    try {
        const loadingTask = pdfjsLib.getDocument({
            data: pdfBuffer,
            disableWorker: true,
            useSystemFonts: true,
        });
        const pdf = await loadingTask.promise;
        console.log("[pdftranslate] PDF loaded. Pages:", pdf.numPages);
        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map(item => item.str).join(" ");
            fullText += pageText + "\n";
        }
        return fullText.normalize("NFKC");
    } catch (e) {
        console.error("[pdftranslate] Extraction error:", e);
        return "";
    }
}

/**
 * OpenAI翻訳
 */
async function translateText(text, direction) {
    if (!text || !text.trim()) return "Translation failed: No text extracted.";
    const isToZh = direction === "ja-zh";
    const targetLang = isToZh ? "中国語（簡体字）" : "日本語";

    console.log("[pdftranslate] Sending to OpenAI. Sample length:", text.length);

    try {
        const response = await client.chat.completions.create({
            model: process.env.MODEL_TRANSLATE || "gpt-5.1",
            messages: [
                { 
                    role: "system", 
                    content: `あなたはオフィス機器やスキャナーのマニュアルを翻訳する専門家です。
原文のテキストを${targetLang}に正確に翻訳してください。
【重要】
- 専門用語、製品名、数値、記号（例: USB, mfxs50, 設定）などは翻訳せずそのまま保持するか、適切に扱ってください。
- 翻訳結果のみを出力してください。解説は不要です。` 
                },
                { role: "user", content: text.slice(0, 3500) }
            ],
            temperature: 0.1,
        });
        return response.choices[0]?.message?.content || "";
    } catch (e) {
        console.error("[pdftranslate] OpenAI error:", e);
        return "Error during translation: " + e.message;
    }
}

/**
 * 多言語PDF出力 (pdf-lib)
 */
async function createPdfResponse(text, lang) {
    console.log("[pdftranslate] Creating final PDF...");
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);

    const fontData = await loadFontData(lang);
    let font;
    if (fontData) {
        try {
            font = await pdfDoc.embedFont(fontData);
        } catch (e) {
            console.error("[pdftranslate] Font embed error:", e.message);
        }
    }

    if (!font) {
        console.warn("[pdftranslate] Using Helvetica fallback.");
        font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    }

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

            if (y < margin + lineHeight) {
                page = pdfDoc.addPage();
                y = height - margin;
            }

            try {
                page.drawText(subLine, {
                    x: margin,
                    y: y,
                    size: fontSize,
                    font,
                    color: rgb(0, 0, 0),
                });
            } catch (e) {}
            y -= lineHeight;
        }
    }

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
}

/**
 * ボディ解析
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
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    console.log("[pdftranslate] Request start:", new Date().toISOString());

    try {
        const parts = await parseMultipart(req);
        const direction = parts.direction || "ja-zh";
        const filePart = parts.file;
        const pdfUrl = parts.pdfUrl;

        let pdfBuffer;
        if (filePart) {
            pdfBuffer = filePart.content;
            console.log("[pdftranslate] Incoming file:", filePart.filename);
        } else if (pdfUrl) {
            console.log("[pdftranslate] Incoming URL:", pdfUrl);
            const r = await fetch(pdfUrl);
            if (r.ok) pdfBuffer = Buffer.from(await r.arrayBuffer());
            else throw new Error("Could not fetch PDF from URL: " + r.status);
        }

        if (!pdfBuffer) throw new Error("No PDF data provided.");

        const text = await extractText(pdfBuffer);
        const translated = await translateText(text, direction);
        const finalPdf = await createPdfResponse(translated, direction);

        console.log("[pdftranslate] Success. Sending PDF.");
        res.setHeader("Content-Type", "application/pdf");
        res.status(200).send(finalPdf);

    } catch (error) {
        console.error("[pdftranslate] Error caught:", error.message);
        try {
            const pdfDoc = await PDFDocument.create();
            const page = pdfDoc.addPage();
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            page.drawText("An error occurred: " + error.message, { x: 50, y: 700, size: 12, font });
            const bytes = await pdfDoc.save();
            res.setHeader("Content-Type", "application/pdf").status(200).send(Buffer.from(bytes));
        } catch (e) {
            res.status(500).send("Critical error");
        }
    }
}
