// api/pdftranslate.js

import OpenAI from "openai";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

// Vercel(Node.js)では外部URLのworkerSrcは不正。メインスレッド動作を強制。

export const config = {
    api: { bodyParser: false },
};

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
            const pageText = textContent.items
                .map(item => item.str)
                .join(" ");
            if (pageText.trim()) fullText += pageText + "\n";
        }
        return fullText.normalize("NFKC").trim();
    } catch (e) {
        return "ERROR_EXTRACTION: " + e.message;
    }
}

async function createPdf(text, lang, isError = false) {
    try {
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        let page = pdfDoc.addPage();
        const { height } = page.getSize();
        const margin = 50;
        const fontSize = 10;
        let y = height - margin;

        const lines = text.split("\n");
        for (let line of lines) {
            const maxChars = 60;
            for (let i = 0; i < line.length; i += maxChars) {
                const subLine = line.substring(i, i + maxChars).trim();
                if (!subLine) continue;
                if (y < 40) { page = pdfDoc.addPage(); y = height - margin; }
                page.drawText(subLine, { x: margin, y, size: fontSize, font });
                y -= fontSize * 1.5;
            }
        }
        return Buffer.from(await pdfDoc.save());
    } catch (e) {
        throw new Error("PDF Generation failed: " + e.message);
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
            const body = JSON.parse(bodyBuffer.toString() || "{}");
            direction = body.direction || "ja-zh";
            if (body.pdfUrl) {
                const r = await fetch(body.pdfUrl);
                if (r.ok) pdfBuffer = Buffer.from(await r.arrayBuffer());
                else throw new Error("JSON pdfUrl fetch failed: " + r.status);
            }
        } else {
            pdfBuffer = bodyBuffer;
        }

        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("PDFデータが見つかりません。");

        const extractedText = await extractText(pdfBuffer);

        if (debugMode === "smoke") {
            return res.status(200).json({ 
                status: extractedText.startsWith("ERROR") ? "failed" : "success",
                textLength: extractedText.length,
                info: extractedText
            });
        }

        if (!extractedText || extractedText.length < 2 || extractedText.startsWith("ERROR")) {
            const fatalMsg = "抽出エラー: " + extractedText;
            const errorPdf = await createPdf(fatalMsg, "en", true);
            return res.setHeader("Content-Type", "application/pdf").status(200).send(errorPdf);
        }

        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const targetLang = direction === "ja-zh" ? "中国語（簡体字）" : "日本語";
        const model = process.env.MODEL_TRANSLATE || "gpt-4o";
        
        const response = await client.chat.completions.create({
            model: model,
            messages: [
                { role: "system", content: `マニュアル翻訳家として${targetLang}に翻訳してください。` },
                { role: "user", content: extractedText.slice(0, 3000) }
            ],
            temperature: 0.1,
        });
        const translated = response.choices[0]?.message?.content || "翻訳失敗";

        const finalPdf = await createPdf(translated, direction);
        res.setHeader("Content-Type", "application/pdf");
        res.status(200).send(finalPdf);

    } catch (error) {
        console.error("[pdftranslate] Global Catch:", error.message);
        if (debugMode) return res.status(500).json({ status: "fatal", error: error.message });
        
        const errDoc = await createPdf("Operation Error: " + error.message, "en", true);
        res.setHeader("Content-Type", "application/pdf").status(200).send(errDoc);
    }
}
