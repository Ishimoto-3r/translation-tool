module.exports = async (req, res) => {
  // CORS（既存と揃えたい場合は既存の設定をコピペでOK）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { prompt, model, reasoning, verbosity } = req.body || {};

    const text = (prompt || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'prompt is required' });

    // モデルは許可リスト方式（事故防止）
    const allowedModels = new Set(['gpt-5.2', 'gpt-5.1']);
    const useModel = allowedModels.has(model) ? model : 'gpt-5.2';

    // reasoning：UIの none は minimal に寄せる（API互換性優先）
    const allowedEffort = new Set(['minimal', 'low', 'medium', 'high']);
    let effort = (reasoning || 'minimal').toString();
    if (effort === 'none') effort = 'minimal';
    if (!allowedEffort.has(effort)) effort = 'minimal';

    // verbosity
    const allowedVerbosity = new Set(['low', 'medium', 'high']);
    const useVerbosity = allowedVerbosity.has(verbosity) ? verbosity : 'medium';

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY is not set' });

    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: useModel,
        input: text,
        reasoning: { effort },          // reasoning.effort citeturn1view1
        text: { verbosity: useVerbosity } // text.verbosity citeturn1view0
      }),
    });

    const json = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({
        error: json?.error?.message || 'OpenAI API error',
      });
    }

    // Responses API の出力テキストは output_text が使える（無い場合の保険あり）
    const output =
      json.output_text ||
      (Array.isArray(json.output)
        ? json.output
            .flatMap((item) => item?.content || [])
            .map((c) => c?.text || '')
            .join('')
        : '');

    return res.status(200).json({ output });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Server error' });
  }
};
