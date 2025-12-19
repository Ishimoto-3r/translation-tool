const elPrompt = document.getElementById('prompt');
const elRun = document.getElementById('runBtn');
const elClear = document.getElementById('clearBtn');
const elOut = document.getElementById('output');
const elStatus = document.getElementById('status');

const reasoningBlock = document.getElementById('reasoningBlock');
const reasoningWarn = document.getElementById('reasoningWarn');

function setStatus(msg) {
  elStatus.textContent = msg || '';
}

function getChecked(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}

function setReasoningUIByModel() {
  const model = getChecked('model'); // gpt-5.1 / gpt-5.2
  const is51 = model === 'gpt-5.1';

  if (is51) {
    // reasoning は UI上選択不可にする
    reasoningBlock.classList.add('disabled');
    reasoningWarn.style.display = '';
  } else {
    reasoningBlock.classList.remove('disabled');
    reasoningWarn.style.display = 'none';
  }
}

function clearAll() {
  elPrompt.value = '';
  elOut.textContent = '';
  setStatus('');
}

document.getElementById('modelGroup').addEventListener('change', setReasoningUIByModel);
elClear.addEventListener('click', clearAll);

setReasoningUIByModel();

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
    const model = getChecked('model');
    const verbosity = getChecked('verbosity');
    const reasoning = getChecked('reasoning'); // 5.1のときはUI無効だが値は取れる（送らないのはAPI側で制御）

    const res = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model, reasoning, verbosity }),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(t || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      elOut.textContent += decoder.decode(value);
      elOut.scrollTop = elOut.scrollHeight;
    }

    setStatus('完了');
  } catch (e) {
    elOut.textContent = '';
    setStatus(`エラー：${e.message}`);
  } finally {
    elRun.disabled = false;
  }
});
