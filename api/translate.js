// api/translate.js

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { systemPrompt, userPrompt } = request.body;
    if (!systemPrompt || !userPrompt) {
      return response.status(400).json({ error: 'systemPrompt and userPrompt are required' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return response.status(500).json({ error: 'サーバー側でAPIキーが設定されていません。' });
    }

    // --- 根本治療：必ずJSONで「ja」を返させる ---
    // フロントが渡してくる systemPrompt には依存しすぎない（安全側に上書き）
    const hardSystem = `
あなたはプロの翻訳者です。
ユーザーの入力を必ず日本語に翻訳してください。
出力は必ずJSONのみ。形式は次の通り：
{ "ja": "ここに日本語訳" }

制約：
- 中国語/英語など原文のまま返すことは禁止。
- 余計な解説は禁止（JSON以外出力禁止）。
- 型番・数値・記号は可能な限り保持。
`.trim();

    async function callOnce(extraUserHint = "") {
      const apiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          // 既存運用に合わせる（MODEL_TRANSLATEがあるならそれを優先してもOK）
          model: process.env.MODEL_TRANSLATE || 'gpt-5.1',
          messages: [
            { role: "system", content: hardSystem },
            // フロントの systemPrompt は「参考」扱いで user に混ぜる（事故防止）
            { role: "user", content: `【追加条件】${systemPrompt}\n\n【原文】\n${userPrompt}\n\n${extraUserHint}` }
          ],
          response_format: { type: "json_object" },
          reasoning_effort: "low",
          verbosity: "low"
        })
      });

      const data = await apiResponse.json();
      if (!apiResponse.ok) {
        const errorMessage = data.error?.message || `OpenAI API error: ${apiResponse.status}`;
        throw new Error(errorMessage);
      }
      return data.choices?.[0]?.message?.content ?? "";
    }

    // 1回目
    let content = await callOnce("");

    // JSONパース＋検証
    const parseJa = (s) => {
      try {
        const obj = JSON.parse(s);
        const ja = (obj && typeof obj.ja === "string") ? obj.ja.trim() : "";
        return ja;
      } catch {
        return "";
      }
    };

    let ja = parseJa(content);

    // 根本治療の検証：日本語らしさ最低条件（かなが1文字も無い＝未翻訳疑い）
    const hasKana = (s) => /[\u3040-\u309F\u30A0-\u30FF]/.test(s || "");

    // 失敗時は最大1回だけ再試行（強制をさらに強く）
    if (!ja || !hasKana(ja)) {
      content = await callOnce("重要：出力は必ず自然な日本語。ひらがな/カタカナを含めてください。");
      ja = parseJa(content);
    }

    // それでもダメならエラーにして「成功扱い」を防ぐ（ここが根本）
    if (!ja || !hasKana(ja)) {
      return response.status(502).json({
        error: "TranslationFailed",
        detail: "日本語訳の生成に失敗しました（未翻訳の可能性）。"
      });
    }

    return response.status(200).json({ translatedText: ja });

  } catch (error) {
    return response.status(500).json({ error: 'サーバー内部でエラーが発生しました。', detail: String(error) });
  }
}
