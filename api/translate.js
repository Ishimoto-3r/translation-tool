// Vercelのバックエンド (Node.js) として動作します

export default async function handler(request, response) {
  // 1. POSTリクエスト以外は拒否
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 2. フロントエンドから送られてきたプロンプトを取得
    const { systemPrompt, userPrompt } = request.body;

    if (!systemPrompt || !userPrompt) {
      return response.status(400).json({ error: 'systemPrompt and userPrompt are required' });
    }

    // 3. Vercelの環境変数から、安全にAPIキーを取得
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("OPENAI_API_KEY is not set in Vercel environment variables.");
      return response.status(500).json({ error: 'サーバー側でAPIキーが設定されていません。' });
    }

    // 4. このバックエンドから、OpenAIのAPIを叩く
    const apiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}` // ⬅️ 安全なキーを使用
      },
      body: JSON.stringify({
        model: 'gpt-5', // ご指定のモデル
        messages: [
          { "role": "system", "content": systemPrompt },
          { "role": "user", "content": userPrompt }
        ]
      })
    });

    const data = await apiResponse.json();

    // 5. OpenAI APIからのエラーハンドリング
    if (!apiResponse.ok) {
      console.error("OpenAI API Error:", data);
      // OpenAIからのエラーメッセージをそのままフロントに伝える
      const errorMessage = data.error?.message || `OpenAI API error: ${apiResponse.status}`;
      
      if (apiResponse.status === 401) {
          return response.status(401).json({ error: 'APIキーが認証されませんでした。(サーバー側)' });
      }
      if (apiResponse.status === 404) {
          return response.status(404).json({ error: 'モデル(gpt-5)が見つかりません。(サーバー側)' });
      }
      
      return response.status(apiResponse.status).json({ error: errorMessage });
    }

    // 6. 成功した結果をフロントエンドに返す
    const translatedText = data.choices[0].message.content.trim();
    response.status(200).json({ translatedText: translatedText });

  } catch (error) {
    console.error("Internal Server Error:", error);
    response.status(500).json({ error: 'サーバー内部でエラーが発生しました。' });
  }
}