module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { prompt, model, reasoning, verbosity } = req.body;
  const apiKey = process.env.OPENAI_API_KEY;

  const is51 = model === 'gpt-5.1';

  const body = {
    model,
    input: prompt,
    text: { verbosity },
    stream: true
  };

  // GPT-5.2 のみ reasoning を送る
  if (!is51) {
    body.reasoning = { effort: reasoning };
  }

  const r = await fetch('https://api.openai.com/v1/responses', {
    method:'POST',
    headers:{
      'Authorization':`Bearer ${apiKey}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body)
  });

  res.writeHead(200,{
    'Content-Type':'text/plain; charset=utf-8',
    'Transfer-Encoding':'chunked'
  });

  const reader = r.body.getReader();
  const decoder = new TextDecoder();

  while(true){
    const {value,done} = await reader.read();
    if(done) break;
    res.write(decoder.decode(value));
  }

  res.end();
};
