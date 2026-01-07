module.exports = async (req, res) => {
  // 1. CORS (アクセス許可) 設定
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const MODEL_TRANSLATE = process.env.MODEL_TRANSLATE || "gpt-5.1";

    // ★変更点: context を受け取る
    const { rows, toLang, context } = req.body;
    const apiKey = process.env.OPENAI_API_KEY;

    console.log("【受信データ】", rows ? rows.length + "件" : "なし", "Context:", context || "なし");

    if (!apiKey) {
      throw new Error('APIキーが設定されていません');
    }
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      throw new Error('データが空です');
    }

    // ★変更点: コンテキストがあればシステムプロンプトに追加
    let contextPrompt = "";
    if (context && context.trim() !== "") {
        contextPrompt = `
        【追加指示（コンテキスト）】
        ユーザーからの指示: "${context}"
        この指示に従って翻訳のトーンや用語選択を行ってください。
        `;
    }

const jaGuard = (toLang === "ja") ? `
【重要】
- 中国語（简体/繁体）は日本語ではありません。漢字が多くても中国語は必ず日本語に翻訳してください。
- 固有名詞・型番は維持して構いませんが、文の意味は必ず日本語にしてください。
` : "";

const systemPrompt = `
あなたはプロの翻訳者です。
入力された配列を、必ず "${toLang}" に翻訳し、JSON形式で返してください。
${jaGuard}

【翻訳の必須ルール】
- 原文の言語が "${toLang}" と異なる場合、必ず翻訳してください。
- 「意味が通じる」「専門用語だから」などの理由で原文を残すことは禁止です。

【翻訳不要として原文を維持してよい条件（全言語共通）】
- 数値のみ（例: 12.5, 2024）
- 型番・記号・コード（例: USB-C, ODM, ABC-123）
- 空文字・記号のみ
- 注意：中国語（簡体字/繁体字）は日本語ではありません。漢字が含まれていても、中国語なら必ず "${toLang}" に翻訳してください。

${contextPrompt}

出力フォーマット:
{ "translations": ["翻訳1", "翻訳2"] }
`;



    const apiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
model: MODEL_TRANSLATE,

        messages: [
          { "role": "system", "content": systemPrompt },
          { "role": "user", "content": JSON.stringify({ rows: rows }) }
        ],
        response_format: { type: "json_object" }, 
        
        // 速度向上のための設定（維持）
reasoning_effort: "none",

        verbosity: "low"
      })
    });

    if (!apiResponse.ok) {
      const errData = await apiResponse.json();
      console.error("OpenAI API Error:", JSON.stringify(errData));
      throw new Error(errData.error?.message || `OpenAI API error: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    const content = data.choices[0].message.content;

    console.log("【AI応答】受信完了");

    const parsedResult = JSON.parse(content);
    return res.status(200).json(parsedResult);

  } catch (error) {
    console.error("【エラー発生】", error);
    return res.status(500).json({ 
      error: 'Internal Server Error', 
      detail: error.message 
    });
  }
};
