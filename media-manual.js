(() => {
  const fileInput = document.getElementById("fileInput");
  const clearBtn = document.getElementById("clearBtn");
  const runBtn = document.getElementById("runBtn");
  const statusEl = document.getElementById("status");
  const previewEl = document.getElementById("preview");
  const outputEl = document.getElementById("output");
  const copyBtn = document.getElementById("copyBtn");
  const notesEl = document.getElementById("notes");
  const granularityEl = document.getElementById("granularity");
  const dropZone = document.getElementById("dropZone");
  const selectedInfo = document.getElementById("selectedInfo");

  // ===== 制約 =====
  const MAX_VIDEO_MB = 200;
  const MAX_VIDEO_SECONDS = 30;

  // 送信上限（コスト/速度）
  const MAX_IMAGES_TOTAL = 20; // 最大20枚

  // 画質・サイズ
  const JPEG_QUALITY = 0.82;
  const MAX_SIDE = 1280;

  // 差分抽出（補間なし）
  const VIDEO_SCAN_FPS = 3;
  const VIDEO_MIN_GAP_SEC = 0.8;
  const DIFF_DOWNSCALE_W = 64;
  const DIFF_DOWNSCALE_H = 36;
  const DIFF_THRESHOLD = 18;

  let preparedImages = []; // { dataUrl, name }
  let selectedVideo = null;

  // ===== Overlay（経過秒 + 工程ログ） =====
  let overlayTick = null;
  let overlayStartedAt = null;
  const stepLines = [];
  function showOverlay(title, msg) {
    const overlay = document.getElementById("overlay");
    const t = document.getElementById("overlay-title");
    const m = document.getElementById("overlay-msg");
    const log = document.getElementById("overlay-log");

    if (t) t.textContent = title || "処理中…";
    const baseMsg = msg || "しばらくお待ちください";
    overlayStartedAt = Date.now();
    stepLines.length = 0;
    if (log) log.textContent = "";

    if (overlayTick) clearInterval(overlayTick);
    overlayTick = setInterval(() => {
      const sec = Math.floor((Date.now() - overlayStartedAt) / 1000);
      if (m) m.textContent = `${baseMsg}（${sec}s）`;
    }, 500);
    if (m) m.textContent = `${baseMsg}（0s）`;

    if (overlay) {
      overlay.classList.remove("hidden");
      overlay.classList.add("flex");
    }
  }
  function logStep(line) {
    stepLines.push(`- ${line}`);
    const log = document.getElementById("overlay-log");
    if (log) log.textContent = stepLines.join("\n");
  }
  function hideOverlay() {
    const overlay = document.getElementById("overlay");
    if (overlay) {
      overlay.classList.add("hidden");
      overlay.classList.remove("flex");
    }
    if (overlayTick) {
      clearInterval(overlayTick);
      overlayTick = null;
    }
    overlayStartedAt = null;
  }

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function setDropActive(on) {
    if (!dropZone) return;
    dropZone.style.background = on ? "#f2f4f7" : "rgba(248,250,252,.6)";
    dropZone.style.borderColor = on ? "#111" : "#94a3b8";
  }

  function resetAll() {
    fileInput.value = "";
    selectedVideo = null;
    preparedImages = [];
    previewEl.innerHTML = "";
    outputEl.value = "";
    selectedInfo.textContent = "";
    setStatus("");
  }

  function addThumb(dataUrl) {
    const d = document.createElement("div");
    d.className = "thumb";
    const img = document.createElement("img");
    img.src = dataUrl;
    d.appendChild(img);
    previewEl.appendChild(d);
  }

  function formatMB(bytes) {
    return Math.round(bytes / 1024 / 1024);
  }

  async function validateVideoFile(file) {
    if (!file) throw new Error("NoFile");
    if (!(file.type || "").startsWith("video/")) throw new Error("VideoOnly");
    if (formatMB(file.size) > MAX_VIDEO_MB) throw new Error("TooLarge");

    // duration check via metadata
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    const duration = await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve(Number(video.duration));
      video.onerror = () => reject(new Error("DurationReadFailed"));
    }).finally(() => {
      URL.revokeObjectURL(url);
    });

    if (!Number.isFinite(duration)) throw new Error("DurationUnknown");
    if (duration > MAX_VIDEO_SECONDS + 0.01) throw new Error("TooLong");

    return duration;
  }

  async function extractVideoFrames(file) {
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

    const saveCanvas = document.createElement("canvas");
    const saveScale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
    saveCanvas.width = Math.round(vw * saveScale);
    saveCanvas.height = Math.round(vh * saveScale);
    const saveCtx = saveCanvas.getContext("2d");

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
      return sum / denom;
    }

    // first
    await seekTo(0);
    frames.push(captureJpeg());
    lastAcceptedT = 0;

    const step = 1 / Math.max(1, VIDEO_SCAN_FPS);
    for (let t = step; t < duration; t += step) {
      if (frames.length >= MAX_IMAGES_TOTAL - 1) break;
      const tt = await seekTo(t);

      const score = diffScore();
      const gapOk = (tt - lastAcceptedT) >= VIDEO_MIN_GAP_SEC;

      if (gapOk && score >= DIFF_THRESHOLD) {
        frames.push(captureJpeg());
        lastAcceptedT = tt;
      }
    }

    // last
    if (frames.length < MAX_IMAGES_TOTAL) {
      const endT = Math.max(0, duration - 0.2);
      await seekTo(endT);
      frames.push(captureJpeg());
    }

    URL.revokeObjectURL(url);
    return frames;
  }

  async function prepareFromVideo(file) {
    preparedImages = [];
    previewEl.innerHTML = "";
    outputEl.value = "";

    setStatus("動画を準備中…");
    showOverlay("準備中…", "動画を解析中");
    logStep("動画の秒数/容量チェック");

    const dur = await validateVideoFile(file);
    logStep(`OK（${dur.toFixed(1)}秒 / ${formatMB(file.size)}MB）`);
    selectedInfo.textContent = `選択中：${file.name}（${formatMB(file.size)}MB / ${dur.toFixed(1)}秒）`;

    logStep("フレーム抽出（差分ベース）");
    const frames = await extractVideoFrames(file);

    for (let i = 0; i < frames.length; i++) {
      preparedImages.push({ dataUrl: frames[i], name: `${file.name}#frame${i + 1}` });
    }

    previewEl.innerHTML = "";
    for (let i = 0; i < preparedImages.length; i++) addThumb(preparedImages[i].dataUrl);

    setStatus(`準備完了：${preparedImages.length}枚 送信`);
    hideOverlay();
  }

  async function handleFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;

    if (list.length !== 1) {
      resetAll();
      setStatus("動画は1本のみ受け付けます。");
      return;
    }

    const f = list[0];
    if ((f.type || "").startsWith("image/")) {
      resetAll();
      setStatus("画像は受け付けません。動画ファイルを選択してください。");
      return;
    }

    if (!(f.type || "").startsWith("video/")) {
      resetAll();
      setStatus("動画ファイルを選択してください。");
      return;
    }

    if (Math.round(f.size / 1024 / 1024) > MAX_VIDEO_MB) {
      resetAll();
      setStatus(`動画サイズが大きすぎます（最大${MAX_VIDEO_MB}MB）。`);
      return;
    }

    selectedVideo = f;
    await prepareFromVideo(f).catch((err) => {
      console.error(err);
      resetAll();
      setStatus("動画の準備に失敗しました（30秒以内の動画を選択してください）。");
      hideOverlay();
    });
  }

  async function run() {
    outputEl.value = "";

    if (!preparedImages.length) {
      setStatus("先に動画を選択してください");
      return;
    }

    runBtn.disabled = true;
    clearBtn.disabled = true;
    fileInput.disabled = true;

    try {
      showOverlay("生成中…", "AIが原稿を作成中");
      logStep("API送信（フレーム）");

      const payload = {
        mode: "media-manual",
        notes: (notesEl.value || ""),
        granularity: (granularityEl.value || "standard"),
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

      logStep("出力受信");
      const data = await res.json();
      outputEl.value = data && data.text ? data.text : "";
      setStatus("完了");
    } catch (e) {
      console.error(e);
      setStatus(`失敗：${e && e.message ? e.message : e}`);
    } finally {
      hideOverlay();
      runBtn.disabled = false;
      clearBtn.disabled = false;
      fileInput.disabled = false;
    }
  }

  // ===== events =====
  dropZone.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", (ev) => {
    handleFiles(ev.target.files);
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
    await handleFiles(files);
  });
})();
