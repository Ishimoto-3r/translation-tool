/* =========================================================
   inspection.js
   PDF抽出＋検品リスト生成（pdf.js ESM 安定版）
   ========================================================= */

/* ===== pdf.js (ESM) loader ===== */
const PDFJS_VERSION = "4.10.38";
const PDFJS_LIB_URL =
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER_URL =
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

let _pdfjs = null;

async function ensurePdfjs() {
  if (_pdfjs) return _pdfjs;
  try {
    const mod = await import(PDFJS_LIB_URL);
    mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    _pdfjs = mod;
    return _pdfjs;
  } catch (e) {
    console.error("pdf.js import failed:", e);
    throw new Error("pdfjs が読み込まれていません");
  }
}

/* ===== DOM ===== */
const pdfInput = document.getElementById("pdfInput");
const btnExtract = document.getElementById("btnExtract");
const btnGenerate = document.getElementById("btnGenerate");

const modelInput = document.getElementById("modelInput");
const productInput = document.getElementById("productInput");

const specBox = document.getElementById("specList");
const opBox = document.getElementById("opList");
const accBox = document.getElementById("accList");

/* ===== 状態 ===== */
let currentPdfFile = null;
let extracted = {
  spec: [],
  op: [],
  acc: []
};

/* ===== PDF選択 ===== */
pdfInput.addEventListener("change", (e) => {
  currentPdfFile = e.target.files[0] || null;
});

/* ===== PDFテキスト抽出 ===== */
async function extractPdfTextInBrowser(file) {
  if (!file) throw new Error("PDFが選択されていません");

  const pdfjsLib = await ensurePdfjs();

  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;

  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(" ") + "\n";
  }
  return text;
}

/* ===== 抽出ボタン ===== */
btnExtract.addEventListener("click", async () => {
  try {
    lockUI(true, "PDFを解析中…");

    if (!currentPdfFile) {
      alert("PDFを選択してください");
      return;
    }

    const pdfText = await extractPdfTextInBrowser(currentPdfFile);

    const res = await fetch("/api/inspection?op=extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pdfText })
    });

    if (!res.ok) throw new Error("AI抽出に失敗しました");

    extracted = await res.json();

    renderList(specBox, extracted.spec, false);
    renderList(opBox, extracted.op, false);
    renderList(accBox, extracted.acc, true); // 付属品はデフォルトON
  } catch (e) {
    console.error(e);
    alert(`AI抽出に失敗しました。\n${e.message}`);
  } finally {
    lockUI(false);
  }
});

/* ===== 生成ボタン ===== */
btnGenerate.addEventListener("click", async () => {
  try {
    lockUI(true, "Excel生成中…");

    const payload = {
      model: modelInput.value,
      product: productInput.value,
      specText: collectChecked(specBox),
      opText: collectChecked(opBox),
      accText: collectChecked(accBox)
    };

    const res = await fetch("/api/inspection?op=generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error("生成に失敗しました");

    const blob = await res.blob();
    downloadBlob(blob, "inspection.xlsx");
  } catch (e) {
    console.error(e);
    alert(e.message);
  } finally {
    lockUI(false);
  }
});

/* ===== UI補助 ===== */
function renderList(container, items, defaultChecked) {
  container.innerHTML = "";
  items.forEach(item => {
    const label = document.createElement("label");
    label.style.display = "block";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!defaultChecked;

    label.appendChild(cb);
    label.appendChild(document.createTextNode(" " + item));
    container.appendChild(label);
  });
}

function collectChecked(container) {
  return [...container.querySelectorAll("label")]
    .filter(l => l.querySelector("input").checked)
    .map(l => l.textContent.trim());
}

function lockUI(lock, message = "") {
  btnExtract.disabled = lock;
  btnGenerate.disabled = lock;
  pdfInput.disabled = lock;

  if (lock) {
    btnGenerate.textContent = message || "処理中…";
  } else {
    btnGenerate.textContent = "検品リストExcel生成";
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
