module.exports = async (req, res) => {
  // 1. CORS設定
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { rows, toLang, context } = req.body;
    const apiKey = process.env.OPENAI_API_KEY;

    console.log("【Word受信】", rows ? rows.length + "件" : "なし", "Context:", context || "なし");

    if (!apiKey) throw new Error('APIキーが設定されていません');
    if (!rows || !Array.isArray(rows) || rows.length === 0) throw new Error('データが空です');

    // コンテキストがあれば追加
    let contextPrompt = "";
    if (context && context.trim() !== "") {
      contextPrompt = `
      【文書の背景情報】
      ユーザーからの指示: "${context}"
      この情報を踏まえて適切な用語選択を行ってください。
      `;
    }

    const systemPrompt = `
      あなたはプロの翻訳者です。
      入力されたテキスト配列を "${toLang}" に翻訳し、JSON形式で返してください。
      
      ${contextPrompt}

      【重要ルール】
      - これはWordファイル内のテキストです。文脈を維持してください。
      - 数値、型番、固有の記号などはそのまま維持してください。
      
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
        model: 'gpt-5',
        messages: [
          { "role": "system", "content": systemPrompt },
          { "role": "user", "content": JSON.stringify({ rows: rows }) }
        ],
        response_format: { type: "json_object" },
        // 高速化設定
        reasoning_effort: "minimal",
        verbosity: "low"
      })
    });

    if (!apiResponse.ok) {
      const errData = await apiResponse.json();
      throw new Error(errData.error?.message || `OpenAI API error: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    const content = data.choices[0].message.content;
    const parsedResult = JSON.parse(content);
    
    return res.status(200).json(parsedResult);

  } catch (error) {
    console.error("【Wordエラー】", error);
    return res.status(500).json({ 
      error: 'Internal Server Error', 
      detail: error.message 
    });
  }
};
