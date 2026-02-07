// api/utils/prompts.js
// AIへの指示（プロンプト）を一元管理するファイルです。

/**
 * 検品リスト作成 (inspection.js) 用プロンプト
 */
const INSPECTION_PROMPTS = {
    // 役割定義
    SYSTEM: `
あなたは取扱説明書（日本語）の内容から、検品リスト作成に必要な情報を抽出します。
必ずJSONのみを返してください（説明文は不要）。
`.trim(),

    // 抽出タスクの指示
    USER_TEMPLATE: (modelHint, productHint, fileName, sourceText) => `
【目的】
検品リストに入れる「仕様」「動作」「付属品」、および「型番」「製品名」を抽出します。

【重要ルール】
- 「動作」には、安全注意/禁止/中止/警告/注意（安全・取扱注意、禁止事項）は入れない。
- 「動作」は、実際の操作/設定/表示/接続/保存など “できること” を箇条書きで。
- 「動作」は、まとまりがある場合は title を1つ作り、その配下に items を並べる（例：メニュー設定系はまとめる）。
- 「付属品」は、PDFに書かれているものをできるだけ拾う。表記揺れを整理する（例：USBケーブル/USBコード/ケーブル→USBケーブル）。
- ただし「取扱説明書」は、PDF内の明記が無くても必ず付属品候補に入れる（表記は「取扱説明書」に統一）。
- 型番/製品名は、PDF内の表記（例：3R-XXXX）やタイトル行から推定。見つからない場合は空文字。

【ヒント（既に入力されている可能性あり）】
- 型番ヒント: ${modelHint || ""}
- 製品名ヒント: ${productHint || ""}

【返却JSONスキーマ（厳守）】
{
  "model": "型番",
  "productName": "製品名",
  "specs": ["仕様の箇条書き", "..."],
  "ops": [{"title":"見出し","items":["動作1","動作2"]}],
  "accs": ["付属品1","付属品2","取扱説明書"]
}

【本文テキスト（抜粋元）】
ファイル名: ${fileName}
---
${sourceText}
`.trim()
};

/**
 * PDF翻訳・OCR (pdftranslate.js) 用プロンプト
 */
const PDF_TRANSLATE_PROMPTS = {
    // OCR & 翻訳指示
    VISION_USER_TEMPLATE: (targetLang) => `
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
`.trim()
};

/**
 * マニュアル作成 (manual-ai.js) 用プロンプト
 */
const MANUAL_AI_PROMPTS = {
    // 動画/画像からの手順書作成
    MEDIA_MANUAL_SYSTEM: `
あなたは日本語の取扱説明書向け原稿の作成者です。
入力の画像（動画から抽出したフレーム）を観察し、作業手順の原稿を作成してください。
文体は「です・ます」で統一します。

【絶対条件】
- 画像から断定できない仕様・数値・機能は推測で書かない（不明は不明として扱う）
- 危険表現、過剰な注意、禁止事項、免責、買い替え提案は出力しない
- 余計な前置きや結論は不要。原稿として使える文章だけを出力する

【粒度】
- simple: 手順数を絞り、要点のみ
- standard: 通常の取説レベル
- detailed: 迷いが出やすい箇所は補足して丁寧に（ただし推測は禁止）

【出力形式（必須）】
1) 1行目にタイトルを必ず出す：
   例）■ 電池の交換 / ■ 組み立て / ■ 操作方法
   ※備考に作業内容があれば、それを優先して具体的なタイトルにする
2) 2行目以降は番号付きで手順を列挙：
   1. 〜
   2. 〜
3) 最後に「確認事項：」を必要な場合のみ1〜3点
`.trim(),

    // ユーザー入力の構成
    MEDIA_MANUAL_USER_TEMPLATE: (notes, granularity, imageCount) =>
        (notes ? `備考: ${notes}\n` : "") +
        `粒度: ${granularity}\n` +
        `画像枚数: ${imageCount}\n`
};

/**
 * レポート作成 (report.js) 用の定型文
 * ※現状はクライアントサイドで組み立てているが、重要な文言はここで管理する
 */
const REPORT_CONSTANTS = {
    // Aram製品Wi-Fi干渉時の追加文言
    ARAM_WIFI_TEXT: '※お客様の使用環境(電波干渉等)によるものが考えられるため、機器のチャネル帯を変更します。'
};

module.exports = {
    INSPECTION_PROMPTS,
    PDF_TRANSLATE_PROMPTS,
    MANUAL_AI_PROMPTS,
    REPORT_CONSTANTS
};
