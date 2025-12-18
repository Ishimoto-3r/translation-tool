// kensho.js（置き換え）
let DB = null;
let imagesDataUrl = [];

const $ = (id) => document.getElementById(id);

function log(msg) { $("log").textContent += msg + "\n"; }
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

    const list = document.createElement("div");
    list.className = "space-y-1";

    for (const it of items) {
      // 行全体がクリックできるように label を大きく
      const row = document.createElement("label");
      row.className =
        "flex items-center gap-2 text-sm cursor-pointer rounded-lg px-2 py-2 hover:bg-slate-50 select-none";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.label = it.label;
      cb.className = "h-5 w-5"; // 押しやすく

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

  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("bg-slate-50");
  });
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

function parseAiJson(text) {
  // 余計な文章が混じった時でも配列部分だけ取る
  const m = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  const jsonText = m ? m[0] : text;
  const parsed = JSON.parse(jsonText);
  return Array.isArray(parsed) ? parsed : [];
}

async function fetchAiSuggestions({ productInfo, selectedLabels, currentRows }) {
  const res = await fetch("/api/kensho-ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productInfo, selectedLabels, currentRows, images: imagesDataUrl }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  return parseAiJson(data.text || "[]");
}

// B〜H（2〜8列）で「実際に値が入っている最終行」を探す
function findLastUsedRowBH(ws) {
  const ref = ws["!ref"] || "A1:A1";
  const range = XLSX.utils.decode_range(ref);
  let last = 1;

  for (let r = range.s.r; r <= range.e.r; r++) {
    let any = false;
    for (let c = 1; c <= 7; c++) { // B(1)〜H(7) 0-based
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      const v = cell?.v;
      if (v !== undefined && String(v).trim() !== "") {
        any = true;
        break;
      }
    }
    if (any) last = r + 1; // 1-based
  }
  return last;
}

async function loadFirstTemplateWorkbook() {
  // テンプレxlsxを取得して、そのまま土台にする（④対策）
  const res = await fetch("/api/kensho-template?type=first");
  if (!res.ok) throw new Error("テンプレ取得失敗");
  const ab = await res.arrayBuffer();
  const wb = XLSX.read(ab, { type: "array" });
  return wb;
}

function downloadWorkbook(wb, filename) {
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

async function onGenerate() {
  try {
    log("--- 生成開始 ---");

    const selected = getSelectedLabels();
    const productInfo = {
      name: $("name").value.trim(),
      feature: $("feature").value.trim(),
      memo: $("memo").value.trim(),
    };

    if (selected.length === 0) {
      setStatus("選択がありません");
      return;
    }

    showOverlay("実行中…", "テンプレ取得中");
    setStatus("実行中…");

    // 1) テンプレ取得（④：理想形に合わせる）
    const wb = await loadFirstTemplateWorkbook();
    const sheetName = wb.SheetNames.includes("初回検証フォーマット") ? "初回検証フォーマット" : wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];

    // 2) DB抽出分を末尾に追記
    showOverlay("実行中…", "DB抽出中");
    const chosen = new Set(selected);

    // 重要：label(=ラベル名) と major(=大分類) を一致させる想定
    const rows = (DB?.itemList || []).filter(x => chosen.has(x.major));

    const startRow = findLastUsedRowBH(ws) + 1; // 次行から追記
    let rowIndex = startRow;

    for (const r of rows) {
      // A空、B〜Hを機械コピー（ユーザー指示）
      const aoa = [[ "", r.B, r.C, r.D, r.E, r.F, r.G, r.H ]];
      XLSX.utils.sheet_add_aoa(ws, aoa, { origin: { r: rowIndex - 1, c: 0 } });
      rowIndex++;
    }
    log(`DB追記: ${rows.length}行`);

    // 3) AI提案
    showOverlay("実行中…", "AI提案中");
    const currentRows = { appendedCount: rows.length, templateSheet: sheetName };
    const ai = await fetchAiSuggestions({ productInfo, selectedLabels: selected, currentRows });
    log(`AI提案: ${ai.length}件`);

    for (const it of ai) {
      const text = (it?.text || "").toString();
      const note = (it?.note || "").toString();
      if (!text.trim()) continue;

      // A空 / B=AI提案 / C=提案内容 / G=補足
      const aoa = [[ "", "AI提案", text, "", "", "", note, "" ]];
      XLSX.utils.sheet_add_aoa(ws, aoa, { origin: { r: rowIndex - 1, c: 0 } });
      rowIndex++;
    }

    // 4) シート名をユーザー向けに統一
    // 既存テンプレのシート名が「初回検証フォーマット」なら、出力は「初回検証」にしたい
    if (sheetName !== "初回検証") {
      wb.Sheets["初回検証"] = ws;
      delete wb.Sheets[sheetName];
      const idx = wb.SheetNames.indexOf(sheetName);
      if (idx >= 0) wb.SheetNames[idx] = "初回検証";
    }

    // 5) DL
    showOverlay("実行中…", "Excel生成中 → ダウンロード準備");
    const name = productInfo.name || "無題";
    downloadWorkbook(wb, `検証_${name}.xlsx`);

    hideOverlay();
    setStatus("完了");
    log("--- 完了 ---");
  } catch (e) {
    console.error(e);
    hideOverlay();
    setStatus("エラー: " + String(e));
    log("ERROR: " + String(e));
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
