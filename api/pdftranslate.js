// api/pdftranslate.js

import OpenAI from "openai";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Vercel設定: ボディ解析を無効にしてバイナリを直接扱う
export const config = {
    api: {
        bodyParser: false,
    },
};

/**
 * マルチパートリクエストのバイナリセーフなパース
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
        // ボディの前後にある \r\n を削る
        const body = part.slice(headerEnd + 4, part.length - 2);

        const nameMatch = headerText.match(/name="([^"]+)"/);
        const filenameMatch = headerText.match(/filename="([^"]+)"/);

        if (nameMatch) {
            const name = nameMatch[1];
            if (filenameMatch) {
                result[name] = {
                    filename: filenameMatch[1],
                    content: body,
                    type: "file"
                };
            } else {
                result[name] = body.toString();
            }
        }
        pos = nextPos;
    }
    return result;
}

/**
 * PDFからテキストを抽出 (pdfjs-distを使用)
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
        return fullText;
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
            { role: "user", content: text }
        ],
        temperature: 0.3,
    });

    return response.choices[0]?.message?.content || "";
}

/**
 * 簡易的な別紙PDF（fallback）の生成
 */
function generateFallbackPdf(text) {
    const pdfContent = `%PDF-1.4
1 0 obj
<< /Title (Translated Manual) /Producer (AI Translator) >>
endobj
2 0 obj
<< /Type /Catalog /Pages 3 0 R >>
endobj
3 0 obj
<< /Type /Pages /Kids [4 0 R] /Count 1 >>
endobj
4 0 obj
<< /Type /Page /Parent 3 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
6 0 obj
<< /Length ${Buffer.from(text).length + 50} >>
stream
BT
/F1 12 Tf
10 700 Td
(${text.replace(/\n/g, ") Tj\n0 -15 Td (").replace(/[()]/g, "\\$&")}) Tj
ET
endstream
endobj
xref
0 7
0000000000 65535 f 
0000000009 00000 n 
0000000075 00000 n 
0000000124 00000 n 
0000000179 00000 n 
0000000277 00000 n 
0000000355 00000 n 
trailer
<< /Size 7 /Root 2 0 R >>
startxref
${600}
%%EOF`;

    return Buffer.from(pdfContent, "binary");
}

export default async function handler(req, res) {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).send("Method Not Allowed");
    }

    console.log("[pdftranslate] Request received, method:", req.method);

    try {
        const parts = await parseMultipart(req);
        console.log("[pdftranslate] Multipart parsed. keys:", Object.keys(parts));

        const filePart = parts.file;
        const direction = parts.direction || "ja-zh";
        const pdfUrl = parts.pdfUrl;

        let pdfBuffer;
        if (filePart) {
            console.log("[pdftranslate] File detected:", filePart.filename, "size:", filePart.content.length);
            pdfBuffer = filePart.content;
        } else if (pdfUrl) {
            console.log("[pdftranslate] PDF URL detected:", pdfUrl);
            const pdfRes = await fetch(pdfUrl);
            if (pdfRes.ok) {
                pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
                console.log("[pdftranslate] PDF fetched from URL, size:", pdfBuffer.length);
            } else {
                console.error("[pdftranslate] Failed to fetch PDF from URL. Status:", pdfRes.status);
            }
        }

        if (!pdfBuffer) {
            console.warn("[pdftranslate] No PDF buffer available.");
            return res.status(200).setHeader("Content-Type", "application/pdf").send(generateFallbackPdf("エラー: PDFファイルが見つかりません。"));
        }

        // テキスト抽出
        console.log("[pdftranslate] Starting text extraction...");
        const text = await extractText(pdfBuffer);
        console.log("[pdftranslate] Text extracted, length:", text ? text.length : 0);

        if (!text || !text.trim()) {
            console.warn("[pdftranslate] Extracted text is empty.");
        }

        // 翻訳
        console.log("[pdftranslate] Calling OpenAI for translation... direction:", direction);
        const translated = await translateText(text, direction);
        console.log("[pdftranslate] Translation completed, result length:", translated ? translated.length : 0);

        // PDF生成（別紙フォールバック）
        console.log("[pdftranslate] Generating fallback PDF...");
        const finalPdf = generateFallbackPdf(translated);
        console.log("[pdftranslate] PDF generation completed. Sending response.");

        res.setHeader("Content-Type", "application/pdf");
        res.status(200).send(finalPdf);

    } catch (error) {
        console.error("[pdftranslate] Fatal API Error:", error.stack || error);
        res.setHeader("Content-Type", "application/pdf");
        res.status(200).send(generateFallbackPdf("致命的なエラーが発生しました: " + error.message));
    }
}
