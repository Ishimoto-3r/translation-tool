// PDF翻訳API - バックエンド
// 追記型: 各ページ下部に中国語翻訳を追記

import OpenAI from "openai";
import { PDFDocument, rgb } from "pdf-lib";
import * as fs from "fs";
import * as path from "path";
import fontkit from "@pdf-lib/fontkit";

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

export const config = {
    maxDuration: 60,
    api: {
        bodyParser: {
            sizeLimit: "10mb"
        }
    }
};

export default async function handler(req, res) {
    // CORS設定
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { pages, direction } = req.body;

        if (!pages || !Array.isArray(pages) || pages.length === 0) {
            return res.status(400).json({ error: "Invalid request: pages array required" });
        }

        console.log(`Processing ${pages.length} page(s), Direction: ${direction}`);

        // 翻訳方向設定
        const targetLang = direction === "ja-zh" ? "簡体字中国語" : "日本語";
        console.log(`Target: ${targetLang}`);

        // フォント読み込み
        const fontPath = path.join(process.cwd(), "api", "fonts", "NotoSansSC-Regular.woff2");
        console.log("Loading font from:", fontPath);

        if (!fs.existsSync(fontPath)) {
            throw new Error(`Font file not found: ${fontPath}`);
        }

        const fontBytes = fs.readFileSync(fontPath);

        // PDF作成
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        const customFont = await pdfDoc.embedFont(fontBytes);

        // 統計用
        let totalPages = 0;
        let successfulTranslations = 0;
        const validationIssues = [];

        // Step 1: 各ページの翻訳を取得
        const pageTranslations = [];

        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
            const pageData = pages[pageIndex];
            console.log(`\n=== Processing page ${pageIndex + 1}/${pages.length} ===`);

            let translationText = "";
            let translationSource = "";

            // テキストPDF
            if (pageData.textItems && pageData.textItems.length > 0) {
                console.log(`  Text items found: ${pageData.textItems.length}`);
                translationSource = "textLayer";

                const texts = pageData.textItems.map(item => item.text);
                const combinedText = texts.join('\n');

                translationText = await translateTextWithGPT(combinedText, targetLang);
            }
            // 画像PDF
            else if (pageData.image) {
                console.log(`  No text items, using Vision API...`);
                translationSource = "vision";

                translationText = await translateImageWithVision(pageData.image, targetLang);
            }
            else {
                console.warn(`  Page ${pageIndex + 1}: No text or image data`);
                translationText = "";
            }

            // 検証
            const hasChinese = /[\u4e00-\u9fff]/.test(translationText);
            const isEmpty = !translationText || translationText.trim().length === 0;

            console.log(`  Translation result:`, {
                source: translationSource,
                length: translationText.length,
                isEmpty: isEmpty,
                hasChinese: hasChinese
            });

            if (!isEmpty && hasChinese) {
                successfulTranslations++;
            } else if (!isEmpty) {
                validationIssues.push(`Page ${pageIndex + 1}: 翻訳に中国語文字が含まれていない`);
            }

            pageTranslations.push(translationText);
        }

        // Step 2: PDFを生成（追記型）
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
            const pageData = pages[pageIndex];
            const translation = pageTranslations[pageIndex];

            console.log(`\n=== Generating PDF page ${pageIndex + 1} ===`);

            let pdfPage;
            let pageWidth;
            let pageHeight;

            // 画像PDF
            if (pageData.image) {
                const base64Data = pageData.image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const embeddedImage = await pdfDoc.embedJpg(imageBuffer);

                pageWidth = embeddedImage.width;
                pageHeight = embeddedImage.height;

                pdfPage = pdfDoc.addPage([pageWidth, pageHeight]);

                // 背景として元の画像を配置
                pdfPage.drawImage(embeddedImage, {
                    x: 0,
                    y: 0,
                    width: pageWidth,
                    height: pageHeight
                });

                console.log(`  Image background: ${pageWidth} x ${pageHeight}`);
            }
            // テキストPDF（背景なし、白ページ）
            else {
                pageWidth = pageData.width || 595;
                pageHeight = pageData.height || 842;
                pdfPage = pdfDoc.addPage([pageWidth, pageHeight]);

                console.log(`  Blank page: ${pageWidth} x ${pageHeight}`);
            }

            // ページ下部に翻訳を追記
            if (translation && translation.trim().length > 0) {
                const overflow = await drawTranslationAtBottom(
                    pdfPage,
                    translation,
                    customFont,
                    pageWidth,
                    pageHeight
                );

                // 収まらない場合、続きページを追加
                if (overflow) {
                    console.log(`  Translation overflow, adding continuation page...`);
                    // TODO: 続きページ実装（必要に応じて）
                }
            }

            totalPages++;
        }

        // AI自己検証レポート
        console.log("\n=== AI Self-Validation Report ===");
        console.log(`Total pages: ${totalPages}`);
        console.log(`Successfully translated: ${successfulTranslations}`);
        console.log(`Failed: ${totalPages - successfulTranslations}`);
        if (validationIssues.length > 0) {
            console.log("Validation Issues:");
            validationIssues.forEach(issue => console.log(`  - ${issue}`));
        }
        console.log("=================================\n");

        // PDF保存
        const pdfBytes = await pdfDoc.save();

        // レスポンス
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="translated.pdf"');
        return res.status(200).send(Buffer.from(pdfBytes));

    } catch (error) {
        console.error("API Error:", error);
        return res.status(500).json({
            error: "Translation failed",
            details: error.message
        });
    }
}

