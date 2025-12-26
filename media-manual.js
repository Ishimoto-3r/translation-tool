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
  const dropZone = document.getElementById("dropZone");

  // 送信上限（コスト/速度）
  const MAX_IMAGES_TOTAL = 20; // ★最大20枚（方針確定）

  // 画質・サイズ
  const JPEG_QUALITY = 0.82;
  const MAX_SIDE = 1280;

  // 差分抽出（方針確定：補間なし）
  const VIDEO_SCAN_FPS = 3;       // 判定用の走査fps（軽量化）
  const VIDEO_MIN_GAP_SEC = 0.8;  // 連写防止
  const DIFF_DOWNSCALE_W = 64;
  const DIFF_DOWNSCALE_H = 36;
  const DIFF_THRESHOLD = 18;      // 多すぎる→上げる / 少なすぎる→下げる

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

  function setDropActive(on) {
    if (!dropZone) return;
    dropZone.style.background = on ? "#f2f4f7" : "#fafbfc";
    dropZone.style.borderColor = on ? "#111" : "#cfd4dc";
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
    // 差分ベース抽出：変化の大きい瞬間だけ採用
    // - 最初と最後は必ず採用
    // - 最大MAX_IMAGES_TOTAL（補間なし）
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
    if (!duration) {
      URL.revokeObjectURL(url);
      return [];
    }

    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;

    // 保存用（送信用）canvas
    const saveCanvas = document.createElement("canvas");
    const saveScale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    saveCanvas.width = Math.round(vw * saveScale);
    saveCanvas.height = Math.round(vh * saveScale);
    const saveCtx = saveCanvas.getContext("2d");

    // 判定用canvas（小さく）
    const diffCanvas = document.createElement("canvas");
    diffCanvas.width = DIFF_DOWNSCALE_W;
    diffCanvas.height = DIFF_DOWNSCALE_H;
    const diffCtx = diffCanvas.getContext("2d", { willReadFrequently: true });

    const frames = [];
    let prev = null;
    let lastAcceptedT = -999;

    function captureJpeg() {
      saveCtx.drawImage(video, 0, 0, saveCanvas.width, saveCanvas.height);
      return saveCanvas.toDataURL("image/jpeg", JPEG_QUALITY);
    }

    async function seekTo(t) {
      t = Math.max(0, Math.min(duration - 0.05, t));
      await new Promise((resolve) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = t;
      });
      return t;
    }

    function diffScore() {
      diffCtx.drawImage(video, 0, 0, diffCanvas.width, diffCanvas.height);
      const img = diffCtx.getImageData(0, 0, diffCanvas.width, diffCanvas.height);
      const data = img.data;

      if (!prev) {
        prev = data.slice();
        return 0;
      }

      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += Math.abs(data[i] - prev[i]);
        sum += Math.abs(data[i + 1] - prev[i + 1]);
        sum += Math.abs(data[i + 2] - prev[i + 2]);
      }
      prev = data.slice();

      const denom = (diffCanvas.width * diffCanvas.height) * 3;
      return sum / denom; // 0〜255目安
    }

    // 最初は必ず採用
    await seekTo(0);
    frames.push(captureJpeg());
    lastAcceptedT = 0;

    // 走査
    const step = 1 / Math.max(1, VIDEO_SCAN_FPS);
    for (let t = step; t < duration; t += step) {
      if (frames.length >= MAX_IMAGES_TOTAL - 1) break; // 最後枠確保
      const tt = await seekTo(t);

      const score = diffScore();
      const gapOk = (tt - lastAcceptedT) >= VIDEO_MIN_GAP_SEC;

      if (gapOk && score >= DIFF_THRESHOLD) {
        frames.push(captureJpeg());
        lastAcceptedT = tt;
      }
    }

    // 最後は必ず採用（枠が残っている場合のみ）
    if (frames.length < MAX_IMAGES_TOTAL) {
      const endT = Math.max(0, duration - 0.2);
      await seekTo(endT);
      frames.push(captureJpeg());
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

    for (let idx = 0; idx < list.length; idx++) {
      if (preparedImages.length >= MAX_IMAGES_TOTAL) break;

      const f = list[idx];

      if (f.type && f.type.startsWith("image/")) {
        const dataUrl = await readFileAsDataURL(f);
        const img = await loadImage(dataUrl);
        const jpeg = resizeToJpegDataUrl(img);
        preparedImages.push({ dataUrl: jpeg, name: f.name });
      } else if (f.type && f.type.startsWith("video/")) {
        // 動画は差分抽出でフレーム化
        const frames = await extractVideoFrames(f);
        for (let i = 0; i < frames.length; i++) {
          if (preparedImages.length >= MAX_IMAGES_TOTAL) break;
          preparedImages.push({ dataUrl: frames[i], name: `${f.name}#frame${i + 1}` });
        }
      }
    }

    previewEl.innerHTML = "";
    for (let i = 0; i < preparedImages.length; i++) {
      addThumb(preparedImages[i].dataUrl, preparedImages[i].name);
    }

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
      outputEl.value = data && data.text ? data.text : "";
      setStatus("完了");
    } catch (e) {
      console.error(e);
      setStatus(`失敗：${e && e.message ? e.message : e}`);
    } finally {
      runBtn.disabled = false;
      clearBtn.disabled = false;
      fileInput.disabled = false;
    }
  }

  // イベント
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

  // D&D
  if (dropZone) {
    ["dragenter", "dragover"].forEach((evName) => {
      dropZone.addEventListener(evName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDropActive(true);
      });
    });

    ["dragleave", "drop"].forEach((evName) => {
      dropZone.addEventListener(evName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDropActive(false);
      });
    });

    dropZone.addEventListener("drop", async (e) => {
      const dt = e.dataTransfer;
      const files = dt ? dt.files : null;
      if (!files || !files.length) return;
      await prepareFromFiles(files);
    });
  }
})();
