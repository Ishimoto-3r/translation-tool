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
const imgCount = document.getElementById('imgCount');

let imageDataUrls = [];

function setStatus(msg){ elStatus.textContent = msg || ''; }
function getChecked(name){
  return document.querySelector(`input[name="${name}"]:checked`)?.value || null;
}

function setReasoningUIByModel(){
  const model = getChecked('model');
  const is51 = model === 'gpt-5.1';
  if(is51){
    reasoningBlock.classList.add('disabled');
    reasoningWarn.style.display = '';
  }else{
    reasoningBlock.classList.remove('disabled');
    reasoningWarn.style.display = 'none';
  }
}

document.getElementById('modelGroup').addEventListener('change', setReasoningUIByModel);
setReasoningUIByModel();

function renderThumbs(){
  thumbs.innerHTML = '';
  imgCount.textContent = `画像：${imageDataUrls.length}枚`;

  imageDataUrls.forEach((url, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'thumbwrap';

    const img = document.createElement('img');
    img.className = 'thumb';
    img.src = url;

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'thumbx';
    x.textContent = '×';
    x.title = 'この画像を削除';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      imageDataUrls.splice(idx, 1);
      renderThumbs();
    });

    wrap.appendChild(img);
    wrap.appendChild(x);
    thumbs.appendChild(wrap);
  });
}

async function filesToDataUrls(files){
  const out = [];
  for(const f of files){
    if(!f.type.startsWith('image/')) continue;
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

/* Ctrl+Enter で実行 */
elPrompt.addEventListener('keydown', (e) => {
  if(e.ctrlKey && e.key === 'Enter'){
    e.preventDefault();
    elRun.click();
  }
});

/* クリア */
elClear.addEventListener('click', () => {
  elPrompt.value = '';
  elOut.textContent = '';
  setStatus('');
  imageDataUrls = [];
  renderThumbs();
});

/* 画像：D&D */
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

/* 画像：クリックで選択 */
dropZone.addEventListener('click', () => imgPicker.click());
imgPicker.addEventListener('change', async () => {
  const files = Array.from(imgPicker.files || []);
  const urls = await filesToDataUrls(files);
  imageDataUrls.push(...urls);
  renderThumbs();
  imgPicker.value = '';
});

/* 画像：貼り付け */
document.addEventListener('paste', async (e) => {
  const items = Array.from(e.clipboardData?.items || []);
  const files = items
    .filter(it => it.type && it.type.startsWith('image/'))
    .map(it => it.getAsFile())
    .filter(Boolean);

  if(files.length === 0) return;
  const urls = await filesToDataUrls(files);
  imageDataUrls.push(...urls);
  renderThumbs();
});

/* 実行（ストリーミング） */
elRun.addEventListener('click', async () => {
  const prompt = (elPrompt.value || '').trim();
  if(!prompt && imageDataUrls.length === 0){
    setStatus('入力が空です（テキストか画像を入れてください）');
    return;
  }

  elRun.disabled = true;
  setStatus('実行中…');
  elOut.textContent = '';

  try{
    const model = getChecked('model');
    const verbosity = getChecked('verbosity');
    const reasoning = getChecked('reasoning'); // 5.1はAPI側で無視

    const res = await fetch('/api/prompt', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ prompt, model, verbosity, reasoning, images: imageDataUrls })
    });

    if(!res.ok){
      const t = await res.text().catch(() => '');
      throw new Error(t || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    while(true){
      const {value, done} = await reader.read();
      if(done) break;
      elOut.textContent += decoder.decode(value);
      elOut.scrollTop = elOut.scrollHeight;
    }
    setStatus('完了');
  }catch(e){
    elOut.textContent = '';
    setStatus(`エラー：${e.message}`);
  }finally{
    elRun.disabled = false;
  }
});

/* 初期描画 */
renderThumbs();
