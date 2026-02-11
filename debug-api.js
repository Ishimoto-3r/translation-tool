
const handler = require('./api/translate');

console.log('--- START DEBUG ---');
console.log('Key length:', process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.length : 0);

const req = {
    method: 'POST',
    query: { op: 'text' },
    body: {
        userPrompt: 'Test',
        sourceLang: 'en',
        targetLang: 'ja'
    }
};

const res = {
    status: (code) => ({
        json: (data) => console.log(`[RES] Status ${code}:`, JSON.stringify(data, null, 2)),
        end: () => console.log(`[RES] Status ${code} (End)`),
        send: (data) => console.log(`[RES] Status ${code}:`, data)
    }),
    setHeader: (key, val) => console.log(`[RES] Header: ${key}=${val}`)
};

handler(req, res).catch(err => console.error('[FATAL]', err));
