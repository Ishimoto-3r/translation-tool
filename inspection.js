/* =========================================================
   inspection.js（全文）
   - 選択リスト：/api/inspection?op=select_options から取得して表示（全チェック）
   - [object Object] 防止：返り値が string / object 混在でも必ず文字列化して描画
   - pdf.js：ESM import（cdnjs 不使用）
   - 進捗表示 + 二重押し防止（UIロック）
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

/* ===== state ===== */
let currentPdfFile = null;
let isBusy = false;

/* ===== UI lock ===== */
function setBusy(on, msg = "") {
  isBusy = on;

  pdfInput.disabled = on;
  btnExtract.disabled = on;
  btnGenerate.disabled = on;

  if (lblLiion) lblLiion.disabled = on;
  if (lblLegal) lblLegal.disabled = on;

  // リスト操作も禁止
  [selectListBox, specBox, opBox, accBox].forEach((box) => {
    if (!box) return;
    box.querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.disabled = on));
  });

  if (!progress) return;
  if (on) {
    progress.textContent = msg || "処理中…";
    progress.classList.remove("hidden");
  } else {
    progress.classList.add("hidden");
    progress.textContent = "";
  }
}

/* ===== file select ===== */
pdfInput.addEventListener("change", () => {
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

/* ===== normalize to string (★ここが [object Object] 根絶) ===== */
function optionToText(x) {
  if (x == null) return "";
  if (typeof x === "string") return x.trim();
  if (typeof x === "number" || typeof x === "boolean") return String(x);

  // よくあるキー候補を優先
  const candidates = ["text", "label", "name", "value", "title", "item"];
  for (const k of candidates) {
    if (x && typeof x[k] === "string" && x[k].trim()) return x[k].trim();
  }
  // {c:"xxx"} のようなケース
  if (x && typeof x.c === "string" && x.c.trim()) return x.c.trim();

  // 最後の保険：JSON化（ただし表示用なので短く）
  try {
    const s = JSON.stringify(x);
    return s && s !== "{}" ? s : "";
  } catch {
    return "";
  }
}

/* ===== rendering ===== */
function clearBox(el) {
  if (el) el.innerHTML = "";
}

function renderCheckboxList(container, rawItems, defaultChecked) {
  clearBox(container);
  if (!container) return;

  const items = Array.isArray(rawItems) ? rawItems : [];
  const seen = new Set();

  for (const raw of items) {
    const text = optionToText(raw);
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);

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

  if (container.children.length === 0) {
    container.innerHTML = '<div class="text-sm text-slate-500">（表示対象なし）</div>';
  }
}

function collectCheckedTexts(container) {
  if (!container) return [];
  const out = [];
  container.querySelectorAll("label").forEach((label) => {
    const cb = label.querySelector("input[type=checkbox]");
    if (!cb || !cb.checked) return;

    // span のみを拾う（label.textContent だと余計な空白が混ざる）
    const span = label.querySelector("span");
    const text = (span?.textContent || "").trim();
    if (text) out.push(text);
  });
  return out;
}

/* ===== select options load (SharePoint) ===== */
async function loadSelectOptions() {
  if (!selectListBox) return;

  selectListBox.innerHTML = '<div class="text-sm text-slate-500">選択リストを読み込み中…</div>';

  const res = await fetch("/api/inspection?op=select_options", { method: "GET" });
  if (!res.ok) {
    selectListBox.innerHTML = '<div class="text-sm text-red-600">選択リストの取得に失敗しました</div>';
    return;
  }

  const data = await res.json();
  const options = Array.isArray(data.options) ? data.options : [];

  // 初期は全チェック
  renderCheckboxList(selectListBox, options, true);
}

/* ===== Extract ===== */
btnExtract.addEventListener("click", async () => {
  if (isBusy) return;

  try {
    setBusy(true, "PDFを解析中…");

    currentPdfFile = pdfInput.files && pdfInput.files[0] ? pdfInput.files[0] : currentPdfFile;
    if (!currentPdfFile) throw new Error("PDFを選択してください");

    const pdfText = await extractPdfTextInBrowser(currentPdfFile);

    setBusy(true, "AIで抽出中…");

    const r = await fetch("/api/inspection?op=extract_text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: currentPdfFile.name, text: pdfText }),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`AI抽出に失敗しました${t ? " (" + t + ")" : ""}`);
    }

    const obj = await r.json();

    // 型番/製品名：未入力なら自動反映
    if (modelInput && !modelInput.value.trim() && obj.model) modelInput.value = obj.model;
    if (productInput && !productInput.value.trim() && obj.product) productInput.value = obj.product;

    // 抽出結果：仕様/動作は未チェック、付属品は全チェック
    renderCheckboxList(specBox, obj.specText || [], false);
    renderCheckboxList(opBox, obj.opText || [], false);
    renderCheckboxList(accBox, obj.accText || [], true);
  } catch (e) {
    console.error(e);
    alert(e.message || "AI抽出に失敗しました");
  } finally {
    setBusy(false);
  }
});

/* ===== Generate ===== */
btnGenerate.addEventListener("click", async () => {
  if (isBusy) return;

  try {
    setBusy(true, "Excel生成中…");

    currentPdfFile = pdfInput.files && pdfInput.files[0] ? pdfInput.files[0] : currentPdfFile;
    if (!currentPdfFile) throw new Error("PDFを選択してください");

    // サーバ側が text 必須（413回避のためPDF本体は送らず、ブラウザ抽出テキストを送る）
    const pdfText = await extractPdfTextInBrowser(currentPdfFile);

    // 固定ラベル
    const selectedLabels = [];
    if (lblLiion?.checked) selectedLabels.push("リチウムイオン電池");
    if (lblLegal?.checked) selectedLabels.push("法的対象(PSE/無線)");

    // SharePoint由来の選択リスト（チェックされたもののみ）
    selectedLabels.push(...collectCheckedTexts(selectListBox));

    // 抽出結果（チェックされたもののみ）
    const aiPicked = [
      ...collectCheckedTexts(specBox).map((t) => ({ kind: "仕様", text: t, isTitle: false })),
      ...collectCheckedTexts(opBox).map((t) => ({ kind: "動作", text: t, isTitle: false })),
      ...collectCheckedTexts(accBox).map((t) => ({ kind: "付属品", text: t, isTitle: false })),
    ];

    const payload = {
      filename: currentPdfFile.name,
      text: pdfText,
      selectedLabels,
      aiPicked,
      model: modelInput?.value || "",
      product: productInput?.value || "",
    };

    const r = await fetch("/api/inspection?op=generate_text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`生成に失敗しました${t ? " (" + t + ")" : ""}`);
    }

    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "inspection.xlsx"; // Content-Disposition が効く想定。保険で付与。
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
