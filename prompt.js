const elPrompt = document.getElementById('prompt');
const elModel = document.getElementById('model');
const elReasoning = document.getElementById('reasoning');
const elVerbosity = document.getElementById('verbosity');
const elRun = document.getElementById('runBtn');
const elClear = document.getElementById('clearBtn');
const elOut = document.getElementById('output');
const elStatus = document.getElementById('status');

function setStatus(msg) {
  elStatus.textContent = msg || '';
}

function clearAll() {
  elPrompt.value = '';
  elOut.textContent = '';
  setStatus('');
}

elClear.addEventListener('click', clearAll);

elRun.addEventListener('click', async () => {
  const prompt = (elPrompt.value || '').trim();
  if (!prompt) {
    setStatus('入力が空です');
    return;
  }

  elRun.disabled = true;
  setStatus('実行中…');
  elOut.textContent = '';

  try {
    const payload = {
      prompt,
      model: elModel.value,
      reasoning: elReasoning.value,
      verbosity: elVerbosity.value,
    };

    const res = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    elOut.textContent = data.output || '';
    setStatus('完了');
  } catch (e) {
    elOut.textContent = '';
    setStatus(`エラー：${e.message}`);
  } finally {
    elRun.disabled = false;
  }
});
