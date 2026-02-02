// api/pdftranslate.js

import OpenAI from "openai";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

export const config = {
    api: {
        bodyParser: false,
    },
};

export default async function handler(req, res) {
    // 1. 最優先の疎通確認
    if (req.url.includes("ping=true")) {
        return res.status(200).json({ status: "alive", message: "pong", node: process.version });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-debug-mode");
    if (req.method === "OPTIONS") return res.status(200).end();

    const debugMode = req.headers["x-debug-mode"];

    try {
        console.log("[pdftranslate] Handler triggered.");
        
        // 2. モジュールの読み込みテスト
        let pdfParse;
        try {
            pdfParse = require("pdf-parse");
        } catch (re) {
            throw new Error(`Library load failed (pdf-parse): ${re.message}`);
        }

        // 3. リクエストの受信
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const buffer = Buffer.concat(chunks);
        
        if (buffer.length === 0) throw new Error("Request body is empty.");

        // 4. データソースの特定 (JSON or Multipart)
        const contentType = req.headers["content-type"] || "";
        let pdfBuffer = null;
        let direction = "ja-zh";

        if (contentType.includes("application/json")) {
            const body = JSON.parse(buffer.toString());
            direction = body.direction || "ja-zh";
            if (body.pdfUrl) {
                const r = await fetch(body.pdfUrl);
                if (r.ok) pdfBuffer = Buffer.from(await r.arrayBuffer());
                else throw new Error("PDF URL fetch failed: " + r.status);
            }
        } else {
            // 簡易的なバイナリ抽出
            pdfBuffer = buffer; 
        }

        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("No PDF buffer identified.");

        // 5. テキスト抽出テスト
        let extractedText = "";
        try {
            const pdfData = await pdfParse(pdfBuffer);
            extractedText = (pdfData.text || "").trim();
        } catch (pe) {
            throw new Error(`Text extraction engine crash: ${pe.message}`);
        }

        if (debugMode === "smoke") {
            return res.status(200).json({
                status: "success",
                extractedBytes: pdfBuffer.length,
                textLength: extractedText.length,
                sample: extractedText.slice(0, 100)
            });
        }

        return res.status(200).json({ status: "ok", message: "Extraction success", length: extractedText.length });

    } catch (error) {
        console.error("[pdftranslate] Error caught in handler:", error.message);
        return res.status(500).json({ 
            error: error.message, 
            stack: error.stack,
            context: "Handler Custom Catch"
        });
    }
}
