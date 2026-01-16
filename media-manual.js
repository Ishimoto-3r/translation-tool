(() => {
  const $ = (id) => document.getElementById(id);

  const fileInput = $("fileInput");
  const clearBtn = $("clearBtn");
  const runBtn = $("runBtn");
  const statusEl = $("status");
  const previewEl = $("preview");
  const outputEl = $("output");
  const copyBtn = $("copyBtn");
  const notesEl = $("notes");
  const dropZone = $("dropZone");

  // ===== 固定仕様 =====
  const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200MB
  const MAX_DURATION_SEC = 30;               // 30秒
  const MAX_IMAGES_TOTAL = 20;               // 動画から抽出して送る最大枚数

  // 画質・サイズ
  const JPEG_QUALITY = 0.82;
  const MAX_SIDE = 1280;

  // 差分抽出（補間なし）
  const VIDEO_SCAN_FPS = 3;       // 判定用の走査fps
  const VIDEO_MIN_GAP_SEC = 0.8;  // 連写防止
  const DIFF_DOWNSCALE_W = 64;
  const DIFF_DOWNSCALE_H = 36;
  const DIFF_THRESHOLD = 18;

  let preparedImages = []; // { dataUrl, name }
  let locked = false;

  // ===== UI: overlay + log =====
  let overlayTick = null;
  let overlayStartedAt = null;
  let overlayLines = [];

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg || "";
  }

  function showOverlay(title, msg) {
    const overlay = $("overlay");
    const t = $("overlay-title");
    const m = $("overlay-msg");
    const logEl = $("overlay-log");

    overlayLines = [];
    if (t) t.textContent = title || "処理中…";

    const baseMsg = msg || "しばらくお待ちください";
    overlayStartedAt = Date.now();

    if (overlayTick) clearInterval(overlayTick);
    overlayTick = setInterval(() => {
      const sec = Math.floor((Date.now() - overlayStartedAt) / 1000);
      if (m) m.textContent = `${baseMsg}（${sec}s）`;
    }, 500);

    if (m) m.textContent = `${baseMsg}（0s）`;
    if (logEl) logEl.textContent = "";

    if (overlay) {
      overlay.classList.remove("hidden");
      overlay.classList.add("flex");
    }
  }

  function logStep(line) {
    const logEl = $("overlay-log");
    if (!logEl) return;
    overlayLines.push(`• ${line}`);
    logEl.textContent = overlayLines.slice(-8).join("\n");
  }

  function hideOverlay() {
    const overlay = $("overlay");
    if (overlay) {
      overlay.classList.add("hidden");
      overlay.classList.remove("flex");
    }
    if (overlayTick) {
      clearInterval(overlayTick);
      overlayTick = null;
    }
    overlayStartedAt = null;
    overlayLines = [];
  }

  function setLocked(on) {
    locked = !!on;
    if (runBtn) runBtn.disabled = locked;
    if (clearBtn) clearBtn.disabled = locked;
    if (fileInput) fileInput.disabled = locked;
    if (notesEl) notesEl.disabled = locked;
    if (dropZone) dropZone.style.pointerEvents = locked ? "none" : "auto";
  }

  // ===== Helpers =====
  async function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function addThumb(dataUrl, label) {
    const d = document.createElement("div");
    d.className = "border border-slate-200 rounded-xl overflow-hidden bg-slate-50 aspect-[4/3] flex items-center justify-center";
    if (dataUrl) {
      const img = document.createElement("img");
      img.src = dataUrl;
      img.className = "w-full h-full object-cover block";
      d.appendChild(img);
    } else {
      const s = document.createElement("div");
      s.className = "text-xs text-slate-500 p-2 text-center";
      s.textContent = label || "";
      d.appendChild(s);
    }
    previewEl.appendChild(d);
  }

  function setDropActive(on) {
    if (!dropZone) return;
    dropZone.classList.toggle("bg-slate-100", !!on);
    dropZone.classList.toggle("border-slate-900", !!on);
  }

  function humanMB(bytes) {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)}MB`;
  }

  function validateVideoFile(file) {
    if (!file) throw new Error("動画ファイルを選択してください");
    if (!file.type || !file.type.startsWith("video/")) {
      throw new Error("動画ファイルのみ受け付けます");
    }
    if (file.size > MAX_VIDEO_BYTES) {
      throw new Error(`動画の容量が大きすぎます（最大 ${humanMB(MAX_VIDEO_BYTES)}）`);
    }
  }

  async function getVideoMetadata(file) {
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
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 360;
    URL.revokeObjectURL(url);
    return { duration, vw, vh };
  }

  async function extractVideoFrames(file) {
    // 差分ベース抽出：変化の大きい瞬間だけ採用
    // - 最初と最後は必ず採用
    // - 最大 MAX_IMAGES_TOTAL（補間なし）

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
    if (duration > MAX_DURATION_SEC + 0.05) {
      URL.revokeObjectURL(url);
      throw new Error(`動画が長すぎます（最大 ${MAX_DURATION_SEC} 秒）`);
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

    logStep(`動画メタ情報：${duration.toFixed(1)}秒 / ${vw}×${vh}`);
    logStep("フレーム抽出を開始");

    // 最初は必ず採用
    await seekTo(0);
    frames.push(captureJpeg());
    lastAcceptedT = 0;

    const step = 1 / Math.max(1, VIDEO_SCAN_FPS);
    let scanned = 0;
    const totalSteps = Math.max(1, Math.floor(duration / step));

    for (let t = step; t < duration; t += step) {
      if (frames.length >= MAX_IMAGES_TOTAL - 1) break; // 最後枠確保
      const tt = await seekTo(t);
      scanned++;

      const score = diffScore();
      const gapOk = (tt - lastAcceptedT) >= VIDEO_MIN_GAP_SEC;

      if (gapOk && score >= DIFF_THRESHOLD) {
        frames.push(captureJpeg());
        lastAcceptedT = tt;
      }

      // 体感の進捗（工程ログ）
      if (scanned % 6 === 0) {
        const pct = Math.min(99, Math.floor((scanned / totalSteps) * 100));
        logStep(`抽出中：${pct}% / 取得 ${frames.length}枚`);
      }
    }

    // 最後は必ず採用（枠が残っている場合のみ）
    if (frames.length < MAX_IMAGES_TOTAL) {
      const endT = Math.max(0, duration - 0.2);
      await seekTo(endT);
      frames.push(captureJpeg());
    }

    logStep(`抽出完了：${frames.length}枚`);
    URL.revokeObjectURL(url);
    return frames;
  }

  async function prepareFromFiles(files) {
    preparedImages = [];
    if (previewEl) previewEl.innerHTML = "";
    if (outputEl) outputEl.value = "";

    const list = Array.from(files || []);
    if (!list.length) {
      setStatus("動画を選択してください");
      return;
    }

    // 1本のみ受付（2本以上はブロック）
    if (list.length > 1) {
      setStatus("動画は1本のみ受け付けます");
      return;
    }

    const file = list[0];
    try {
      validateVideoFile(file);
    } catch (e) {
      setStatus(e.message || "動画ファイルを確認してください");
      return;
    }

    setLocked(true);
    showOverlay("準備中…", "動画を確認しています");

    try {
      logStep("入力チェック");
      const meta = await getVideoMetadata(file);
      if (!meta.duration) throw new Error("動画を読み込めませんでした");
      if (meta.duration > MAX_DURATION_SEC + 0.05) {
        throw new Error(`動画が長すぎます（最大 ${MAX_DURATION_SEC} 秒）`);
      }

      logStep("フレーム抽出");
      const frames = await extractVideoFrames(file);
      preparedImages = frames.map((dataUrl, i) => ({
        dataUrl,
        name: `${file.name}#frame${i + 1}`,
      }));

      if (previewEl) {
        previewEl.innerHTML = "";
        for (const im of preparedImages) addThumb(im.dataUrl, im.name);
      }

      setStatus(`準備完了：${preparedImages.length}枚 送信`);
    } catch (e) {
      console.error(e);
      setStatus(e?.message ? e.message : "動画の準備に失敗しました");
    } finally {
      hideOverlay();
      setLocked(false);
    }
  }

  function stripLeadingHeading(text) {
    // サーバ側で外すが、保険でクライアント側も除去
    const t = String(text || "");
    return t.replace(/^\s*見出し\s*[:：]\s*操作手順\s*\n+/m, "");
  }

  async function run() {
    if (!preparedImages.length) {
      setStatus("先に動画を選択してください");
      return;
    }

    setLocked(true);
    showOverlay("生成中…", "AIに送信しています");

    try {
      logStep("送信データ作成");
      const payload = {
        mode: "media-manual",
        notes: (notesEl?.value || "").toString(),
        images: preparedImages.map((x) => ({ name: x.name, dataUrl: x.dataUrl })),
      };

      logStep("API呼び出し");
      const res = await fetch("/api/manual-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`API error: ${res.status} ${t}`);
      }

      logStep("結果を受信");
      const data = await res.json();
      const out = data && data.text ? String(data.text) : "";
      if (outputEl) outputEl.value = stripLeadingHeading(out);

      setStatus("原稿案を生成しました");
      logStep("完了");
    } catch (e) {
      console.error(e);
      setStatus(`失敗：${e?.message ? e.message : e}`);
    } finally {
      hideOverlay();
      setLocked(false);
    }
  }

  function resetAll() {
    if (locked) return;
    if (fileInput) fileInput.value = "";
    preparedImages = [];
    if (previewEl) previewEl.innerHTML = "";
    if (outputEl) outputEl.value = "";
    if (notesEl) notesEl.value = "";
    setStatus("");
  }

  // ===== Events =====
  if (fileInput) {
    fileInput.addEventListener("change", (ev) => {
      prepareFromFiles(ev.target.files).catch((err) => {
        console.error(err);
        setStatus("動画の準備に失敗しました");
      });
    });
  }

  if (clearBtn) clearBtn.addEventListener("click", resetAll);
  if (runBtn) runBtn.addEventListener("click", run);

  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(outputEl?.value || "");
        setStatus("コピーしました");
        setTimeout(() => setStatus(""), 1200);
      } catch {
        setStatus("コピーに失敗しました");
      }
    });
  }

  // Drag & Drop (video only)
  if (dropZone) {
    ["dragenter", "dragover"].forEach((evName) => {
      dropZone.addEventListener(evName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (locked) return;
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
      if (locked) return;
      const dt = e.dataTransfer;
      const files = dt ? dt.files : null;
      if (!files || !files.length) return;
      await prepareFromFiles(files);
    });
  }
})();
