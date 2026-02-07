// PDF翻訳API - バックエンド
// 追記型: 各ページ下部に中国語翻訳を追記

const { PDFDocument, rgb } = require("pdf-lib");
const fs = require("fs");
const path = require("path");
const fontkit = require("@pdf-lib/fontkit");
const logger = require("./utils/logger");
const openaiClient = require("./utils/openai-client");

// 依存関係コンテナ
const deps = {
    logger,
    openaiClient
};

const config = {
    maxDuration: 60,
    api: {
        bodyParser: {
            sizeLimit: "10mb"
        }
    }
};

async function handler(req, res) {
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
        const { pages, direction, url } = req.body;

        // URLが指定された場合、PDFを取得してBase64で返す（プレビュー用）
        if (url && !pages) {
            deps.logger.info("pdftranslate", `[URL Fetch] Fetching PDF from: ${url}`);
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch PDF: ${response.statusText}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString('base64');

            return res.status(200).json({
                pdfBase64: base64,
                contentType: 'application/pdf'
            });
        }

        if (!pages || !Array.isArray(pages) || pages.length === 0) {
            return res.status(400).json({ error: "Invalid request: pages array required" });
        }

        deps.logger.info("pdftranslate", `Processing ${pages.length} page(s), Direction: ${direction}`);

        // 翻訳方向設定
        let targetLang;
        switch (direction) {
            case "ja-zh":
                targetLang = "簡体字中国語";
                break;
            case "ja-en":
                targetLang = "英語";
                break;
            case "ja-ko":
                targetLang = "韓国語";
                break;
            case "zh-ja":
                targetLang = "日本語";
                break;
            default:
                targetLang = "簡体字中国語"; // デフォルト
        }
        deps.logger.debug("pdftranslate", `Target: ${targetLang}`);

        // フォント読み込み
        const fontPath = path.join(process.cwd(), "api", "fonts", "NotoSansSC-Regular.woff2");
        deps.logger.debug("pdftranslate", "Loading font from:", { fontPath });

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
            deps.logger.info("pdftranslate", `Processing page ${pageIndex + 1}/${pages.length}`);

            let translationText = "";
            let translationSource = "";

            // テキストPDF
            if (pageData.textItems && pageData.textItems.length > 0) {
                deps.logger.debug("pdftranslate", `Page ${pageIndex + 1}: Text items found: ${pageData.textItems.length}`);
                translationSource = "textLayer";

                const texts = pageData.textItems.map(item => item.text);
                const combinedText = texts.join('\n');

                translationText = await translateTextWithGPT(combinedText, targetLang);
            }
            // 画像PDF
            else if (pageData.image) {
                deps.logger.debug("pdftranslate", `Page ${pageIndex + 1}: No text items, using Vision API...`);
                translationSource = "vision";

                translationText = await translateImageWithVision(pageData.image, targetLang);
            }
            else {
                deps.logger.warn("pdftranslate", `Page ${pageIndex + 1}: No text or image data`);
                translationText = "";
            }

            // 検証
            const hasChinese = /[\u4e00-\u9fff]/.test(translationText);
            const isEmpty = !translationText || translationText.trim().length === 0;

            deps.logger.info("pdftranslate", `Page ${pageIndex + 1} Result`, {
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

        // Step 2: PDFを生成（元のページ + 翻訳ページ）
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
            const pageData = pages[pageIndex];
            const translation = pageTranslations[pageIndex];

            deps.logger.debug("pdftranslate", `Generating PDF pages for page ${pageIndex + 1}`);

            let pageWidth;
            let pageHeight;

            // === 元のページを追加 ===
            let originalPage;

            // 画像PDF
            if (pageData.image) {
                const base64Data = pageData.image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const embeddedImage = await pdfDoc.embedJpg(imageBuffer);

                pageWidth = embeddedImage.width;
                pageHeight = embeddedImage.height;

                originalPage = pdfDoc.addPage([pageWidth, pageHeight]);

                // 背景として元の画像を配置
                originalPage.drawImage(embeddedImage, {
                    x: 0,
                    y: 0,
                    width: pageWidth,
                    height: pageHeight
                });
            }
            // テキストPDF（背景なし、白ページ）
            else {
                pageWidth = pageData.width || 595;
                pageHeight = pageData.height || 842;
                originalPage = pdfDoc.addPage([pageWidth, pageHeight]);
            }

            totalPages++;

            // === 翻訳専用ページを追加 ===
            if (translation && translation.trim().length > 0) {
                const translationPage = pdfDoc.addPage([pageWidth, pageHeight]);

                // 見出しを追加
                const headerText = `（${pageIndex + 1}ページ目の翻訳）`;
                translationPage.drawText(headerText, {
                    x: 20,
                    y: pageHeight - 30,
                    size: 10,
                    font: customFont,
                    color: rgb(0.5, 0.5, 0.5)
                });

                // 翻訳テキストを描画
                await drawTranslationOnPage(
                    translationPage,
                    translation,
                    customFont,
                    pageWidth,
                    pageHeight
                );

                totalPages++;
                deps.logger.debug("pdftranslate", `Page ${pageIndex + 1}: Translation page added`);
            }
        }

        // AI自己検証レポート
        deps.logger.info("pdftranslate", "AI Self-Validation Report", {
            totalPages,
            successfulTranslations,
            failed: totalPages - successfulTranslations,
            validationIssues
        });

        // PDF保存
        const pdfBytes = await pdfDoc.save();

        // レスポンス
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="translated.pdf"');
        return res.status(200).send(Buffer.from(pdfBytes));

    } catch (error) {
        deps.logger.error("pdftranslate", "API Error", { error: error.message });
        return res.status(500).json({
            error: "Translation failed",
            details: error.message
        });
    }
}

