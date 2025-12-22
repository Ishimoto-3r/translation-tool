module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const { prompt, model, reasoning, verbosity, images } = req.body || {};
    const text = (prompt || '').toString().trim();

    const allowedModels = new Set(['gpt-5.1', 'gpt-5.2']);
    const useModel = allowedModels.has(model) ? model : 'gpt-5.1';

    const allowedVerbosity = new Set(['low', 'medium', 'high']);
    const useVerbosity = allowedVerbosity.has(verbosity) ? verbosity : 'low';

    const allowedEffort52 = new Set(['none', 'low', 'medium', 'high', 'xhigh']);
    let effort = (reasoning || 'none').toString();
    if (!allowedEffort52.has(effort)) effort = 'none';

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).send('OPENAI_API_KEY is not set');

    const imgUrls = Array.isArray(images)
      ? images.filter(s => typeof s === 'string' && s.startsWith('data:image/'))
      : [];

    if (!text && imgUrls.length === 0) return res.status(400).send('prompt or images is required');

    const content = [];
    if (text) content.push({ type: 'input_text', text });
    for (const url of imgUrls) content.push({ type: 'input_image', image_url: url });

const body = {
  model: useModel,
  input: [
    {
      role: 'system',
      content: '出力はMarkdown記号（#、*、-、** など）を使わず、プレーンテキストのみで記述してください。'
    },
    {
      role: 'user',
      content
    }
  ],
  text: { verbosity: useVerbosity },
  stream: true,
};


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

    let buffer = '';
    let currentData = '';

    const flushMessage = () => {
      const data = currentData.trim();
      currentData = '';
      if (!data) return;

      let obj;
      try { obj = JSON.parse(data); } catch { return; }

      if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') {
        res.write(obj.delta);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);

        if (line === '') {
          flushMessage();
          continue;
        }
        if (line.startsWith('data:')) {
          const chunk = line.slice(5).trimStart();
          currentData += (currentData ? '\n' : '') + chunk;
        }
      }
    }

    flushMessage();
    res.end();
  } catch (e) {
    res.status(500).send(e.message || 'Server error');
  }
};
