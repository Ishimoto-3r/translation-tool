module.exports = async (req, res) => {
  // CORS（必要なら既存と揃える）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const { prompt, model, reasoning, verbosity } = req.body || {};
    const text = (prompt || '').toString().trim();
    if (!text) return res.status(400).send('prompt is required');

    // allowlist
    const allowedModels = new Set(['gpt-5.1', 'gpt-5.2']);
    const useModel = allowedModels.has(model) ? model : 'gpt-5.1';

    const allowedVerbosity = new Set(['low', 'medium', 'high']);
    const useVerbosity = allowedVerbosity.has(verbosity) ? verbosity : 'medium';

    // reasoning effort（5.2のみ）
    const allowedEffort = new Set(['minimal', 'low', 'medium', 'high']);
    let effort = (reasoning || 'minimal').toString();
    if (!allowedEffort.has(effort)) effort = 'minimal';

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).send('OPENAI_API_KEY is not set');

    const body = {
      model: useModel,
      input: text,
      text: { verbosity: useVerbosity },
      stream: true,
    };

    // GPT-5.2 のみ reasoning を付与（5.1は付けない）
    if (useModel === 'gpt-5.2') {
      body.reasoning = { effort };
    }

    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      return res.status(upstream.status).send(errText || 'OpenAI API error');
    }

    // ここから：SSEを「回答テキストだけ」に変換してストリーミング返却
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');

    let buffer = '';
    let currentEvent = '';
    let currentData = '';

    const flushMessage = () => {
      const data = currentData.trim();
      currentEvent = '';
      currentData = '';
      if (!data) return;

      // OpenAIのstreamは JSON が data: に乗ってくる
      let obj;
      try {
        obj = JSON.parse(data);
      } catch {
        return; // JSON以外は無視
      }

      // 重要：deltaだけ出す
      if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') {
        res.write(obj.delta);
      }

      // done系が来てもここでは特に何もしない（最後は reader.done で終わる）
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSEは行単位。空行で1メッセージ終端
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);

        if (line === '') {
          // メッセージ終端
          flushMessage();
          continue;
        }

        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (line.startsWith('data:')) {
          // dataは複数行になることがあるので追記
          const chunk = line.slice(5).trimStart();
          currentData += (currentData ? '\n' : '') + chunk;
          continue;
        }
      }
    }

    // 残りがあれば最後に処理
    flushMessage();
    res.end();
  } catch (e) {
    res.status(500).send(e.message || 'Server error');
  }
};
