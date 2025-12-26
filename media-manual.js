(() => {
  const fileInput = document.getElementById("fileInput");
  const clearBtn = document.getElementById("clearBtn");
  const runBtn = document.getElementById("runBtn");
  const statusEl = document.getElementById("status");
  const previewEl = document.getElementById("preview");
  const outputEl = document.getElementById("output");
  const copyBtn = document.getElementById("copyBtn");
  const categoryEl = document.getElementById("category");
  const userTypeEl = document.("userType");0
  const notesEl = document.getElementById("notes");
  const VIDEO_SCAN_FPS = 3;            // 動画を何fpsで“判定用”に走査するか（軽量化）
const VIDEO_MAX_FRAMES = 20;         // ★最大20枚（確定）
const VIDEO_MIN_GAP_SEC = 0.8;       // 連写防止（最低間隔）
const DIFF_DOWNSCALE_W = 64;         // 差分判定用の縮小サイズ
const DIFF_DOWNSCALE_H = 36;
const DIFF_THRESHOLD = 18;           // 差分しきい値（大きいほど採用が減る）


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
  // 差分ベースで「変化の大きい瞬間だけ」抽出
  // - 最初と最後は必ず採用
  // - 最大VIDEO_MAX_FRAMES
  // - 補間なし（足りなくても増やさない）

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

  // 送信用（保存用）キャンバス
  const saveCanvas = document.createElement("canvas");
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 360;
  const saveScale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
  saveCanvas.width = Math.round(vw * saveScale);
  saveCanvas.height = Math.round(vh * saveScale);
  const saveCtx = saveCanvas.getContext("2d");

  // 差分判定用キャンバス（超小さく）
  const diffCanvas = document.createElement("canvas");
  diffCanvas.width = DIFF_DOWNSCALE_W;
  diffCanvas.height = DIFF_DOWNSCALE_H;
  const diffCtx = diffCanvas.getContext("2d", { willReadFrequently: true });

  const frames = [];
  let prev = null;              // Uint8ClampedArray
  let lastAcceptedT = -999;

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

  function captureJpeg() {
    saveCtx.drawImage(video, 0, 0, saveCanvas.width, saveCanvas.height);
    return saveCanvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }

  function diffScore() {
    // 判定用に縮小描画 → ピクセル差の平均値をスコアにする
    diffCtx.drawImage(video, 0, 0, diffCanvas.width, diffCanvas.height);
    const { data } = diffCtx.getImageData(0, 0, diffCanvas.width, diffCanvas.height);

    if (!prev) {
      prev = data.slice(); // 初回
      return 0;
    }

    let sum = 0;
    // RGBAのうちRGBのみで差分（粗くてOK）
    for (let i = 0; i < data.length; i += 4) {
      sum += Math.abs(data[i] - prev[i]);       // R
      sum += Math.abs(data[i + 1] - prev[i + 1]); // G
      sum += Math.abs(data[i + 2] - prev[i + 2]); // B
    }
    prev = data.slice();
    // 画素数で正規化（0〜255目安）
    const denom = (diffCanvas.width * diffCanvas.height) * 3;
    return sum / denom;
  }

  // 1) 最初は必ず採用
  await seekTo(0);
  frames.push(captureJpeg());
  lastAcceptedT = 0;

  // 2) 差分走査：判定用fpsで進める（軽量化）
  const step = 1 / Math.max(1, VIDEO_SCAN_FPS);
  for (let t = step; t < duration; t += step) {
    if (frames.length >= VIDEO_MAX_FRAMES - 1) break; // 最後枠を残す
    const tt = await seekTo(t);

    const score = diffScore();
    const gapOk = (tt - lastAcceptedT) >= VIDEO_MIN_GAP_SEC;

    if (gapOk && score >= DIFF_THRESHOLD) {
      frames.push(captureJpeg());
      lastAcceptedT = tt;
    }
  }

  // 3) 最後は必ず採用（重複なら入れない）
  const endT = Math.max(0, duration - 0.2);
  await seekTo(endT);
  const endJpeg = captureJpeg();

  // 末尾がほぼ同じ時刻の可能性があるので軽く回避
  if (frames.length < VIDEO_MAX_FRAMES) {
    frames.push(endJpeg);
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
const dropZone = document.getElementById("dropZone");

function setDropActive(on) {
  if (!dropZone) return;
  dropZone.style.background = on ? "#f2f4f7" : "#fafbfc";
  dropZone.style.borderColor = on ? "#111" : "#cfd4dc";
}

["dragenter", "dragover"].forEach((evName) => {
  dropZone?.addEventListener(evName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(true);
  });
});

["dragleave", "drop"].forEach((evName) => {
  dropZone?.addEventListener(evName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDropActive(false);
  });
});

dropZone?.addEventListener("drop", async (e) => {
  const files = e.dataTransfer?.files;
  if (!files || !files.length) return;
  await prepareFromFiles(files);
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