// ページ下部に翻訳を描画
async function drawTranslationAtBottom(page, translationText, font, pageWidth, pageHeight) {
    const bandHeight = 150; // 翻訳エリアの高さ
    const margin = 20;
    const maxWidth = pageWidth - (margin * 2);

    // 半透明白背景（読みやすさ向上）
    page.drawRectangle({
        x: 0,
        y: 0,
        width: pageWidth,
        height: bandHeight,
        color: rgb(1, 1, 1),
        opacity: 0.95
    });

    // フォントサイズ調整
    let fontSize = 12;
    const lines = wrapText(translationText, font, fontSize, maxWidth);
    let textHeight = lines.length * fontSize * 1.3;

    // 収まらない場合、フォントサイズを下げる
    while (textHeight > (bandHeight - margin * 2) && fontSize > 8) {
        fontSize -= 0.5;
        const newLines = wrapText(translationText, font, fontSize, maxWidth);
        textHeight = newLines.length * fontSize * 1.3;
    }

    // 最終的な折り返し
    const finalLines = wrapText(translationText, font, fontSize, maxWidth);

    // 描画
    let yPos = bandHeight - margin - fontSize;
    for (const line of finalLines) {
        if (yPos < margin) break; // 収まらない

        try {
            page.drawText(line, {
                x: margin,
                y: yPos,
                size: fontSize,
                font: font,
                color: rgb(0, 0, 0)
            });
        } catch (drawErr) {
            console.error(`Failed to draw text: ${drawErr.message}`);
        }

        yPos -= fontSize * 1.3;
    }

    // オーバーフロー判定
    const overflow = textHeight > (bandHeight - margin * 2);
    console.log(`  Translation band: fontSize=${fontSize}, lines=${finalLines.length}, overflow=${overflow}`);

    return overflow;
}

// テキスト折り返し（簡易版）
function wrapText(text, font, fontSize, maxWidth) {
    const words = text.split('');
    const lines = [];
    let currentLine = '';

    for (const char of words) {
        const testLine = currentLine + char;
        const testWidth = font.widthOfTextAtSize(testLine, fontSize);

        if (testWidth > maxWidth && currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = char;
        } else {
            currentLine = testLine;
        }
    }

    if (currentLine.length > 0) {
        lines.push(currentLine);
    }

    return lines;
}

// Vision APIで翻訳（テキストのみ取得、bbox禁止）
async function translateImageWithVision(imageDataUrl, targetLang) {
    const prompt = `
Please perform OCR on this image and translate all Japanese text to ${targetLang}.

Task:
1. Read all Japanese text visible in this image (including titles, body text, model numbers, captions, etc.)
2. Translate the read text to ${targetLang}
3. Return only the translated text

Important guidelines:
- Read text from top to bottom, left to right
- Include ALL text elements you can see
- Keep model numbers and proper nouns unchanged (e.g., "3R-MFXS50", "Anyty")
- Present translation in paragraph format
- NO position information or JSON format needed
- This is a standard OCR and translation task for a product manual

Example output format:
使用说明书
3R-MFXS50
Anyty
可动式前端内窥镜
3R-MFXS50
[additional translated text...]

Please provide the translation:
`;

    try {
        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: imageDataUrl } }
                    ]
                }
            ],
            max_completion_tokens: 2000
        });

        return completion.choices[0].message.content || "";

    } catch (error) {
        console.error("Vision API error:", error);
        return `[Vision API エラー: ${error.message}]`;
    }
}

// GPT APIでテキスト翻訳
async function translateTextWithGPT(text, targetLang) {
    const prompt = `以下のテキストを${targetLang}に翻訳してください。
型番や固有名詞はそのまま返してください。

入力:
${text}

出力: 翻訳のみを返してください（説明不要）`;

    try {
        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            max_completion_tokens: 2000
        });

        return completion.choices[0].message.content || "";

    } catch (error) {
        console.error("Translation API error:", error);
        return `[翻訳エラー: ${error.message}]`;
    }
}
