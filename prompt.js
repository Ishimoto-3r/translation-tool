const elPrompt = document.getElementById('prompt');
const elRun = document.getElementById('runBtn');
const elClear = document.getElementById('clearBtn');
const elOut = document.getElementById('output');
const elStatus = document.getElementById('status');
const thumbs = document.getElementById('thumbs');
const imgCount = document.getElementById('imgCount');
const dropZone = document.getElementById('dropZone');

let images = [];

const getChecked = name =>
  document.querySelector(`input[name="${name}"]:checked`)?.value;

const renderThumbs = () => {
  thumbs.innerHTML = '';
  imgCount.textContent = `画像：${images.length}枚`;
  images.forEach((src, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'thumbwrap';
    const img = document.createElement('img');
    img.src = src; img.className = 'thumb';
    const x = document.createElement('button');
    x.className = 'thumbx'; x.textContent = '×';
    x.onclick = () => { images.splice(i,1); renderThumbs(); };
    wrap.append(img,x); thumbs.appendChild(wrap);
  });
};

const filesToData = async files => {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const r = new FileReader();
    r.onload = () => { images.push(r.result); renderThumbs(); };
    r.readAsDataURL(f);
  }
};

dropZone.addEventListener('dragover', e => e.preventDefault());
dropZone.addEventListener('drop', e => {
  e.preventDefault(); filesToData(e.dataTransfer.files);
});
document.addEventListener('paste', e => {
  const files=[...e.clipboardData.items].map(i=>i.getAsFile()).filter(f=>f);
  filesToData(files);
});

elPrompt.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key === 'Enter') elRun.click();
});

elClear.onclick = () => {
  elPrompt.value=''; elOut.textContent=''; elStatus.textContent='';
  images=[]; renderThumbs();
};

elRun.onclick = async () => {
  elOut.textContent=''; elStatus.textContent='実行中…';
  const res = await fetch('/api/prompt',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      prompt: elPrompt.value,
      model: getChecked('model'),
      verbosity: getChecked('verbosity'),
      images
    })
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while(true){
    const {value,done}=await reader.read();
    if(done)break;
    elOut.textContent+=dec.decode(value);
  }
  elStatus.textContent='完了';
};
