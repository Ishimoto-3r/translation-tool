// PDF翻訳API - バックエンド
// pdf.js座標 + GPT翻訳専業 + 画像ベースPDF対応（Vision APIフォールバック）

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

        // AI自己検証用
        let totalTexts = 0;
        let successfulTranslations = 0;
        const validationIssues = [];

        // 各ページを処理
        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
            const pageData = pages[pageIndex];
            console.log(`Processing page ${pageIndex + 1}/${pages.length}...`);

            // テキスト抽出がない場合（画像ベースPDF）、Vision APIで処理
            if (pageData.textItems.length === 0 && pageData.image) {
                console.log(`Page ${pageIndex + 1}: Image-based PDF detected, using Vision API for OCR...`);

                // 画像をPDFに埋め込み
                const base64Data = pageData.image.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const embeddedImage = await pdfDoc.embedJpg(imageBuffer);

                // ページ作成
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

                // Vision APIでOCR+翻訳
                const ocrResult = await processImageWithVision(pageData.image, targetLang);
                totalTexts += ocrResult.blocks.length;
                successfulTranslations += ocrResult.success;
                validationIssues.push(...ocrResult.issues);

                // 翻訳テキストをオーバーレイ
                ocrResult.blocks.forEach(block => {
                    if (!block.translated_text || !block.bbox_pct) return;

                    const [leftPct, topPct, widthPct, heightPct] = block.bbox_pct;
                    const x = (leftPct / 100) * imgWidth;
                    const yTop = (topPct / 100) * imgHeight;
                    const w = (widthPct / 100) * imgWidth;
                    const h = (heightPct / 100) * imgHeight;
                    const y = imgHeight - yTop - h;

                    const padding = 3;

                    // 白背景で原文を隠す
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
                        page.drawText(block.translated_text, {
                            x: x,
                            y: y,
                            size: fontSize,
                            font: customFont,
                            color: rgb(0, 0, 0),
                            maxWidth: w,
                            lineHeight: fontSize * 1.1
                        });
                    } catch (drawErr) {
                        console.error(`Failed to draw text: ${drawErr.message}`);
                    }
                });

                continue; // 次のページへ
            }

            // テキスト抽出（通常のPDF）
            const texts = pageData.textItems.map(item => item.text);
            totalTexts += texts.length;

            console.log(`Page ${pageIndex + 1}: ${texts.length} text items`);

            // GPT APIで翻訳
            const translations = await translateTexts(texts, targetLang);

            // 検証
            const validation = validateTranslations(texts, translations);
            successfulTranslations += validation.success;
            validationIssues.push(...validation.issues);

            // PDFページ作成
            const page = pdfDoc.addPage([pageData.width, pageData.height]);

            // 各テキストを配置
            pageData.textItems.forEach((item, idx) => {
                const translatedText = translations[idx] || "";

                if (!translatedText) {
                    console.warn(`Empty translation for item ${idx + 1}: "${item.text}"`);
                    return;
                }

                // PDF座標系（左下が原点）
                const x = item.x;
                const y = item.y;
                const width = item.width;
                const height = item.height;

                // パディング
                const padding = 2;

                // 白背景で原文を隠す
                page.drawRectangle({
                    x: Math.max(0, x - padding),
                    y: Math.max(0, y - padding),
                    width: Math.min(width + (padding * 2), pageData.width - x + padding),
                    height: Math.min(height + (padding * 2), pageData.height - y + padding),
                    color: rgb(1, 1, 1),
                    opacity: 1.0
                });

                // 翻訳テキストを描画
                const fontSize = Math.max(8, Math.min(item.fontSize * 0.85, 18));

                try {
                    page.drawText(translatedText, {
                        x: x,
                        y: y,
                        size: fontSize,
                        font: customFont,
                        color: rgb(0, 0, 0),
                        maxWidth: width,
                        lineHeight: fontSize * 1.1
                    });
                } catch (drawErr) {
                    console.error(`Failed to draw text at (${x}, ${y}): ${drawErr.message}`);
                }
            });
        }

        // AI自己検証レポート
        console.log("=== AI Self-Validation Report ===");
        console.log(`Total texts: ${totalTexts}`);
        console.log(`Successfully translated: ${successfulTranslations}`);
        console.log(`Failed: ${totalTexts - successfulTranslations}`);
        if (validationIssues.length > 0) {
            console.log("Validation Issues:");
            validationIssues.forEach(issue => console.log(`  - ${issue}`));
        }
        console.log("=================================");

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

