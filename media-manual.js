const $ = (id) => document.getElementById(id);

const drop = $("video-drop");
const fileInput = $("video-file");
const info = $("video-info");
const btn = $("btn-generate");
const status = $("status-text");
const out = $("output");

let selectedFile = null;

// ===== Overlay with elapsed seconds + step log =====
let overlayTick = null;
let overlayStartedAt = null;
const stepLines = [];

function showOverlay(title, msg) {
  const overlay = $("overlay");
  const t = $("overlay-title");
  const m = $("overlay-msg");
  const log = $("overlay-log");

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
  const log = $("overlay-log");
  if (log) log.textContent = stepLines.join("\n");
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
}

// ===== Helpers =====
function isVideoFile(file) {
  if (!file) return false;
  return (file.type || "").startsWith("video/");
}

async function getVideoDurationSeconds(file) {
  // Reliable duration: load metadata into a temporary <video>
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      const d = Number(v.duration);
      URL.revokeObjectURL(url);
      if (!Number.isFinite(d)) return reject(new Error("DurationUnknown"));
      resolve(d);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("DurationReadFailed"));
    };
    v.src = url;
  });
}

function setSelectedFile(file) {
  selectedFile = file;
  if (!file) {
    info.textContent = "";
    return;
  }
  info.textContent = `選択中：${file.name}（${Math.round(file.size / 1024 / 1024)}MB）`;
}

function showError(msg) {
  status.textContent = msg;
}

// Click to open file picker
drop.addEventListener("click", () => fileInput.click());

// File picker change
fileInput.addEventListener("change", async () => {
  status.textContent = "";
  out.textContent = "";
  const files = fileInput.files ? Array.from(fileInput.files) : [];
  if (files.length === 0) return;

  if (files.length !== 1) {
    fileInput.value = "";
    setSelectedFile(null);
    return showError("動画は1本のみ選択してください。");
  }
  const f = files[0];
  if (!isVideoFile(f)) {
    fileInput.value = "";
    setSelectedFile(null);
    return showError("画像は受け付けません。動画ファイルを選択してください。");
  }
  try {
    const dur = await getVideoDurationSeconds(f);
    if (dur > 30.01) {
      fileInput.value = "";
      setSelectedFile(null);
      return showError("動画は30秒以内にしてください。");
    }
  } catch {
    // Duration check failed -> block (safer)
    fileInput.value = "";
    setSelectedFile(null);
    return showError("動画の秒数を確認できませんでした。30秒以内の動画を選択してください。");
  }
  setSelectedFile(f);
});

// Drag & drop handlers
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("ring-2", "ring-slate-400");
});
drop.addEventListener("dragleave", () => {
  drop.classList.remove("ring-2", "ring-slate-400");
});
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("ring-2", "ring-slate-400");
  status.textContent = "";
  out.textContent = "";

  const files = e.dataTransfer ? Array.from(e.dataTransfer.files || []) : [];
  if (files.length === 0) return;

  if (files.length !== 1) {
    setSelectedFile(null);
    fileInput.value = "";
    return showError("動画は1本のみ受け付けます。");
  }

  const f = files[0];
  if (!isVideoFile(f)) {
    setSelectedFile(null);
    fileInput.value = "";
    return showError("画像は受け付けません。動画ファイルをドラッグしてください。");
  }

  try {
    const dur = await getVideoDurationSeconds(f);
    if (dur > 30.01) {
      setSelectedFile(null);
      fileInput.value = "";
      return showError("動画は30秒以内にしてください。");
    }
  } catch {
    setSelectedFile(null);
    fileInput.value = "";
    return showError("動画の秒数を確認できませんでした。30秒以内の動画を選択してください。");
  }

  // Put the file into the hidden input (best-effort)
  try {
    const dt = new DataTransfer();
    dt.items.add(f);
    fileInput.files = dt.files;
  } catch {
    // Some browsers may block programmatic set; that's fine.
  }

  setSelectedFile(f);
});

function setUIBusy(busy) {
  btn.disabled = busy;
  if (busy) {
    btn.classList.add("opacity-60", "cursor-not-allowed");
    drop.classList.add("opacity-60", "pointer-events-none");
  } else {
    btn.classList.remove("opacity-60", "cursor-not-allowed");
    drop.classList.remove("opacity-60", "pointer-events-none");
  }
}

btn.addEventListener("click", async () => {
  status.textContent = "";
  out.textContent = "";

  if (!selectedFile) return showError("動画を1本選択してください。");

  const notes = ($("notes").value || "").trim();
  const granularity = ($("granularity").value || "standard").toString();

  setUIBusy(true);
  showOverlay("生成中…", "処理中");
  logStep("入力チェック");

  try {
    logStep("サーバー処理（原稿生成）");
    const res = await fetch("/api/manual-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "media-manual",
        notes,
        granularity,
        // 既存実装に合わせてフレーム抽出はサーバ側で行う前提
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("manual-ai error", data);
      status.textContent = "生成に失敗しました。";
      return;
    }

    logStep("結果の整形");
    out.textContent = (data.text || "").toString();
    status.textContent = "原稿案を生成しました。";
  } catch (e) {
    console.warn(e);
    status.textContent = "生成に失敗しました。";
  } finally {
    hideOverlay();
    setUIBusy(false);
  }
});
