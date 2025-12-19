const elPrompt = document.getElementById('prompt');
const elRun = document.getElementById('runBtn');
const elClear = document.getElementById('clearBtn');
const elOut = document.getElementById('output');
const elStatus = document.getElementById('status');

const reasoningBlock = document.getElementById('reasoningBlock');
const reasoningWarn = document.getElementById('reasoningWarn');

const dropZone = document.getElementById('dropZone');
const imgPicker = document.getElementById('imgPicker');
const thumbs = document.getElementById('thumbs');

let imageDataUrls = []; // data:image/...;base64,...

function setStatus(msg) { elStatus.textContent = msg || ''; }
function getChecked(name) {
  const el = document.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : null;
}

function setReasoningUIByModel() {
  const model = getChecked('model');
  const is51 = model === 'gpt-5.1';
  if (is51) {
    reasoningBlock.classList.add('disabled');
    reasoningWarn.style.display = '';
  } else {
    reasoningBlock.classList.remove('disabled');
    reasoningWarn.style.display = 'none';
  }
}

document.getElementById('modelGroup').addEventListener('change', setReasoningUIByModel);
setReasoningUIByModel();

function clearAll() {
  elPrompt.value = '';
  elOut.textContent = '';
  setStatus('');
  imageDataUrls = [];
  thumbs.innerHTML = '';
}
elClear.addEventListener('click', clearAll);

// Ctrl+Enterで実行
elPrompt.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    elRun.click();
  }
});

// ---- 画像取り込み ----
function renderThumbs() {
  thumbs.innerHTML = '';
  for (const url of imageDataUrls) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = url;
    thumbs.appendChild(img);
  }
}

async function filesToDataUrls(files) {
  const out = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const url = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(f);
    });
    out.push(url);
  }
  return out;
}

// D&D
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const files = Array.from(e.dataTransfer.files || []);
  const urls = await filesToDataUrls(files);
  imageDataUrls.push(...urls);
  renderThumbs();
});

// クリックでファイル選択
dropZone.addEventListener('click', () => imgPicker.click());
imgPicker.addEventListener('change', async () => {
  const files = Array.from(imgPicker.files || []);
  const urls = await filesToDataUrls(files);
  imageDataUrls.push(...urls);
  renderThumbs();
  imgPicker.value = '';
});

// ペースト（Ctrl+V）
document.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const files = items
    .filter(it => it.type && it.type.startsWith('image/'))
    .map(it => it.getAsFile())
    .filter(Boolean);

  if (files.length === 0) return;

  const urls = await filesToDataUrls(files);
  imageDataUrls.push(...urls);
  renderThumbs();
});

// ---- 実行（ストリーミング）----
elRun.addEventListener('click', async () => {
  const prompt = (elPrompt.value || '').trim();
  if (!prompt && imageDataUrls.length === 0) {
    setStatus('入力が空です（テキストか画像を入れてください）');
    return;
  }

  elRun.disabled = true;
  setStatus('実行中…');
  elOut.textContent = '';

  try {
    const model = getChecked('model');       // gpt-5.1 / gpt-5.2
    const verbosity = getChecked('verbosity');
    const reasoning = getChecked('reasoning'); // 5.1では送らない（API側で制御）

    const res = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model,
        reasoning,
        verbosity,
        images: imageDataUrls, // dataURL配列
      }),
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
