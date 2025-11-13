const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

module.exports = async (req, res) => {
  // 1. アクセス許可設定
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
    
    // ログ：受信データ確認
    console.log("【受信データ】", rows.length + "件");

    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      throw new Error('データが空です');
    }

    const systemPrompt = `
      あなたはプロの翻訳者です。
      入力された配列を "${toLang}" に翻訳し、JSON形式で返してください。
      
      出力フォーマット:
      { "translations": ["翻訳1", "翻訳2"] }
    `;

    // ★高速化設定を適用
    const completion = await openai.chat.completions.create({
      model: "gpt-5", 
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ rows: rows }) },
      ],
      response_format: { type: "json_object" },
      
      // 【変更点】速度優先設定
      // temperature: 0.3, // ← 削除（reasoning_effortと併用できないため）
      reasoning_effort: "minimal", // ← 追加（推論時間を短縮）
      
      // SDKの型定義にないパラメータを送信するための裏技
      extra_body: {
        verbosity: "low"
      }
    });

    const content = completion.choices[0].message.content;
    
    // ログ：AI応答確認
    console.log("【AI応答】受信完了");

    const parsedResult = JSON.parse(content);
    return res.status(200).json(parsedResult);

  } catch (error) {
    console.error("【エラー発生】", error);
    return res.status(500).json({ error: error.message });
  }
};
