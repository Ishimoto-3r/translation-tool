/* =========================================================
   inspection.js（全文・前の状態へ復帰）
   - [object Object] 根絶（深掘り文字列抽出）
   - オーバーレイ復活 + 二重押し防止 + 進捗表示復活
   - 抽出API：extract_text → extract にフォールバック（前に動いていたopへ戻す）
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
const $ = (id) => document.getElementById(id);

const overlay = $("overlay");
const overlayMsg = $("overlayMsg");

const pdfInput = $("pdfInput");
const fileName = $("fileName");

const btnExtract = $("btnExtract");
const btnGenerate = $("btnGenerate");
const progress = $("progress");

const modelInput = $("modelInput");
const productInput = $("productInput");

const specBox = $("specList");
const opBox = $("opList");
const accBox = $("accList");

const selectListBox = $("selectList");
const lblLiion = $("lblLiion");
const lblLegal = $("lblLegal");

let currentPdfFile = null;
let isBusy = false;

/* ===== Busy / Overlay ===== */
function setBusy(on, msg) {
  isBusy = on;

  // overlay
  if (overlay) {
    if (on) overlay.classList.add("show");
    else overlay.classList.remove("show");
  }
  if (overlayMsg && msg) overlayMsg.textContent = msg;

  // progress
  if (progress) {
    if (on) {
      progress.textContent = msg || "処理中…";
      progress.classList.remove("hidden");
    } else {
      progress.classList.add("hidden");
      progress.textContent = "";
    }
  }

  // lock inputs
  pdfInput.disabled = on;
  btnExtract.disabled = on;
  btnGenerate.disabled = on;
  if (lblLiion) lblLiion.disabled = on;
  if (lblLegal) lblLegal.disabled = on;
  if (modelInput) modelInput.disabled = on;
  if (productInput) productInput.disabled = on;

  // lock checkboxes
  [selectListBox, specBox, opBox, accBox].forEach((box) => {
    if (!box) return;
    box.querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.disabled = on));
  });
}

/* ===== File select ===== */
pdfInput?.addEventListener("change", () => {
  currentPdfFile = pdfInput.files && pdfInput.files[0] ? pdfInput.files[0] : null;
  if (fileName) fileName.textContent = currentPdfFile ? currentPdfFile.name : "未選択";
});

/* ===== PDF text extraction ===== */
async function extractPdfTextInBrowser(file) {
  if (!file) throw new Error("PDFが選択されていません");
  const pdfjsLib = await ensurePdfjs();

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

  let text = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n";
  }
  return text;
}

/* ===== [object Object] 根絶：深掘りで「最初の文字列」を拾う ===== */
function findFirstStringDeep(x, depth = 0) {
  if (x == null) return "";
  if (typeof x === "string") return x.trim();
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  if (depth > 6) return ""; // これ以上掘らない

  if (Array.isArray(x)) {
    for (const v of x) {
      const s = findFirstStringDeep(v, depth + 1);
      if (s) return s;
    }
    return "";
  }

  if (typeof x === "object") {
    // よくあるキー候補を先に見る（Excel/セル系もここで拾える）
    const keysFirst = ["text", "label", "name", "value", "title", "item", "v", "w", "c"];
    for (const k of keysFirst) {
      if (k in x) {
        const s = findFirstStringDeep(x[k], depth + 1);
        if (s) return s;
      }
    }
    // その他のキーも総当たり
    for (const k of Object.keys(x)) {
      const s = findFirstStringDeep(x[k], depth + 1);
      if (s) return s;
    }
  }
  return "";
}

function normalizeText(x) {
  const s = findFirstStringDeep(x);
  return (s || "").trim();
}

/* ===== Render ===== */
function clearBox(el) { if (el) el.innerHTML = ""; }

function renderCheckboxList(container, rawItems, defaultChecked) {
  clearBox(container);
  if (!container) return;

  const items = Array.isArray(rawItems) ? rawItems : [];
  const seen = new Set();
  let count = 0;

  for (const raw of items) {
    const text = normalizeText(raw);
    if (!text) continue;

    // [object Object] という「文字列」自体も消す（事故防止）
    if (text === "[object Object]") continue;

    if (seen.has(text)) continue;
    seen.add(text);
    count++;

    const label = document.createElement("label");
    label.className = "flex items-start gap-2 text-sm";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!defaultChecked;
    cb.className = "mt-1 h-4 w-4";

    const span = document.createElement("span");
    span.textContent = text;

    label.appendChild(cb);
    label.appendChild(span);
    container.appendChild(label);
  }

  if (count === 0) {
    container.innerHTML = '<div class="text-sm text-slate-500">（表示対象なし）</div>';
  }
}

function collectCheckedTexts(container) {
  if (!container) return [];
  const out = [];
  container.querySelectorAll("label").forEach((label) => {
    const cb = label.querySelector("input[type=checkbox]");
    if (!cb || !cb.checked) return;
    const span = label.querySelector("span");
    const text = (span?.textContent || "").trim();
    if (text) out.push(text);
  });
  return out;
}

