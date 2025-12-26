(() => {
  const fileInput = document.getElementById("fileInput");
  const clearBtn = document.getElementById("clearBtn");
  const runBtn = document.getElementById("runBtn");
  const statusEl = document.getElementById("status");
  const previewEl = document.getElementById("preview");
  const outputEl = document.getElementById("output");
  const copyBtn = document.getElementById("copyBtn");
  const categoryEl = document.getElementById("category");
  const userTypeEl = document.getElementById("userType");
  const notesEl = document.getElementById("notes");

  // コスト/速度対策
  const MAX_IMAGES_TOTAL = 10;
  const VIDEO_FRAME_STEP_SEC = 2;
  const VIDEO_MAX_FRAMES = 8;
  const JPEG_QUALITY = 0.82;
  const MAX_SIDE = 1280;

  let preparedImages = []; // { dataUrl, name }

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function resetAll() {
    fileInput.value = "";
    preparedImages = [];
    previewEl.innerHTML = "";
    outputEl.value = "";
    setStatus("");
  }

  function addThumb(dataUrl, label) {
    const d = document.createElement("div");
    d.className = "thumb";
    if (dataUrl) {
      const img = document.createElement("img");
      img.src = dataUrl;
      d.appendChild(img);
    } else {
      const s = document.createElement("span");
      s.textContent = label || "";
      d.appendChild(s);
    }
    previewEl.appendChild(d);
  }

  async function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function resizeToJpegDataUrl(img) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, cw, ch);
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }

  async function extractVideoFrames(file) {
    // 動画を代表フレームにして image として送る（動画APIに依存しない最小構成）
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;

    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
    });

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const frames = [];
    if (!duration) {
      URL.revokeObjectURL(url);
      return frames;
    }

    const canvas = document.createElement("canvas");
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    const scale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext("2d");

    const totalWanted = Math.min(
      VIDEO_MAX_FRAMES,
      Math.max(1, Math.floor(duration / VIDEO_FRAME_STEP_SEC))
    );
    const step = duration / totalWanted;

    for (let i = 0; i < totalWanted; i++) {
      const t = Math.min(duration - 0.05, i * step);
      await new Promise((resolve) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = t;
      });

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    }

    URL.revokeObjectURL(url);
    return frames;
  }

  async function prepareFromFiles(files) {
    preparedImages = [];
    previewEl.innerHTML = "";

    const list = Array.from(files || []);
    if (!list.length) {
      setStatus("ファイルを選択してください");
      return;
    }

    setStatus("ファイルを準備中…");

    for (const f of list) {
      if (preparedImages.length >= MAX_IMAGES_TOTAL) break;

      if (f.type.startsWith("image/")) {
        const dataUrl = await readFileAsDataURL(f);
        const img = await loadImage(dataUrl);
        const jpeg = resizeToJpegDataUrl(img);
        preparedImages.push({ dataUrl: jpeg, name: f.name });
      } else if (f.type.startsWith("video/")) {
        const frames = await extractVideoFrames(f);
        for (let i = 0; i < frames.length; i++) {
          if (preparedImages.length >= MAX_IMAGES_TOTAL) break;
          preparedImages.push({ dataUrl: frames[i], name: `${f.name}#frame${i + 1}` });
        }
      }
    }

    previewEl.innerHTML = "";
    for (const it of preparedImages) addThumb(it.dataUrl, it.name);

    setStatus(`準備完了：${preparedImages.length}枚 送信`);
  }

  async function run() {
    outputEl.value = "";

    if (!preparedImages.length) {
      setStatus("先にファイルを選択してください");
      return;
    }

    runBtn.disabled = true;
    clearBtn.disabled = true;
    fileInput.disabled = true;

    try {
      setStatus("AI解析中…");

      // ★ 統合先の /api/manual-ai を叩く（Vercel Hobby の関数数制限回避）
      const payload = {
        mode: "media-manual",
        category: categoryEl.value || "",
        userType: userTypeEl.value || "",
        notes: notesEl.value || "",
        images: preparedImages.map((x) => ({ name: x.name, dataUrl: x.dataUrl })),
      };

      const res = await fetch("/api/manual-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`API error: ${res.status} ${t}`);
      }

      const data = await res.json();
      // manual-ai 既存は {text} を返すのでそれに合わせる
      outputEl.value = data?.text || "";
      setStatus("完了");
    } catch (e) {
      console.error(e);
      setStatus(`失敗：${e?.message || e}`);
    } finally {
      runBtn.disabled = false;
      clearBtn.disabled = false;
      fileInput.disabled = false;
    }
  }

  fileInput.addEventListener("change", (ev) => {
    prepareFromFiles(ev.target.files).catch((err) => {
      console.error(err);
      setStatus("ファイルの準備に失敗しました");
    });
  });

  clearBtn.addEventListener("click", resetAll);
  runBtn.addEventListener("click", run);

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(outputEl.value || "");
      setStatus("コピーしました");
      setTimeout(() => setStatus(""), 1200);
    } catch {
      setStatus("コピーに失敗しました");
    }
  });
})();
