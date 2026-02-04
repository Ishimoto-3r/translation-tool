const OpenAI = require("openai");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

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

// AI自己検証関数
function validateTranslationBlock(block, index) {
    const issues = [];

    if (!block.original_text || block.original_text.trim() === "") {
        issues.push(`Block ${index}: original_text is empty`);
    }

    if (!block.translated_text || block.translated_text.trim() === "") {
        issues.push(`Block ${index}: translated_text is empty`);
    }

    // 中国語文字の存在チェック（Unicode範囲: U+4E00–U+9FFF）
    const hasChinese = /[\u4e00-\u9fff]/.test(block.translated_text || "");
    if (!hasChinese) {
        issues.push(`Block ${index}: translated_text contains no Chinese characters`);
    }

    if (block.bbox_pct) {
        const [top, left, width, height] = block.bbox_pct;
        if (top < 0 || top > 100 || left < 0 || left > 100 ||
            width < 0 || width > 100 || height < 0 || height > 100) {
            issues.push(`Block ${index}: bbox_pct out of range (0-100%)`);
        }
    } else {
        issues.push(`Block ${index}: bbox_pct is missing`);
    }

    return issues;
}

// Main Handler
module.exports = async (req, res) => {
    // CORS Headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(200).end();

    try {
        // 1. Check API Key
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error("OpenAI API Key is missing");
        }

        // 2. Initialize OpenAI
        const client = new OpenAI({ apiKey });

        // 3. Read Body
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bodyBuffer = Buffer.concat(chunks);
        const body = JSON.parse(bodyBuffer.toString());

        const { images, direction } = body;

        if (!images || !Array.isArray(images) || images.length === 0) {
            throw new Error("No images provided");
        }

        const targetLang = direction === "ja-zh" ? "Simplified Chinese" : "Japanese";
        const fontLang = direction === "ja-zh" ? "zh" : "ja";

        console.log(`Processing ${images.length} page(s), Target: ${targetLang}`);

        // 4. Load Font
        const fontBuffer = await fetchFont(fontLang);
        let customFont;

        // 5. Create new PDF
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);

        if (fontBuffer) {
            customFont = await pdfDoc.embedFont(fontBuffer);
        } else {
            console.warn("Font load failed, using Helvetica");
            customFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
        }

        // 6. AI自己検証用のカウンター
        let totalBlocks = 0;
        let successBlocks = 0;
        const validationIssues = [];

        // 7. Process each page (逐次処理)
        for (let pageIndex = 0; pageIndex < images.length; pageIndex++) {
            const imageDataUrl = images[pageIndex];
            console.log(`Processing page ${pageIndex + 1}/${images.length}...`);

            // 画像をBase64からBufferに変換
            const base64Data = imageDataUrl.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
            const imageBuffer = Buffer.from(base64Data, 'base64');

            // 画像をPDFに埋め込み
            let embeddedImage;
            try {
                if (imageDataUrl.includes('image/png')) {
                    embeddedImage = await pdfDoc.embedPng(imageBuffer);
                } else {
                    embeddedImage = await pdfDoc.embedJpg(imageBuffer);
                }
            } catch (embedErr) {
                console.error(`Failed to embed image: ${embedErr.message}`);
                throw new Error(`画像埋め込みエラー: ${embedErr.message}`);
            }

            // Vision API呼び出し
            const prompt = `
あなたは翻訳者およびレイアウト解析の専門家です。
以下の作業を実行してください：

1. 画像内のすべてのテキストブロック（タイトル、本文、型番など）を検出
2. 各ブロックを${targetLang}に正確に翻訳
3. 各ブロックの位置を画像の幅・高さに対するパーセンテージで正確に推定
   - bbox_pct: [top(%), left(%), width(%), height(%)] 
   - 元のテキストを完全に覆うように、少し余裕を持たせてください

以下の構造のJSONオブジェクトを返してください：
{
  "blocks": [
    {
      "original_text": "元のテキスト",
      "translated_text": "翻訳後のテキスト",
      "bbox_pct": [10, 20, 30, 5]
    }
  ]
}

JSONのみを出力してください。`;

            try {
                const completion = await client.chat.completions.create({
                    model: "gpt-5.1",
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: prompt },
                                { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } }
                            ]
                        }
                    ],
                    response_format: { type: "json_object" },
                    max_completion_tokens: 8000
                });

                const jsonRes = JSON.parse(completion.choices[0]?.message?.content || "{}");
                const blocks = jsonRes.blocks || [];

                totalBlocks += blocks.length;
                console.log(`Page ${pageIndex + 1}: Detected ${blocks.length} text blocks`);

                // AI自己検証
                blocks.forEach((block, idx) => {
                    const issues = validateTranslationBlock(block, `${pageIndex + 1}-${idx + 1}`);
                    if (issues.length === 0) {
                        successBlocks++;
                    } else {
                        validationIssues.push(...issues);
                    }
                });

                // PDFページを作成（元の画像サイズに合わせる）
                const imgWidth = embeddedImage.width;
                const imgHeight = embeddedImage.height;
                const page = pdfDoc.addPage([imgWidth, imgHeight]);

                // 背景として元の画像を配置
                page.drawImage(embeddedImage, {
                    x: 0,
                    y: 0,
                    width: imgWidth,
                    height: imgHeight
                });

                // 翻訳テキストをオーバーレイ
                blocks.forEach(block => {
                    if (!block.bbox_pct) return;

                    const [topPct, leftPct, widthPct, heightPct] = block.bbox_pct;
                    const text = block.translated_text || "";

                    const x = (leftPct / 100) * imgWidth;
                    const yTop = (topPct / 100) * imgHeight;
                    const w = (widthPct / 100) * imgWidth;
                    const h = (heightPct / 100) * imgHeight;
                    const y = imgHeight - yTop - h;

                    // パディングを追加（元のテキストを完全に隠す）
                    const padding = 3;

                    // 白背景で原文を隠す（完全に不透明）
                    page.drawRectangle({
                        x: Math.max(0, x - padding),
                        y: Math.max(0, y - padding),
                        width: Math.min(w + (padding * 2), imgWidth - x + padding),
                        height: Math.min(h + (padding * 2), imgHeight - y + padding),
                        color: rgb(1, 1, 1),
                        opacity: 1.0
                    });

                    // 翻訳テキストを描画
                    const fontSize = Math.max(9, Math.min(h * 0.7, 16));
                    try {
                        page.drawText(text, {
                            x: Math.max(2, x + 1),
                            y: Math.max(2, y + (h * 0.15)),
                            size: fontSize,
                            font: customFont,
                            color: rgb(0, 0, 0),
                            maxWidth: Math.max(10, w - 2),
                            lineHeight: fontSize * 1.15
                        });
                    } catch (drawErr) {
                        console.error(`Failed to draw text for block: ${drawErr.message}`);
                    }
                });

            } catch (visionErr) {
                console.error(`Vision API error on page ${pageIndex + 1}:`, visionErr);
                validationIssues.push(`Page ${pageIndex + 1}: Vision API call failed - ${visionErr.message}`);
            }
        }

        // 8. AI自己検証結果をログ出力
        console.log("\n=== AI Self-Validation Report ===");
        console.log(`Total blocks detected: ${totalBlocks}`);
        console.log(`Successfully validated blocks: ${successBlocks}`);
        console.log(`Failed blocks: ${totalBlocks - successBlocks}`);

        if (validationIssues.length > 0) {
            console.log("\nValidation Issues:");
            validationIssues.forEach(issue => console.log(`  - ${issue}`));
        } else {
            console.log("All blocks passed validation!");
        }
        console.log("=================================\n");

        // 9. Response
        const finalBytes = await pdfDoc.save();
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="translated_result.pdf"`);
        return res.status(200).send(Buffer.from(finalBytes));

    } catch (err) {
        console.error("Handler Error:", err);
        return res.status(500).json({
            error: err.message || "Unknown Error"
        });
    }
};
