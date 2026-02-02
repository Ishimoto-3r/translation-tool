// api/pdftranslate.js

import OpenAI from "openai";
import { PDFDocument, PDFName, PDFStream, rgb, StandardFonts } from "pdf-lib";
import pdfParse from "pdf-parse";
import zlib from "zlib";
// import { createWorker } from "tesseract.js"; // Removed

export const config = {
    api: { bodyParser: false, maxDuration: 60 },
};

// --- Font Management ---
// Google Fonts APIから動的にNoto Sansフォントを取得
async function fetchFont(lang) {
    try {
        const fontUrl = lang === "zh"
            ? "https://fonts.gstatic.com/s/notosanssc/v36/k3kXo84MPvpLmixcA63oeALhL4iJ-Q7m8w.ttf"
            : "https://fonts.gstatic.com/s/notosansjp/v52/-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFBEj75vY0rw-oME.ttf";
        
        const response = await fetch(fontUrl);
        if (!response.ok) throw new Error(`Font fetch failed: ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    } catch (e) {
        console.error("Font fetch error:", e);
        return null;
    }
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
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
        const targetLang = direction === "ja-zh" ? "Simplified Chinese" : "Japanese";
        const fontLang = direction === "ja-zh" ? "zh" : "ja";

        // 日本語・中国語対応フォントを取得
        const fontBuffer = await fetchFont(fontLang);
        let customFont;
        if (fontBuffer) {
            customFont = await pdfDoc.embedFont(fontBuffer);
        } else {
            console.warn("Font fetch failed, falling back to Helvetica");
            customFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }

        if (extractedText.length > 50) {
            const completion = await client.chat.completions.create({
                model: "gpt-5.1",
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
            console.log("Image-based PDF detected. Using GPT-4o Vision for OCR & Translation...");
            const page = pdfDoc.getPages()[0];
            const imgData = await extractFirstOverlayImage(pdfDoc, 0);

            if (!imgData) {
                const p = pdfDoc.addPage();
                p.drawText("Error: No text and no supported image found.", { x: 50, y: 700, size: 24, font: customFont });
            } else {
                try {
                    // Convert image buffer to base64
                    const base64Img = imgData.buffer.toString('base64');
                    // Assuming JPEG (DCTDecode)
                    const dataUrl = `data:image/jpeg;base64,${base64Img}`;

                    // Vision API Call
                    // We ask GPT-4o to "Translate the text and provide approximate bounding boxes".
                    // Coordinates: We ask for percentages (0-100) or absolute pixels (roughly) to be safe.
                    // GPT-4o is not pixel-perfect, but better than nothing.

                    const prompt = `
                    You are a translator and layout analyzer.
                    1. Detect all text blocks in the image.
                    2. Translate each block to ${targetLang}.
                    3. Estimate the bounding box for each block as percentage of image width/height: [top(%), left(%), width(%), height(%)].
                    
                    Return a JSON object with this structure:
                    {
                      "blocks": [
                        { "translated_text": "...", "bbox_pct": [10, 10, 30, 5] },
                        ...
                      ]
                    }
                    Output JSON only.
                    `;

                    const completion = await client.chat.completions.create({
                        model: "gpt-5.1", // Vision対応確認済み。非対応の場合は "gpt-4o" に変更
                        messages: [
                            {
                                role: "user", content: [
                                    { type: "text", text: prompt },
                                    { type: "image_url", image_url: { url: dataUrl, detail: "high" } }
                                ]
                            }
                        ],
                        response_format: { type: "json_object" },
                        max_tokens: 4000
                    });

                    const jsonRes = JSON.parse(completion.choices[0]?.message?.content);
                    const blocks = jsonRes.blocks || [];

                    const { width: pgW, height: pgH } = page.getSize();
                    // imgData.width/height are the intrinsic image dimensions.
                    // page.getSize() are the PDF page dimensions.
                    // Assuming the image fits/covers the page, we map percentages to page size directly.
                    // If image is only part of page, this might be offset, but for scans usually Page = Image.

                    blocks.forEach(block => {
                        const [topPct, leftPct, widthPct, heightPct] = block.bbox_pct;
                        const text = block.translated_text;

                        // Parse percentages
                        const x = (leftPct / 100) * pgW;
                        const yTop = (topPct / 100) * pgH;

                        // PDF Y is bottom-up. 
                        // yTop in image is distance from top.
                        // PDF Y = pgH - yTop - h

                        const w = (widthPct / 100) * pgW;
                        const h = (heightPct / 100) * pgH;
                        const y = pgH - yTop - h;

                        // Draw White Box
                        page.drawRectangle({
                            x: x, y: y, width: w, height: h,
                            color: rgb(1, 1, 1)
                        });

                        // Draw Text
                        // Auto-size font attempt
                        const fontSize = Math.min(h * 0.8, 12);
                        page.drawText(text, {
                            x: x, y: y + (h * 0.1),
                            size: fontSize,
                            font: customFont,
                            color: rgb(0, 0, 0),
                            width: w
                        });
                    });

                } catch (ocrErr) {
                    console.error("Vision OCR Failed:", ocrErr);
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
