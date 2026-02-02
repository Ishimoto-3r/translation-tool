// api/pdftranslate.js

import OpenAI from "openai";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Vercel設定: ボディ解析を無効にしてバイナリを直接扱う
export const config = {
    api: {
        bodyParser: false,
    },
};

/**
 * 外部フォントのロード（日本語・中国語対応）
 * Vercel環境用に最適化された TTF サブセットを使用
 */
let fontCache = null;
async function loadFont() {
    if (fontCache) return fontCache;
    // Vercelデプロイで実績のあるサブセットTTFを試行
    const fontUrl = "https://github.com/mizdra/noto-sans-jp-subset-for-vercel/raw/main/public/NotoSansJP-Regular.ttf";
    console.log("[pdftranslate] Downloading font from:", fontUrl);
    const res = await fetch(fontUrl);
    if (!res.ok) {
        // フォールバック（別のCDN）
        const fallbackUrl = "https://github.com/shogo82148/noto-sans-jp-subset/blob/master/fonts/NotoSansJP-Regular.ttf?raw=true";
        console.log("[pdftranslate] Font download failed, trying fallback:", fallbackUrl);
        const res2 = await fetch(fallbackUrl);
        if (!res2.ok) throw new Error("All font download attempts failed");
        fontCache = await res2.arrayBuffer();
    } else {
        fontCache = await res.arrayBuffer();
    }
    console.log("[pdftranslate] Font loaded, size:", fontCache.byteLength);
    return fontCache;
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
            const strings = content.items.map(item => item.str);
            fullText += strings.join(" ") + "\n";
        }
        // テキストを正規化（合字や特殊文字の解消）
        return fullText.normalize("NFKC");
    } catch (e) {
        console.error("PDF Extraction failed:", e);
        return "";
    }
}

/**
 * OpenAIによる翻訳
 */
async function translateText(text, direction) {
    if (!text.trim()) return "（テキストが抽出できませんでした）";

    const isToZh = direction === "ja-zh";
    const targetLang = isToZh ? "中国語（簡体字）" : "日本語";

    const systemPrompt = `あなたはプロの翻訳者です。マニュアルのテキストを${targetLang}に翻訳してください。
レイアウト情報は失われていますが、意味のまとまりを重視してください。
数値や型番、記号はそのまま保持してください。翻訳結果のテキストのみを返してください。`;

    const response = await client.chat.completions.create({
        model: process.env.MODEL_TRANSLATE || "gpt-5.1",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text.slice(0, 3000) }
        ],
        temperature: 0.3,
    });

    return response.choices[0]?.message?.content || "";
}

/**
 * pdf-lib による多言語対応PDF生成
 */
async function generatePdf(text) {
    console.log("[pdftranslate] Starting PDF generation...");
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);

    const fontData = await loadFont();
    const customFont = await pdfDoc.embedFont(fontData);

    const page = pdfDoc.addPage();
    const { height } = page.getSize();
    const fontSize = 11;

    // 改行コードの正規化と分割
    const lines = text.replace(/\r/g, "").split("\n");
    console.log("[pdftranslate] Drawing lines, count:", lines.length);

    let y = height - 50;

    for (const line of lines) {
        if (!line.trim()) {
            y -= fontSize * 1.5;
            continue;
        }
        if (y < 50) break;

        try {
            page.drawText(line, {
                x: 50,
                y: y,
                size: fontSize,
                font: customFont,
                color: rgb(0, 0, 0),
            });
        } catch (e) {
            console.warn("[pdftranslate] Line drawing failed:", e.message);
        }
        y -= fontSize * 1.6;
    }

    const pdfBytes = await pdfDoc.save();
    console.log("[pdftranslate] PDF saved, size:", pdfBytes.length);
    return Buffer.from(pdfBytes);
}

/**
 * マルチパートパース（バイナリセーフ）
 */
async function parseMultipart(req) {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return {};

    const boundary = Buffer.from("--" + boundaryMatch[1]);
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
    }
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
        if (headerEnd === -1) {
            pos = nextPos;
            continue;
        }

        const headerText = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4, part.length - 2);

        const nameMatch = headerText.match(/name="([^"]+)"/);
        const filenameMatch = headerText.match(/filename="([^"]+)"/);

        if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) {
                result[name] = { filename: filenameMatch[1], content: body, type: "file" };
            } else {
                result[name] = body.toString();
            }
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

    console.log("[pdftranslate] Phase 3-Hotfix Request starting...");

    try {
        const parts = await parseMultipart(req);
        const filePart = parts.file;
        const direction = parts.direction || "ja-zh";
        const pdfUrl = parts.pdfUrl;

        let pdfBuffer;
        if (filePart) {
            pdfBuffer = filePart.content;
        } else if (pdfUrl) {
            const pdfRes = await fetch(pdfUrl);
            if (pdfRes.ok) pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
        }

        if (!pdfBuffer) {
            const errPdf = await generatePdf("PDF buffer is empty.");
            return res.status(200).setHeader("Content-Type", "application/pdf").send(errPdf);
        }

        const text = await extractText(pdfBuffer);
        console.log("[pdftranslate] Extracted text sample:", text.slice(0, 50));

        const translated = await translateText(text, direction);
        console.log("[pdftranslate] Translated text sample:", translated.slice(0, 50));

        const finalPdf = await generatePdf(translated);

        res.setHeader("Content-Type", "application/pdf");
        res.status(200).send(finalPdf);

    } catch (error) {
        console.error("[pdftranslate] Fatal Error:", error.stack || error);
        try {
            const errorPdf = await generatePdf("Fatal Error: " + error.message);
            res.setHeader("Content-Type", "application/pdf").status(200).send(errorPdf);
        } catch (e) {
            res.status(500).send("Fatal failure");
        }
    }
}
