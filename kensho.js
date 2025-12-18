// kensho.js（置き換え）
let DB = null;
let imagesDataUrl = [];
const $ = (id) => document.getElementById(id);

function setStatus(msg) { $("status").textContent = msg; }

function showOverlay(title, msg) {
  $("overlay-title").textContent = title || "処理中…";
  $("overlay-msg").textContent = msg || "";
  $("overlay").classList.remove("hidden");
  $("overlay").classList.add("flex");
}
function hideOverlay() {
  $("overlay").classList.add("hidden");
  $("overlay").classList.remove("flex");
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
  showOverlay("SharePointから読み込み中…", "database を取得しています");
  setStatus("読み込み中…");

  const res = await fetch("/api/kensho-db");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);

  DB = data;
  $("db-badge").textContent = `label=${data.labelMaster?.length ?? 0} / list=${data.itemList?.length ?? 0}`;
  setStatus("読み込み完了");
  hideOverlay();
  return data;
}

function renderLabels(labelMaster) {
  const root = $("labels");
  root.innerHTML = "";

  const visible = labelMaster.filter(x => !x.uiHidden);
  const byGenre = groupBy(sortLabels(visible), x => x.uiGenre);

  for (const [genre, items] of byGenre.entries()) {
    const card = document.createElement("div");
    card.className = "border rounded-xl p-2";

    const head = document.createElement("div");
    head.className = "flex items-center justify-between mb-2";

    const title = document.createElement("div");
    title.className = "font-semibold text-sm";
    title.textContent = genre;

    const clear = document.createElement("button");
    clear.className = "text-xs text-blue-600 hover:underline";
    clear.textContent = "解除";
    clear.addEventListener("click", () => {
      card.querySelectorAll("input[type=checkbox]").forEach(cb => (cb.checked = false));
    });

    head.appendChild(title);
    head.appendChild(clear);

    // ✅ ジャンル内を2列にして縦長を抑える
    const list = document.createElement("div");
    list.className = "grid grid-cols-1 sm:grid-cols-2 gap-x-2 gap-y-1";

    for (const it of items) {
      const row = document.createElement("label");
      row.className = "flex items-center gap-2 text-sm cursor-pointer rounded-lg px-2 py-2 hover:bg-slate-50 select-none";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.label = it.label;
      cb.className = "h-5 w-5";

      const sp = document.createElement("span");
      sp.textContent = it.label;

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
  return cbs.filter(x => x.checked).map(x => x.dataset.label);
}
function clearAllChecks() {
  document.querySelectorAll("#labels input[type=checkbox]").forEach(cb => (cb.checked = false));
}

function readFilesAsDataURL(files) {
  return Promise.all(Array.from(files).map(f => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(f);
  })));
}

function setupDrop() {
  const drop = $("drop");
  const input = $("img");

  drop.addEventListener("click", () => input.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("bg-slate-50"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("bg-slate-50"));

  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("bg-slate-50");
    if (!e.dataTransfer?.files?.length) return;
    await handleImages(e.dataTransfer.files);
  });

  input.addEventListener("change", async () => {
    if (!input.files?.length) return;
    await handleImages(input.files);
    input.value = "";
  });
}

async function handleImages(files) {
  const urls = await readFilesAsDataURL(files);
  imagesDataUrl = imagesDataUrl.concat(urls);

  const thumbs = $("thumbs");
  thumbs.innerHTML = "";
  for (const u of imagesDataUrl) {
    const img = document.createElement("img");
    img.src = u;
    img.className = "w-16 h-16 object-cover rounded-lg";
    thumbs.appendChild(img);
  }
}

async function onGenerate() {
  try {
    const selected = getSelectedLabels();
    if (selected.length === 0) { setStatus("選択がありません"); return; }

    const productInfo = {
      name: $("name").value.trim(),
      feature: $("feature").value.trim(),
      memo: $("memo").value.trim(),
    };

    showOverlay("実行中…", "Excel生成中（書式維持）");
    setStatus("実行中…");

    // ✅ Excelはサーバ側で生成（書式維持）
    const res = await fetch("/api/kensho-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedLabels: selected, productInfo, images: imagesDataUrl }),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error("生成失敗: " + t);
    }

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
  $("btn-clear-all").addEventListener("click", clearAllChecks);
  $("btn-generate").addEventListener("click", onGenerate);
  $("btn-mass").addEventListener("click", onDownloadMassTemplate);

  try {
    const data = await loadDb();
    renderLabels(data.labelMaster);
  } catch (e) {
    console.error(e);
    hideOverlay();
    setStatus("初期化エラー: " + String(e));
  }
})();
