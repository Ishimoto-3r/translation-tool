// api/pdftranslate.js

import OpenAI from "openai";
import { PDFDocument, PDFName, PDFStream, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import pdfParse from "pdf-parse";
import path from "path";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import zlib from "zlib";
import { createWorker } from "tesseract.js";

export const config = {
    api: { bodyParser: false, maxDuration: 60 },
};

// Tesseract Paths (Explicitly use CDN for Serverless reliability)
// Using v5 compatible paths
const TESSERACT_CONFIG = {
    // langPath: 'https://tessdata.projectnaptha.com/4.0.0', // Common repo
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0/tesseract-core.wasm.js',
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.0/dist/worker.min.js',
    cachePath: '/tmp'
    // Default langPath is usually fine if cachePath is writable, 
    // but specifying it can help if default lookup fails.
};

// --- Font Management ---
const FONT_URLS = {
    jp: "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf", 
    sc: "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf"
};

async function downloadFont(url, dest) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch font: ${res.statusText}`);
    const stream = createWriteStream(dest);
    await pipeline(res.body, stream);
}

async function loadFontWithCache(lang) {
    const isZh = lang.includes("zh");
    const fontKey = isZh ? "sc" : "jp";
    const filename = `noto-${fontKey}-cache.otf`;
    const tmpPath = path.join("/tmp", filename);
    try { await fs.access(tmpPath); } catch { await downloadFont(FONT_URLS[fontKey], tmpPath); }
    return await fs.readFile(tmpPath);
}

// --- OCR Helper ---
async function extractFirstOverlayImage(doc, pageIndex = 0) {
    try {
        const page = doc.getPages()[pageIndex];
        const resources = page.node.Resources();
        const xObjects = resources?.lookup(PDFName.of('XObject'));
        if (!xObjects) return null;

        const keys = xObjects.dict.keys(); 
        for (const key of keys) {
            const ref = xObjects.get(key);
            const obj = doc.context.lookup(ref);
            if (obj instanceof PDFStream) {
                const dict = obj.dict;
                if (dict.lookup(PDFName.of('Subtype'))?.toString() === '/Image') {
                    const filter = dict.lookup(PDFName.of('Filter'));
                    let filters = [];
                    if (filter instanceof PDFName) filters.push(filter.toString());
                    else if (Array.isArray(filter)) filters = filter.map(f => f.toString());
                    else if (filter.array) filters = filter.array.map(f => f.toString());

                    const hasDCT = filters.some(f => f === '/DCTDecode' || f.toString() === '/DCTDecode');
                    if (hasDCT) {
                        let contents = obj.contents;
                        if (filters[0].toString() === '/FlateDecode') {
                            contents = zlib.unzipSync(contents);
                        }
                        return {
                            buffer: contents,
                            width: dict.lookup(PDFName.of('Width')).value(),
                            height: dict.lookup(PDFName.of('Height')).value()
                        };
                    }
                }
            }
        }
    } catch (e) {
        console.error("Image extraction failed:", e);
    }
    return null;
}

// --- Main Handler ---
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
        
        let pdfBuffer = bodyBuffer;
        let direction = "ja-zh";
        let pdfUrl = null;

        if (contentType.includes("application/json")) {
            const body = JSON.parse(bodyBuffer.toString() || "{}");
            direction = body.direction || "ja-zh";
            pdfUrl = body.pdfUrl;
            if (pdfUrl) {
                const r = await fetch(pdfUrl);
                if (r.ok) pdfBuffer = Buffer.from(await r.arrayBuffer());
                else throw new Error("Fetch failed: " + r.status);
            }
        }
        if (!pdfBuffer || pdfBuffer.length === 0) throw new Error("No PDF content.");

        let extractedText = "";
        try {
            const parsed = await pdfParse(pdfBuffer);
            extractedText = (parsed.text || "").trim();
        } catch (e) { console.error("Parse error:", e); }

        const pdfDoc = await PDFDocument.load(pdfBuffer);
        pdfDoc.registerFontkit(fontkit);
        const fontBytes = await loadFontWithCache(direction);
        const customFont = await pdfDoc.embedFont(fontBytes);
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const targetLang = direction === "ja-zh" ? "Simplified Chinese" : "Japanese";

        if (extractedText.length > 50) { 
            const completion = await client.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: `Translate to ${targetLang}.` },
                    { role: "user", content: extractedText.slice(0, 3000) }
                ]
            });
            const translated = completion.choices[0]?.message?.content || "No translation.";
            
            const page = pdfDoc.addPage();
            const { width, height } = page.getSize();
            page.drawText(translated, { x: 50, y: height - 50, size: 10, font: customFont, maxWidth: width - 100, lineHeight: 14 });
            
        } 
        else {
            console.log("Image-based PDF detected. Starting OCR...");
            const page = pdfDoc.getPages()[0];
            const imgData = await extractFirstOverlayImage(pdfDoc, 0);

            if (!imgData) {
                const p = pdfDoc.addPage();
                p.drawText("Error: No text and no supported image found.", { x: 50, y: 700, size: 24, font: customFont });
            } else {
                try {
                    const sourceLang = direction === "ja-zh" ? "jpn" : "chi_sim";
                    
                    const worker = await createWorker(sourceLang, 1, {
                        ...TESSERACT_CONFIG,
                        logger: m => console.log(m),
                        errorHandler: e => console.error("Tesseract Error:", e)
                    });
                    
                    const { data } = await worker.recognize(imgData.buffer);
                    await worker.terminate();

                    console.log(`OCR Lines: ${data.lines.length}`);
                    
                    const linesToTranslate = data.lines.map(l => l.text.replace(/\n| /g, '').trim()).filter(t => t.length > 0);
                    
                    if (linesToTranslate.length > 0) {
                         const prompt = `Translate these lines to ${targetLang}. Return a JSON object with a key "translations" containing an array of strings. \nLines:\n` + JSON.stringify(linesToTranslate);
                         
                         const completion = await client.chat.completions.create({
                            model: "gpt-4o",
                            messages: [{ role: "user", content: prompt }],
                            response_format: { type: "json_object" }
                        });
                        
                        let translatedLines = [];
                        try {
                            const jsonRes = JSON.parse(completion.choices[0]?.message?.content);
                            if (jsonRes.translations && Array.isArray(jsonRes.translations)) {
                                translatedLines = jsonRes.translations;
                            } else {
                                const keys = Object.keys(jsonRes);
                                if (keys.length > 0 && Array.isArray(jsonRes[keys[0]])) translatedLines = jsonRes[keys[0]];
                            }
                        } catch (e) { console.error("JSON parse error:", e); }

                        const { width: pgW, height: pgH } = page.getSize();
                        const scaleX = pgW / imgData.width;
                        const scaleY = pgH / imgData.height;

                        let lineIdx = 0;
                        data.lines.forEach((line) => {
                            const originalText = line.text.replace(/\n| /g, '').trim();
                            if (originalText.length === 0) return;
                            
                            if (lineIdx >= translatedLines.length) return;
                            const text = translatedLines[lineIdx];
                            lineIdx++;
                            
                            if (!text) return;
                            
                            const bbox = line.bbox; 
                            
                            const x = bbox.x0 * scaleX;
                            const y = pgH - (bbox.y1 * scaleY);
                            const w = (bbox.x1 - bbox.x0) * scaleX;
                            const h = (bbox.y1 - bbox.y0) * scaleY;

                            page.drawRectangle({
                                x: x, y: y, width: w, height: h,
                                color: rgb(1, 1, 1)
                            });

                            const fontSize = Math.min(h * 0.8, 12); 
                            page.drawText(text, {
                                x: x, y: y + (h * 0.1),
                                size: fontSize,
                                font: customFont,
                                color: rgb(0, 0, 0),
                                width: w 
                            });
                        });
                    }
                } catch (ocrErr) {
                    console.error("OCR Failed:", ocrErr);
                    const p = pdfDoc.addPage();
                    p.drawText(`OCR Error: ${ocrErr.message}`, { x: 50, y: 700, size: 12, font: customFont });
                }
            }
        }

        const finalBytes = await pdfDoc.save();
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="translated_result.pdf"`);
        return res.status(200).send(Buffer.from(finalBytes));

    } catch (err) {
        console.error(err);
        if (debugMode) return res.status(500).json({ error: err.message, stack: err.stack });
        res.status(500).send("Error: " + err.message);
    }
}
