// kensho.js
let DB = null;
let imagesDataUrl = [];

const $ = (id) => document.getElementById(id);

function log(msg) {
  $("log").textContent += msg + "\n";
}
function setStatus(msg) {
  $("status").textContent = msg;
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
  setStatus("database読み込み中…");
  const res = await fetch("/api/kensho-db");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.status);
  DB = data;
  setStatus("database読み込み完了");
  return data;
}

function renderLabels(labelMaster) {
  const root = $("labels");
  root.innerHTML = "";

  const visible = labelMaster.filter(x => !x.uiHidden);
  const byGenre = groupBy(sortLabels(visible), x => x.uiGenre);

  for (const [genre, items] of byGenre.entries()) {
    const box = document.createElement("div");
    box.className = "border rounded p-2";

    const h = document.createElement("div");
    h.className = "font-semibold text-sm mb-2";
    h.textContent = genre;

    const list = document.createElement("div");
    list.className = "space-y-1";

    for (const it of items) {
      const lbl = document.createElement("label");
      lbl.className = "flex items-center gap-2 text-sm";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.label = it.label;

      const sp = document.createElement("span");
      sp.textContent = it.label;

      lbl.appendChild(cb);
      lbl.appendChild(sp);
      list.appendChild(lbl);
    }

    box.appendChild(h);
    box.appendChild(list);
    root.appendChild(box);
  }
}

function getSelectedLabels() {
  const cbs = Array.from(document.querySelectorAll("#labels input[type=checkbox]"));
  return cbs.filter(x => x.checked).map(x => x.dataset.label);
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
    img.className = "w-16 h-16 object-cover rounded";
    thumbs.appendChild(img);
  }
}

function buildWorkbookFirst(selectedLabels) {
  // まずは「値だけ」で生成（テンプレの見た目完全再現は後段で可能）
  const ws = XLSX.utils.aoa_to_sheet([
    ["メーカー名"],
    ["メーカー型番"],
    ["検証担当"],
    ["検証開始"],
    ["画像", "検品内容", "検品項目", "確認", "結論", "最終確認", "確認内容", "質問"],
  ]);

  const chosen = new Set(selectedLabels);

  // 重要：label(=ラベル名) と major(=大分類) を一致させて抽出する想定
  const rows = DB.itemList.filter(x => chosen.has(x.major));

  let rowIndex = 6; // 1-based。5行目がヘッダ、その下から
  for (const r of rows) {
    // A列空、B〜Hを機械コピー（ユーザー指示）
    const aoa = [[ "", r.B, r.C, r.D, r.E, r.F, r.G, r.H ]];
    XLSX.utils.sheet_add_aoa(ws, aoa, { origin: { r: rowIndex - 1, c: 0 } });
    rowIndex++;
  }

  return { ws, appendedCount: rows.length, nextRow: rowIndex };
}

function parseAiJson(text) {
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

function downloadWorkbook(wb, filename) {
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

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
    setStatus("生成中…");

    const selected = getSelectedLabels();
    log(`選択数: ${selected.length}`);

    const productInfo = {
      name: $("name").value.trim(),
      feature: $("feature").value.trim(),
      memo: $("memo").value.trim(),
    };

    // 1) DB追記
    const { ws, appendedCount, nextRow } = buildWorkbookFirst(selected);
    log(`DB追記: ${appendedCount}行`);

    // 2) AI追記
    setStatus("AI提案中…");
    const currentRows = { appendedCount };
    const ai = await fetchAiSuggestions({ productInfo, selectedLabels: selected, currentRows });
    log(`AI提案: ${ai.length}件`);

    let rowIndex = nextRow;
    for (const it of ai) {
      const text = (it?.text || "").toString();
      const note = (it?.note || "").toString();
      if (!text.trim()) continue;

      // A空 / B=AI提案 / C=提案内容 / G=補足
      const aoa = [[ "", "AI提案", text, "", "", "", note, "" ]];
      XLSX.utils.sheet_add_aoa(ws, aoa, { origin: { r: rowIndex - 1, c: 0 } });
      rowIndex++;
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "初回検証");

    const name = productInfo.name || "無題";
    downloadWorkbook(wb, `検証_${name}.xlsx`);

    setStatus("完了");
    log("--- 完了 ---");
  } catch (e) {
    console.error(e);
    setStatus("エラー: " + String(e));
    log("ERROR: " + String(e));
  }
}

async function onDownloadMassTemplate() {
  try {
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

    setStatus("完了");
  } catch (e) {
    console.error(e);
    setStatus("エラー: " + String(e));
  }
}

(async function init() {
  setupDrop();
  try {
    const data = await loadDb();
    renderLabels(data.labelMaster);
  } catch (e) {
    console.error(e);
    setStatus("初期化エラー: " + String(e));
  }

  $("btn-generate").addEventListener("click", onGenerate);
  $("btn-mass").addEventListener("click", onDownloadMassTemplate);
})();
