// OpenAIの機能を読み込みます
const OpenAI = require('openai');

// Vercelに設定されたパスワード(API Key)を使って準備します
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ここがメインの処理です
module.exports = async (req, res) => {
  // 1. ブラウザからのアクセスを許可する設定（おまじない）
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // 通信確認（OPTIONS）の場合は「OK」だけ返して終了
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // 2. フロント画面から送られてきたデータを取り出す
    const { rows, toLang } = req.body;

    // データが空っぽだったり、リスト形式でなければエラーにする
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      throw new Error('データが正しくありません（rowsが空、または配列ではありません）');
    }

    // 3. AIへの命令文を作る
    const systemPrompt = `
      あなたはプロの翻訳アシスタントです。
      提供されたテキスト配列を、指定された言語コード "${toLang}" に翻訳してください。
      
      【重要ルール】
      - 必ず JSON 形式で返してください。
      - 結果は "translations" という名前のリストに入れてください。
      - 入力された行数と、出力する行数は必ず同じ数にしてください。
    `;

    // 4. OpenAI (GPT-5) に翻訳を依頼する
    const completion = await openai.chat.completions.create({
      model: "gpt-5", 
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify({ rows: rows }) },
      ],
      response_format: { type: "json_object" }, // 必ずJSONで返させる設定
    });

    // 5. AIからの返事を解析する
    const content = completion.choices[0].message.content;
    const parsedResult = JSON.parse(content);
    const translations = parsedResult.translations;

    // 数が合っているか最終チェック
    if (!translations || translations.length !== rows.length) {
      throw new Error('翻訳前と翻訳後の行数が一致しませんでした。');
    }

    // 6. 成功！翻訳結果を画面に返す
    return res.status(200).json({ translations });

  } catch (error) {
    // 何かエラーが起きたら、その内容を画面（開発者ツール）に返す
    console.error("API Error:", error);
    return res.status(500).json({
      error: 'Internal Server Error',
      detail: error.message
    });
  }
};
