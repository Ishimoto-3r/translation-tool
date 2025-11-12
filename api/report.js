// api/report.js

export default async function handler(request, response) {
  // 1. POSTリクエスト以外は拒否
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 2. フロントエンド(report.js)から送られてきたプロンプトを取得
    const { finalPrompt } = request.body;

    if (!finalPrompt) {
      return response.status(400).json({ error: 'finalPrompt is required' });
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
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-5',
        messages: [
          { "role": "user", "content": finalPrompt }
        ],
        // --- ★★★ 修正 (ドット→アンダースコア) ★★★ ---
        "temperature": 0.3,
        "reasoning_effort": "low", // ⬅️ ここを修正しました
        "verbosity": "low"
        // --- ★★★ ここまで ★★★ ---
      })
    });

    const data = await apiResponse.json();

    // 5. OpenAI APIからのエラーハンドリング
    if (!apiResponse.ok) {
      console.error("OpenAI API Error:", data);
      const errorMessage = data.error?.message || `OpenAI API error: ${apiResponse.status}`;
      return response.status(apiResponse.status).json({ error: errorMessage });
    }
    
    // 6. 成功した結果をフロントエンドに返す
    const gptResponse = data.choices[0].message.content.trim();
    response.status(200).json({ gptResponse: gptResponse });

  } catch (error) {
    console.error("Internal Server Error:", error);
    response.status(500).json({ error: 'サーバー内部でエラーが発生しました。' });
  }
}
