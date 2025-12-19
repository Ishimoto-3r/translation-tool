// --- モデル判定 ---
const is51 = useModel === 'gpt-5.1';

// --- request body ---
const body = {
  model: useModel,
  input: text,
  text: { verbosity: useVerbosity }
};

// GPT-5.2 のときのみ reasoning を付与
if (!is51) {
  body.reasoning = { effort };
}

const resp = await fetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});
