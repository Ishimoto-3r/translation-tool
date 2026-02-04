const OpenAI = require("openai");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

// Vercel Serverless Function Config
module.exports.config = {
    api: {
        bodyParser: false,
        maxDuration: 60
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

// Convert PDF page to image data URL
async function renderPDFPageToImage(pdfBuffer, pageNumber) {
    try {
        const loadingTask = pdfjsLib.getDocument({
            data: new Uint8Array(pdfBuffer),
            useSystemFonts: true,
            standardFontDataUrl: null
        });

        const pdfDoc = await loadingTask.promise;
        const page = await pdfDoc.getPage(pageNumber);

        const viewport = page.getViewport({ scale: 2.0 }); // 高解像度

        // Node.js環境用のCanvasFactory
        const NodeCanvasFactory = require('pdfjs-dist/lib/pdf.js').NodeCanvasFactory;
        const canvasFactory = new NodeCanvasFactory();

        const canvasAndContext = canvasFactory.create(
            viewport.width,
            viewport.height
        );

        const renderContext = {
            canvasContext: canvasAndContext.context,
            viewport: viewport,
        };

        await page.render(renderContext).promise;

        // CanvasをPNGのBase64に変換
        const canvas = canvasAndContext.canvas;
        const imageData = canvas.toBuffer('image/png');
        const base64 = imageData.toString('base64');

        canvasFactory.destroy(canvasAndContext);

        return {
            dataUrl: `data:image/png;base64,${base64}`,
            width: viewport.width,
            height: viewport.height
        };
    } catch (e) {
        console.error("PDF rendering error:", e);
        return null;
    }
}

// Main Handler
module.exports = async (req, res) => {
    // CORS Headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-debug-mode, x-vercel-protection-bypass");

    if (req.method === "OPTIONS") return res.status(200).end();

    try {
        // 1. Check API Key
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error("OpenAI API Key is missing in server environment.");
        }

        // 2. Initialize OpenAI
        const client = new OpenAI({ apiKey });

        // 3. Read Body (Raw Buffer)
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bodyBuffer = Buffer.concat(chunks);

        // 4. Parse Query Params
        let direction = "ja-zh";
        try {
            const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            if (urlObj.searchParams.has("direction")) {
                direction = urlObj.searchParams.get("direction");
            }
        } catch (e) { }

        const targetLang = direction === "ja-zh" ? "Simplified Chinese" : "Japanese";
        const fontLang = direction === "ja-zh" ? "zh" : "ja";

        // 5. Load PDF Document
        const pdfDoc = await PDFDocument.load(bodyBuffer);
        pdfDoc.registerFontkit(fontkit);

        // 6. Load Fonts
        const fontBuffer = await fetchFont(fontLang);
        let customFont;
        if (fontBuffer) {
            customFont = await pdfDoc.embedFont(fontBuffer);
        } else {
            console.warn("Font fetch failed, fallback to Helvetica");
            customFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }

        // 7. OCR + Translation for each page
        const pageCount = pdfDoc.getPageCount();
        console.log(`Processing ${pageCount} page(s)...`);

        for (let i = 0; i < Math.min(pageCount, 5); i++) { // 最初の5ページのみ（MVP）
            console.log(`Processing page ${i + 1}/${pageCount}...`);

            const imageData = await renderPDFPageToImage(bodyBuffer, i + 1);

            if (!imageData) {
                console.error(`Failed to render page ${i + 1}`);
                continue;
            }

            // GPT-5.1 Vision API for OCR + Translation
            const prompt = `
あなたは翻訳者およびレイアウト解析の専門家です。
1. 画像内のすべてのテキストブロックを検出してください
2. 各ブロックを${targetLang}に翻訳してください
3. 各ブロックのbounding boxを画像の幅・高さに対するパーセンテージで推定してください: [top(%), left(%), width(%), height(%)]

以下の構造のJSONオブジェクトを返してください：
{
  "blocks": [
    { "original_text": "元のテキスト", "translated_text": "翻訳後のテキスト", "bbox_pct": [10, 10, 30, 5] },
    ...
  ]
}
JSONのみを出力してください。`;

            try {
                const completion = await client.chat.completions.create({
                    model: "gpt-5.1",
                    messages: [
                        {
                            role: "user", content: [
                                { type: "text", text: prompt },
                                { type: "image_url", image_url: { url: imageData.dataUrl, detail: "high" } }
                            ]
                        }
                    ],
                    response_format: { type: "json_object" },
                    max_completion_tokens: 8000
                });

                const jsonRes = JSON.parse(completion.choices[0]?.message?.content || "{}");
                const blocks = jsonRes.blocks || [];

                console.log(`Page ${i + 1}: Found ${blocks.length} text blocks`);

                // 翻訳テキストをPDFにオーバーレイ
                const page = pdfDoc.getPages()[i];
                const { width: pgW, height: pgH } = page.getSize();

                blocks.forEach(block => {
                    const [topPct, leftPct, widthPct, heightPct] = block.bbox_pct;
                    const text = block.translated_text;

                    const x = (leftPct / 100) * pgW;
                    const yTop = (topPct / 100) * pgH;
                    const w = (widthPct / 100) * pgW;
                    const h = (heightPct / 100) * pgH;
                    const y = pgH - yTop - h;

                    // 白い背景ボックスで元のテキストを隠す
                    page.drawRectangle({
                        x: x, y: y, width: w, height: h,
                        color: rgb(1, 1, 1),
                        opacity: 0.95
                    });

                    // 翻訳テキストを描画
                    const fontSize = Math.min(h * 0.7, 12);
                    page.drawText(text, {
                        x: x + 2,
                        y: y + (h * 0.15),
                        size: fontSize,
                        font: customFont,
                        color: rgb(0, 0, 0),
                        maxWidth: w - 4,
                        lineHeight: fontSize * 1.2
                    });
                });

            } catch (ocrErr) {
                console.error(`Page ${i + 1} OCR Failed:`, ocrErr);
                // エラーは無視して続行
            }
        }

        // 8. Response
        const finalBytes = await pdfDoc.save();
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="translated_result.pdf"`);
        return res.status(200).send(Buffer.from(finalBytes));

    } catch (err) {
        console.error("Handler Error:", err);
        return res.status(500).json({
            error: err.message || "Unknown Error",
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
};
