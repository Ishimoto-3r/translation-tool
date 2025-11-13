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
    const { rows, toLang } = req.body;
    const apiKey = process.env.OPENAI_API_KEY;

    // ログ：受信データ確認
    console.log("【受信データ】", rows ? rows.length + "件" : "なし");

    if (!apiKey) {
      throw new Error('APIキーが設定されていません');
    }
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      throw new Error('データが空です');
    }

    const systemPrompt = `
      あなたはプロの翻訳者です。
      入力された配列を "${toLang}" に翻訳し、JSON形式で返してください。
      
      出力フォーマット:
      { "translations": ["翻訳1", "翻訳2"] }
    `;

    // ★ご提示いただいたコードをベースに fetch で直接送信
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
        response_format: { type: "json_object" }, // JSON出力を強制
        
        // ★速度向上のための推論調整（ご指定の設定）
        reasoning_effort: "minimal",
        verbosity: "low"
        // temperature は削除済み
      })
    });

    // APIからの生のエラーレスポンスを取得
    if (!apiResponse.ok) {
      const errData = await apiResponse.json();
      console.error("OpenAI API Error:", JSON.stringify(errData));
      throw new Error(errData.error?.message || `OpenAI API error: ${apiResponse.status}`);
    }

    const data = await apiResponse.json();
    const content = data.choices[0].message.content;

    // ログ：AI応答確認
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
