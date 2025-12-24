// kensho.js（全文置き換え）
let DB = null;
let imagesDataUrl = []; // dataURLの配列
const $ = (id) => document.getElementById(id);

function setStatus(msg) {
  const el = $("status");
  if (el) el.textContent = msg;
}

function showOverlay(title, msg) {
  const t = $("overlay-title");
  const m = $("overlay-msg");
  const o = $("overlay");
  if (t) t.textContent = title || "処理中…";
  if (m) m.textContent = msg || "";
  if (o) {
    o.classList.remove("hidden");
    o.classList.add("flex");
  }
}
function hideOverlay() {
  const o = $("overlay");
  if (o) {
    o.classList.add("hidden");
    o.classList.remove("flex");
  }
}

// 進捗（分数表示）
const STEPS = ["SharePoint読み込み", "Excel生成", "AI提案", "ダウンロード準備"];
function setStep(stepIndex, msg) {
  const n = stepIndex + 1;
  const N = STEPS.length;
  const text = `${msg}（${n}/${N}）`;
  setStatus(text);
  showOverlay("実行中…", text);
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function sortLabels(items) {
  return items.slice().sort((a, b) => {
    const g1 = a.uiGenreOrder ?? 9999;
    const g2 = b.uiGenreOrder ?? 9999;
    if (g1 !== g2) return g1 - g2;

    const i1 = a.uiItemOrder ?? 9999;
    const i2 = b.uiItemOrder ?? 9999;
    if (i1 !== i2) return i1 - i2;

    return a.label.localeCompare(b.label, "ja");
  });
}

async function loadDb() {
  setStep(0, "SharePointから読み込み中");

  const res = await fetch("/api/kensho-db");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);

  DB = data;
  setStatus("読み込み完了");
  hideOverlay();
  return data;
}

/** ✅ ラベル表示（行間を詰める） */
function renderLabels(labelMaster) {
  const root = $("labels");
  if (!root) return;
  root.innerHTML = "";

  const visible = (labelMaster || []).filter((x) => !x.uiHidden);
  const byGenre = groupBy(sortLabels(visible), (x) => x.uiGenre);

  for (const [genre, items] of byGenre.entries()) {
    const card = document.createElement("div");
    // パディングも少し縮める
    card.className = "border rounded-xl p-2 bg-white";

    const head = document.createElement("div");
    head.className = "flex items-center justify-between mb-1";

    const title = document.createElement("div");
    title.className = "font-semibold text-sm";
    title.textContent = genre;

    const clear = document.createElement("button");
    clear.className = "text-xs text-blue-600 hover:underline";
    clear.textContent = "解除";
    clear.addEventListener("click", () => {
      card.querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.checked = false));
    });

    head.appendChild(title);
    head.appendChild(clear);

    // ✅ 行間を詰める：space-y-0.5
    const list = document.createElement("div");
    list.className = "space-y-0.5";

    for (const it of items) {
      const row = document.createElement("label");

      // ✅ 余白を詰める：px-2 py-1
      row.className =
        "flex items-start gap-2 text-sm cursor-pointer rounded-md px-2 py-1 " +
        "border border-slate-200 hover:bg-slate-50 select-none";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.label = it.label;
      cb.className = "h-5 w-5 mt-[2px]";

      const sp = document.createElement("span");
      sp.textContent = it.label;
      sp.className = "leading-snug whitespace-normal break-words";

      row.appendChild(cb);
      row.appendChild(sp);
      list.appendChild(row);
    }

    card.appendChild(head);
    card.appendChild(list);
    root.appendChild(card);
  }
}

function getSelectedLabels() {
  const cbs = Array.from(document.querySelectorAll("#labels input[type=checkbox]"));
  return cbs.filter((x) => x.checked).map((x) => x.dataset.label);
}

/** ===== 画像読み込み（安定版） ===== */
function bytesToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("FileReaderError"));
    r.readAsDataURL(file);
  });
}

