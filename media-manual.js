const $ = (id)=>document.getElementById(id);
const btn = $("btn-generate");
const status = $("status-text");
const out = $("output");

btn.addEventListener("click", async ()=>{
  const fileInput = document.querySelector('#video-file');
  const notes = $("notes").value.trim();
  const granularity = $("granularity").value;

  if (!fileInput || !fileInput.files || fileInput.files.length !== 1) {
    status.textContent = "動画は1本のみ選択してください。";
    return;
  }
  const f = fileInput.files[0];
  if (f.duration && f.duration > 30) {
    status.textContent = "動画は30秒以内にしてください。";
    return;
  }

  status.textContent = "生成中…";
  out.textContent = "";

  const res = await fetch("/api/manual-ai", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      mode: "media-manual",
      notes,
      granularity,
      frames: 8
    })
  });

  const data = await res.json();
  if (!res.ok) {
    status.textContent = "生成に失敗しました。";
    return;
  }
  out.textContent = data.text || "";
  status.textContent = "原稿案を生成しました。";
});