/* ===== SharePoint由来：選択リスト ===== */
async function loadSelectOptions() {
  if (!selectListBox) return;

  selectListBox.innerHTML = '<div class="text-sm text-slate-500">選択リストを読み込み中…</div>';

  const res = await fetch("/api/inspection?op=select_options", { method: "GET" });
  if (!res.ok) {
    selectListBox.innerHTML = '<div class="text-sm text-red-600">選択リストの取得に失敗しました</div>';
    return;
  }

  const data = await res.json();
  const rawOptions = Array.isArray(data.options) ? data.options : [];

  // 初期は全チェック（要件どおり）
  renderCheckboxList(selectListBox, rawOptions, true);
}

/* ===== 抽出API（op名フォールバック） ===== */
async function callExtractAPI(payload) {
  // まず新しいop
  let r = await fetch("/api/inspection?op=extract_text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // 動いていた前のopへ戻す（ここが重要）
  if (!r.ok) {
    r = await fetch("/api/inspection?op=extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`AI抽出に失敗しました${t ? " (" + t + ")" : ""}`);
  }
  return await r.json();
}

/* ===== Extract ===== */
btnExtract?.addEventListener("click", async () => {
  if (isBusy) return;

  try {
    setBusy(true, "PDFを解析中…");

    currentPdfFile = pdfInput.files && pdfInput.files[0] ? pdfInput.files[0] : currentPdfFile;
    if (!currentPdfFile) throw new Error("PDFを選択してください");

    const pdfText = await extractPdfTextInBrowser(currentPdfFile);

    setBusy(true, "AIで抽出中…");

    const obj = await callExtractAPI({ filename: currentPdfFile.name, text: pdfText });

    // 型番/製品名：未入力なら自動反映
    if (modelInput && !modelInput.value.trim() && obj.model) modelInput.value = obj.model;
    if (productInput && !productInput.value.trim() && obj.product) productInput.value = obj.product;

    // 抽出結果：仕様/動作は未チェック、付属品は全チェック（前の状態）
    renderCheckboxList(specBox, obj.specText || obj.spec || [], false);
    renderCheckboxList(opBox, obj.opText || obj.op || [], false);

    // 付属品：取扱説明書しか出ない問題 → サーバ返り値のキー揺れも吸収
    // accText/acc/accessories のどれでも拾う
    const acc = obj.accText || obj.acc || obj.accessories || [];
    renderCheckboxList(accBox, acc, true);
  } catch (e) {
    console.error(e);
    alert(e.message || "AI抽出に失敗しました");
  } finally {
    setBusy(false);
  }
});

/* ===== 生成API（op名フォールバック） ===== */
async function callGenerateAPI(payload) {
  // まず generate_text
  let r = await fetch("/api/inspection?op=generate_text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  // 前に動いていた可能性があるopへ
  if (!r.ok) {
    r = await fetch("/api/inspection?op=generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`生成に失敗しました${t ? " (" + t + ")" : ""}`);
  }
  return r;
}

/* ===== Generate ===== */
btnGenerate?.addEventListener("click", async () => {
  if (isBusy) return;

  try {
    setBusy(true, "Excel生成中…");

    currentPdfFile = pdfInput.files && pdfInput.files[0] ? pdfInput.files[0] : currentPdfFile;
    if (!currentPdfFile) throw new Error("PDFを選択してください");

    // サーバ側が text 必須の作りでも通るように送る
    const pdfText = await extractPdfTextInBrowser(currentPdfFile);

    const selectedLabels = [];
    if (lblLiion?.checked) selectedLabels.push("リチウムイオン電池");
    if (lblLegal?.checked) selectedLabels.push("法的対象(PSE/無線)");

    // SharePoint選択リスト（チェックされたもののみ）
    selectedLabels.push(...collectCheckedTexts(selectListBox));

    // 抽出結果（チェックされたもののみ）
    const aiPicked = [
      ...collectCheckedTexts(specBox).map((t) => ({ kind: "仕様", text: t })),
      ...collectCheckedTexts(opBox).map((t) => ({ kind: "動作", text: t })),
      ...collectCheckedTexts(accBox).map((t) => ({ kind: "付属品", text: t })),
    ];

    const payload = {
      filename: currentPdfFile.name,
      text: pdfText,
      selectedLabels,
      aiPicked,
      model: modelInput?.value || "",
      product: productInput?.value || "",
    };

    const r = await callGenerateAPI(payload);
    const blob = await r.blob();

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "inspection.xlsx"; // サーバが Content-Disposition を付けるなら上書きされます
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
    alert(e.message || "生成に失敗しました");
  } finally {
    setBusy(false);
  }
});

/* ===== init ===== */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadSelectOptions();
  } catch (e) {
    console.error(e);
    if (selectListBox) {
      selectListBox.innerHTML = '<div class="text-sm text-red-600">選択リストの取得に失敗しました</div>';
    }
  }
});
