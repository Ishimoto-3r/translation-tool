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
 * 外部フォントのロード（言語に応じて切り替え）
 */
async function loadFont(targetLang) {
    const isChinese = targetLang.includes("zh");
    
    // Vercel環境を考慮し、軽量化されたサブセットTTFを使用
    const fontUrls = isChinese 
        ? [
            "https://github.com/asfadmin/noto-sans-sc-subset/raw/master/fonts/NotoSansSC-Regular.ttf",
            "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf"
          ]
        : [
            "https://github.com/mizdra/noto-sans-jp-subset-for-vercel/raw/main/public/NotoSansJP-Regular.ttf",
            "https://github.com/shogo82148/noto-sans-jp-subset/blob/master/fonts/NotoSansJP-Regular.ttf?raw=true"
          ];

    for (const url of fontUrls) {
        try {
            console.log(`[pdftranslate] Fetching font (${isChinese ? 'SC' : 'JP'}):`, url);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); 

            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (res.ok) {
                const data = await res.arrayBuffer();
                console.log("[pdftranslate] Font loaded successfully:", data.byteLength);
                return data;
            }
        } catch (e) {
            console.warn(`[pdftranslate] Font load failed for ${url}:`, e.message);
        }
    }
    return null;
}

/**
 * PDFからテキストを抽出
 */
async function extractText(pdfBuffer) {
    try {
        const loadingTask = pdfjsLib.getDocument({
            data: pdfBuffer,
            disableWorker: true,
            useSystemFonts: true,
        });
        const pdf = await loadingTask.promise;
        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            fullText += content.items.map(item => item.str).join(" ") + "\n";
        }
        return fullText.normalize("NFKC");
    } catch (e) {
        console.error("[pdftranslate] PDF Extraction failed:", e);
        return "";
    }
}

/**
 * OpenAIによる翻訳
 */
async function translateText(text, direction) {
    if (!text || !text.trim()) return "（テキストが抽出できませんでした）";
    const isToZh = direction === "ja-zh";
    const targetLang = isToZh ? "中国語（簡体字）" : "日本語";

    const response = await client.chat.completions.create({
        model: process.env.MODEL_TRANSLATE || "gpt-5.1",
        messages: [
            { role: "system", content: `あなたはプロの翻訳者です。マニュアルを${targetLang}に翻訳してください。翻訳結果のみを返してください。` },
            { role: "user", content: text.slice(0, 3000) }
        ],
        temperature: 0.3,
    });
    return response.choices[0]?.message?.content || "";
}

/**
 * PDF生成 (pdf-lib)
 */
async function generatePdf(text, targetLangName) {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);

    const fontData = await loadFont(targetLangName);
    let font;
    if (fontData) {
        try {
            font = await pdfDoc.embedFont(fontData);
        } catch (e) {
            console.error("[pdftranslate] Font embedding failed:", e.message);
        }
    }

    if (!font) {
        font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    }

    const page = pdfDoc.addPage();
    const { height } = page.getSize();
    const fontSize = 11;
    const lines = text.split("\n");
    let y = height - 50;

    for (const line of lines) {
        if (y < 50) break;
        if (!line.trim()) { y -= fontSize * 1.5; continue; }
        
        try {
            page.drawText(line, { x: 50, y, size: fontSize, font, color: rgb(0, 0, 0) });
        } catch (e) {}
        y -= fontSize * 1.5;
    }

    return Buffer.from(await pdfDoc.save());
}

/**
 * ボディ解析（バイナリセーフ）
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
            if (r.ok) pdfBuffer = Buffer.from(await r.arrayBuffer());
        }

        if (!pdfBuffer) {
            const errPdf = await generatePdf("Error: No PDF content found.", direction);
            return res.status(200).setHeader("Content-Type", "application/pdf").send(errPdf);
        }

        const text = await extractText(pdfBuffer);
        const translated = await translateText(text, direction);
        const finalPdf = await generatePdf(translated, direction);

        res.setHeader("Content-Type", "application/pdf");
        res.status(200).send(finalPdf);

    } catch (error) {
        console.error("[pdftranslate] Fatal Error:", error.stack || error);
        try {
            const pdfDoc = await PDFDocument.create();
            const page = pdfDoc.addPage();
            const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
            page.drawText("An error occurred. Check server logs.", { x: 50, y: 700, size: 12, font });
            const bytes = await pdfDoc.save();
            res.setHeader("Content-Type", "application/pdf").status(200).send(Buffer.from(bytes));
        } catch (e) {
            res.status(500).send("Critical error");
        }
    }
}
