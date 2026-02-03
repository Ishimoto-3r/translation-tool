const OpenAI = require("openai");
const { PDFDocument, PDFName, PDFStream, rgb, StandardFonts } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit"); // 追加
const pdfParse = require("pdf-parse");
const zlib = require("zlib");

// Vercel Serverless Function Config
module.exports.config = {
    api: {
        bodyParser: false, // Disallow Vercel's default body parsing to handle raw binary
        maxDuration: 60    // Attempt to set 60s (might be ignored on Hobby plan)
    },
};

// Helper Functions
const path = require("path");
const fs = require("fs");

async function fetchFont(lang) {
    try {
        const fontName = lang === "zh" ? "NotoSansSC-Regular.woff2" : "NotoSansJP-Regular.ttf";
        const fontPath = path.join(__dirname, "fonts", fontName);
        console.log(`Loading font from: ${fontPath}`);
        return fs.readFileSync(fontPath);
    } catch (e) {
        console.error("Local font read error:", e);
        return null;
    }
}

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

// Main Handler
module.exports = async (req, res) => {
    // CORS Headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-debug-mode, x-vercel-protection-bypass");

    if (req.method === "OPTIONS") return res.status(200).end();

    const debugMode = req.headers["x-debug-mode"];

    try {
        // 1. Check API Key
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error("OpenAI API Key is missing in server environment.");
        }

        // 2. Initialize OpenAI (inside try block)
        const client = new OpenAI({ apiKey });

        // 3. Read Body (Raw Buffer)
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bodyBuffer = Buffer.concat(chunks);
        const contentType = req.headers["content-type"] || "";

        // 4. Determine Input (PDF Binary or JSON URL)
        let pdfBuffer = bodyBuffer;
        let direction = "ja-zh";
        try {
            // Parse Query Params
            const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            if (urlObj.searchParams.has("direction")) {
                direction = urlObj.searchParams.get("direction");
            }
        } catch (e) { }

        let pdfUrl = null;

        if (contentType.includes("application/json")) {
            const bodyStr = bodyBuffer.toString() || "{}";
            const body = JSON.parse(bodyStr);
            if (body.direction) direction = body.direction;
            pdfUrl = body.pdfUrl;

            if (pdfUrl) {
                const r = await fetch(pdfUrl);
                if (r.ok) pdfBuffer = Buffer.from(await r.arrayBuffer());
                else throw new Error("Method 2 (Fetch URL) failed: " + r.status);
            }
        }

        if (!pdfBuffer || pdfBuffer.length === 0) {
            throw new Error("No PDF content provided.");
        }

        // 5. Extract Text (Helper)
        let extractedText = "";
        try {
            const parsed = await pdfParse(pdfBuffer);
            extractedText = (parsed.text || "").trim();
        } catch (e) {
            console.error("PDF Parsing error (pdf-parse):", e);
        }

        // 6. Load PDF Document (pdf-lib)
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        pdfDoc.registerFontkit(fontkit); // 追加

        const targetLang = direction === "ja-zh" ? "Simplified Chinese" : "Japanese";
        const fontLang = direction === "ja-zh" ? "zh" : "ja";

        // 7. Load Fonts
        const fontBuffer = await fetchFont(fontLang);
        let customFont;
        if (fontBuffer) {
            customFont = await pdfDoc.embedFont(fontBuffer);
        } else {
            console.warn("Font fetch failed, fallback to Helvetica");
            customFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }

        // デバッグ用：強制描画テスト
        const debugPage = pdfDoc.getPages()[0];
        const { width: debugW, height: debugH } = debugPage.getSize();

        // 1. ASCII Test (Red) - Bottom Left area
        debugPage.drawText('DEBUG_ASCII_OK', {
            x: 20, y: 20,
            size: 20,
            font: await pdfDoc.embedFont(StandardFonts.Helvetica),
            color: rgb(1, 0, 0)
        });

        // 2. CJK Test (Blue) - Bottom Left (above ASCII)
        debugPage.drawText('DEBUG_日本語(CJK)_OK', {
            x: 20, y: 50,
            size: 20,
            font: customFont, // ここが重要。豆腐ならフォント読み込み失敗またはグリフ欠落
            color: rgb(0, 0, 1)
        });

        // 3. Coordinate Marker (Green) - Top Left
        debugPage.drawCircle({
            x: 20, y: debugH - 20,
            size: 10,
            color: rgb(0, 1, 0)
        });

        // 8. Translation Logic
        if (extractedText.length > 50) {
            // Text Mode
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
            // Simple text rendering
            page.drawText(translated, {
                x: 50, y: height - 50,
                size: 10, font: customFont,
                maxWidth: width - 100,
                lineHeight: 14,
                color: rgb(0, 0, 0)
            });

        } else {
            // Vision Mode
            console.log("Image-based PDF detected. Using GPT-4o Vision...");
            const page = pdfDoc.getPages()[0]; // Only 1st page for MVP
            const imgData = await extractFirstOverlayImage(pdfDoc, 0);

            if (!imgData) {
                const p = pdfDoc.addPage();
                p.drawText("Error: No text and no supported image found.", { x: 50, y: 700, size: 24, font: customFont });
            } else {
                try {
                    const base64Img = imgData.buffer.toString('base64');
                    const dataUrl = `data:image/jpeg;base64,${base64Img}`;

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
                        model: "gpt-5.1",
                        messages: [
                            {
                                role: "user", content: [
                                    { type: "text", text: prompt },
                                    { type: "image_url", image_url: { url: dataUrl, detail: "high" } }
                                ]
                            }
                        ],
                        response_format: { type: "json_object" },
                        max_completion_tokens: 4000
                    });

                    const jsonRes = JSON.parse(completion.choices[0]?.message?.content || "{}");
                    const blocks = jsonRes.blocks || [];

                    const { width: pgW, height: pgH } = page.getSize();

                    blocks.forEach(block => {
                        const [topPct, leftPct, widthPct, heightPct] = block.bbox_pct;
                        const text = block.translated_text;

                        const x = (leftPct / 100) * pgW;
                        const yTop = (topPct / 100) * pgH;
                        const w = (widthPct / 100) * pgW;
                        const h = (heightPct / 100) * pgH;
                        const y = pgH - yTop - h; // PDF coordinates (bottom-left origin)

                        // Draw background box
                        page.drawRectangle({
                            x: x, y: y, width: w, height: h,
                            color: rgb(1, 1, 1)
                        });

                        // Draw text
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

        // 9. Response
        const finalBytes = await pdfDoc.save();
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="translated_result.pdf"`);
        return res.status(200).send(Buffer.from(finalBytes));

    } catch (err) {
        console.error("Handler Error:", err);
        // Error Response (JSON)
        // If client accepts text (e.g. Browser default), it might render JSON, which is fine.
        // If debugMode is on, send stack.
        const errorBody = {
            error: err.message || "Unknown Error",
            stack: debugMode ? err.stack : undefined
        };

        return res.status(500).json(errorBody);
    }
};