async function addImages(files) {
  if (!files || files.length === 0) return;

  // 画像だけにフィルタ
  const imgs = Array.from(files).filter((f) => f && typeof f.type === "string" && f.type.startsWith("image/"));
  if (imgs.length === 0) {
    setStatus("画像ファイルが見つかりませんでした");
    return;
  }

  try {
    const urls = [];
    for (const f of imgs) {
      const u = await bytesToDataUrl(f);
      urls.push(u);
    }
    imagesDataUrl = imagesDataUrl.concat(urls);
    renderThumbs();
    setStatus(`画像を読み込みました（${imagesDataUrl.length}枚）`);
  } catch (e) {
    console.error(e);
    setStatus("画像の読み込みに失敗しました");
  }
}

function removeImageAt(idx) {
  imagesDataUrl.splice(idx, 1);
  renderThumbs();
  setStatus(`画像を更新しました（${imagesDataUrl.length}枚）`);
}

function renderThumbs() {
  const thumbs = $("thumbs");
  if (!thumbs) return;

  thumbs.innerHTML = "";

  imagesDataUrl.forEach((u, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "relative";

    const img = document.createElement("img");
    img.src = u;
    img.className = "w-16 h-16 object-cover rounded-lg border border-slate-300";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "×";
    btn.className =
      "absolute -top-2 -right-2 w-6 h-6 rounded-full bg-slate-800 text-white text-sm leading-6 " +
      "shadow hover:bg-slate-700";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeImageAt(idx);
    });

    wrap.appendChild(img);
    wrap.appendChild(btn);
    thumbs.appendChild(wrap);
  });
}

function setupDrop() {
  const drop = $("drop");
  const input = $("img"); // ✅ id="img"
  if (!drop || !input) {
    console.error("drop or img input not found");
    setStatus("画像欄の初期化に失敗（drop/imgが見つかりません）");
    return;
  }

  // クリックでファイル選択
  drop.addEventListener("click", () => input.click());

  // D&Dでブラウザがファイルを開くのを防止
  ["dragenter", "dragover"].forEach((ev) => {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.add("bg-slate-50");
    });
  });

  ["dragleave", "drop"].forEach((ev) => {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove("bg-slate-50");
    });
  });

  drop.addEventListener("drop", async (e) => {
    const files = e.dataTransfer?.files;
    await addImages(files);
  });

  input.addEventListener("change", async () => {
    await addImages(input.files);
    input.value = ""; // 同じファイル再選択できるように
  });
}

/** ===== 生成 ===== */
async function onGenerate() {
  try {
    const selected = getSelectedLabels();
    if (selected.length === 0) {
      setStatus("選択がありません");
      return;
    }

    const productInfo = {
      name: $("name")?.value?.trim?.() || "",
      feature: $("feature")?.value?.trim?.() || "",
      memo: $("memo")?.value?.trim?.() || "",
    };

    setStep(1, "Excel生成中（書式維持）");

    const res = await fetch("/api/kensho-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedLabels: selected,
        productInfo,
        images: imagesDataUrl,
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error("生成失敗: " + t);
    }

    setStep(3, "ダウンロード準備");

    const blob = await res.blob();
    const name = productInfo.name || "無題";
    const filename = `検証_${name}.xlsx`;

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);

    hideOverlay();
    setStatus("完了");
  } catch (e) {
    console.error(e);
    hideOverlay();
    setStatus("エラー: " + String(e));
  }
}

async function onDownloadMassTemplate() {
  try {
    showOverlay("量産前テンプレ", "ダウンロード準備中");
    setStatus("量産前テンプレDL中…");

    const res = await fetch("/api/kensho-template?type=mass");
    if (!res.ok) throw new Error("download failed");
    const blob = await res.blob();

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "量産前検証フォーマット.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);

    hideOverlay();
    setStatus("完了");
  } catch (e) {
    console.error(e);
    hideOverlay();
    setStatus("エラー: " + String(e));
  }
}

(async function init() {
  setupDrop();

  const btnGen = $("btn-generate");
  const btnMass = $("btn-mass");
  if (btnGen) btnGen.addEventListener("click", onGenerate);
  if (btnMass) btnMass.addEventListener("click", onDownloadMassTemplate);

  try {
    const data = await loadDb();
    renderLabels(data.labelMaster);
  } catch (e) {
    console.error(e);
    hideOverlay();
    setStatus("初期化エラー: " + String(e));
  }
})();