// 翻訳専用ページに翻訳を描画
async function drawTranslationOnPage(page, translationText, font, pageWidth, pageHeight) {
    const margin = 40;
    const topMargin = 60; // 見出し分のスペース
    const maxWidth = pageWidth - (margin * 2);
    const maxHeight = pageHeight - topMargin - margin;

    // フォントサイズ調整
    let fontSize = 14;
    const lines = wrapText(translationText, font, fontSize, maxWidth);
    let textHeight = lines.length * fontSize * 1.4;

    // 収まらない場合、フォントサイズを下げる
    while (textHeight > maxHeight && fontSize > 8) {
        fontSize -= 0.5;
        const newLines = wrapText(translationText, font, fontSize, maxWidth);
        textHeight = newLines.length * fontSize * 1.4;
    }

    // 最終的な折り返し
    const finalLines = wrapText(translationText, font, fontSize, maxWidth);

    // 描画（上から下へ）
    let yPos = pageHeight - topMargin;
    for (const line of finalLines) {
        if (yPos < margin) break; // ページ下端に到達

        try {
            page.drawText(line, {
                x: margin,
                y: yPos,
                size: fontSize,
                font: font,
                color: rgb(0, 0, 0)
            });
        } catch (drawErr) {
            deps.logger.warn("pdftranslate", `Failed to draw text line: ${drawErr.message}`);
        }

        yPos -= fontSize * 1.4;
    }
}

// テキスト折り返し（中国語対応）
function wrapText(text, font, fontSize, maxWidth) {
    const lines = [];
    let currentLine = '';

    // 改行で分割
    const paragraphs = text.split('\n');

    for (const paragraph of paragraphs) {
        if (!paragraph.trim()) {
            if (currentLine) {
                lines.push(currentLine);
                currentLine = '';
            }
            lines.push(''); // 空行を保持
            continue;
        }

        // 文字単位で処理
        for (let i = 0; i < paragraph.length; i++) {
            const char = paragraph[i];
            const testLine = currentLine + char;

            try {
                const testWidth = font.widthOfTextAtSize(testLine, fontSize);

                if (testWidth > maxWidth && currentLine.length > 0) {
                    lines.push(currentLine);
                    currentLine = char;
                } else {
                    currentLine = testLine;
                }
            } catch (err) {
                // フォント幅計算エラーの場合、文字を追加
                currentLine = testLine;
            }
        }

        // 段落の終わり
        if (currentLine.length > 0) {
            lines.push(currentLine);
            currentLine = '';
        }
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
        const completion = await deps.openaiClient.chatCompletion({
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
            // Vision API uses larger tokens usually
            max_completion_tokens: 2000,
            jsonMode: false
        });

        return completion.choices[0].message.content || "";

    } catch (error) {
        deps.logger.error("pdftranslate", "Vision API error", { error: error.message });
        return `[Vision API エラー: ${error.message}]`;
    }
}

// GPT APIでテキスト翻訳
async function translateTextWithGPT(text, targetLang) {
    try {
        // OpenAI Client Wrapper uses gpt-4-turbo by default, which is good for text
        // But we want to specify gpt-4o for consistency or specific capability if needed.
        // For simple translation, gpt-4-turbo (wrapper default) is fine.
        // However, the original code used gpt-4o. Let's stick to gpt-4o.

        const completion = await deps.openaiClient.chatCompletion({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `あなたはプロフェッショナルな技術翻訳者です。
入力されたマニュアルをお客様のために${targetLang}に翻訳してください。

重要なルール:
1. 翻訳結果のみをJSON形式で出力すること。会話や謝罪は一切禁止。
2. 技術用語は正確に翻訳すること。
3. 元のテキストの意味を損なわないこと。
4. 入力が断片的でも、文脈を補完して翻訳すること。

出力フォーマット:
{ "translation": "翻訳されたテキスト" }`
                },
                {
                    role: "user",
                    content: text
                }
            ],
            jsonMode: true
            // response_format: { type: "json_object" } // Wrapper handles this based on jsonMode
        });

        let result;
        try {
            result = JSON.parse(completion.choices[0].message.content);
        } catch (e) {
            deps.logger.warn("pdftranslate", "Failed to parse JSON response from GPT", { content: completion.choices[0].message.content });
            return completion.choices[0].message.content; // Fallback to raw content
        }
        return result.translation || result.text || completion.choices[0].message.content;

    } catch (error) {
        deps.logger.error("pdftranslate", "Translation API error", { error: error.message });
        return `[翻訳エラー: ${error.message}]`;
    }
}

// CommonJS Exports
module.exports = handler;
module.exports.config = config;
module.exports.wrapText = wrapText;
module.exports.drawTranslationOnPage = drawTranslationOnPage;
module.exports._deps = deps;
