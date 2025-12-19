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

    // reasoning effort（5.2のみ使う）
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

    // GPT-5.2 のみ reasoning を付与（5.1は付けない＝エラー回避）
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

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value));
    }
    res.end();
  } catch (e) {
    res.status(500).send(e.message || 'Server error');
  }
};