// Vision APIでOCR+翻訳（画像ベースPDF用）
async function processImageWithVision(imageDataUrl, targetLang) {
    const prompt = `
あなたは翻訳者およびレイアウト解析の専門家です。
以下の作業を実行してください：

1. 画像内のすべてのテキストブロック（タイトル、本文、型番など）を検出
2. 各ブロックを${targetLang}に正確に翻訳
3. 各ブロックの位置を画像左上を(0,0)、右下を(100,100)とするパーセンテージで指定
   - bbox_pct形式: [left%, top%, width%, height%]
   - left%: 左端の位置（0～100）
   - top%: 上端の位置（0～100）
   - width%: ブロックの幅（0～100）
   - height%: ブロックの高さ（0～100）
   - 元のテキストを完全に覆うように、少し余裕を持たせてください

以下の構造のJSONオブジェクトを返してください：
{
  "blocks": [
    {
      "original_text": "元のテキスト",
      "translated_text": "翻訳後のテキスト",
      "bbox_pct": [5.0, 10.0, 30.0, 5.0]
    }
  ]
}

JSONのみを出力してください。`;

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
            response_format: { type: "json_object" },
            max_completion_tokens: 4000
        });

        const result = JSON.parse(completion.choices[0].message.content);
        const blocks = result.blocks || [];

        // 検証
        const validation = validateVisionBlocks(blocks);

        return {
            blocks: blocks,
            success: validation.success,
            issues: validation.issues
        };

    } catch (error) {
        console.error("Vision API error:", error);
        return {
            blocks: [],
            success: 0,
            issues: [`Vision API error: ${error.message}`]
        };
    }
}

// Vision APIブロックの検証
function validateVisionBlocks(blocks) {
    const issues = [];
    let successCount = 0;

    blocks.forEach((block, idx) => {
        if (!block.translated_text || block.translated_text.trim() === "") {
            issues.push(`Block ${idx + 1}: 空の翻訳結果`);
            return;
        }

        if (!block.bbox_pct || block.bbox_pct.length !== 4) {
            issues.push(`Block ${idx + 1}: 位置情報が不正`);
            return;
        }

        const hasChinese = /[\u4e00-\u9fff]/.test(block.translated_text);
        const isAlphanumeric = /^[A-Za-z0-9\-_]+$/.test(block.translated_text);

        if (hasChinese || isAlphanumeric) {
            successCount++;
        } else {
            issues.push(`Block ${idx + 1}: 中国語文字が含まれていない - "${block.translated_text}"`);
        }
    });

    return {
        success: successCount,
        issues: issues
    };
}

// GPT APIでテキスト翻訳
async function translateTexts(texts, targetLang) {
    if (texts.length === 0) {
        return [];
    }

    const textsWithIndex = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');

    const prompt = `以下のテキストを${targetLang}に翻訳してください。
各行を翻訳し、同じ順序でJSON配列として返してください。
型番や固有名詞（例: 3R-MFXS50, Anyty）はそのまま返してください。

入力:
${textsWithIndex}

出力形式: {"translations": ["翻訳1", "翻訳2", ...]}
必ず${texts.length}個の翻訳を返してください。`;

    try {
        const completion = await client.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" },
            max_completion_tokens: 4000
        });

        const result = JSON.parse(completion.choices[0].message.content);
        const translations = result.translations || [];

        // 数が一致しない場合は空配列で埋める
        while (translations.length < texts.length) {
            translations.push("");
        }

        return translations.slice(0, texts.length);

    } catch (error) {
        console.error("Translation API error:", error);
        // エラー時は元のテキストをそのまま返す
        return texts;
    }
}

// 翻訳結果の検証
function validateTranslations(originalTexts, translations) {
    const issues = [];
    let successCount = 0;

    // 数の一致チェック
    if (originalTexts.length !== translations.length) {
        issues.push(`テキスト数不一致: 原文${originalTexts.length}件、翻訳${translations.length}件`);
    }

    translations.forEach((trans, idx) => {
        // 空チェック
        if (!trans || trans.trim() === "") {
            issues.push(`翻訳${idx + 1}: 空の翻訳結果`);
            return;
        }

        // 中国語文字チェック（型番などは除外）
        const hasChinese = /[\u4e00-\u9fff]/.test(trans);
        const isAlphanumeric = /^[A-Za-z0-9\-_]+$/.test(trans);

        // 中国語文字があるか、型番（英数字のみ）なら成功
        if (hasChinese || isAlphanumeric) {
            successCount++;
        } else {
            issues.push(`翻訳${idx + 1}: 中国語文字が含まれていない - "${trans}"`);
        }
    });

    return {
        total: originalTexts.length,
        success: successCount,
        failed: originalTexts.length - successCount,
        issues: issues
    };
}
