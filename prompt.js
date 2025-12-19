const runBtn = document.getElementById('run');
const clearBtn = document.getElementById('clear');
const output = document.getElementById('output');
const status = document.getElementById('status');

runBtn.onclick = async () => {
  output.textContent = '';
  status.textContent = '実行中…';

  const res = await fetch('/api/prompt', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      prompt: document.getElementById('prompt').value,
      model: document.getElementById('model').value,
      reasoning: document.getElementById('reasoning').value,
      verbosity: document.getElementById('verbosity').value
    })
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while(true){
    const {value,done} = await reader.read();
    if(done) break;
    output.textContent += decoder.decode(value);
  }

  status.textContent = '完了';
};

clearBtn.onclick = () => {
  document.getElementById('prompt').value = '';
  output.textContent = '';
  status.textContent = '';
};
