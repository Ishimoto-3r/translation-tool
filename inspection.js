/* =========================================================
   inspection.js（全文）
   - pdf.js は ESM import（cdnjs 不使用）
   - 起動時に SharePoint由来の「選択リスト」を取得して表示（全チェック）
   - PDF抽出（仕様/動作/付属品）は未チェック、付属品は全チェック
   - 進捗表示 + 二重押し防止（ロック）
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

  // 画面操作禁止（最低限）
  pdfInput.disabled = on;
  btnExtract.disabled = on;
  btnGenerate.disabled = on;
  if (lblLiion) lblLiion.disabled = on;
  if (lblLegal) lblLegal.disabled = on;

  // 選択リストのチェック操作禁止
  if (selectListBox) {
    selectListBox.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.disabled = on;
    });
  }
  // 抽出結果のチェック操作禁止
  [specBox, opBox, accBox].forEach((box) => {
    if (!box) return;
    box.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.disabled = on;
    });
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

/* ===== File select ===== */
pdfInput?.addEventListener("change", () => {
  currentPdfFile = pdfInput.files && pdfInput.files[0] ? pdfInput.files[0] : null;
  if (fileName) {
    fileName.textContent = currentPdfFile ? currentPdfFile.name : "未選択";
  }
});

/* ===== PDF text extraction ===== */
async function extractPdfTextInBrowser(file) {
  if (!file) throw new Error("PDFが選択されていません");
  const pdfjsLib = await ensurePdfjs();

  const buffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;

  let text = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n";
  }
  return text;
}

/* ===== rendering helpers ===== */
function clearBox(el) {
  if (el) el.innerHTML = "";
}

function renderCheckboxList(container, items, defaultChecked) {
  clearBox(container);
  if (!container) return;

  const arr = Array.isArray(items) ? items : [];
  arr.forEach((labelText) => {
    const text = (labelText ?? "").toString().trim();
    if (!text) return;

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
  });
}

function collectCheckedTexts(container) {
  if (!container) return [];
  const out = [];
  container.querySelectorAll("label").forEach((label) => {
    const cb = label.querySelector("input[type=checkbox]");
    if (!cb) return;
    if (!cb.checked) return;
    const text = label.textContent.trim();
    if (text) out.push(text);
  });
  return out;
}

/* ===== SharePoint由来：選択リストの取得/描画 ===== */
async function loadSelectOptions() {
  if (!selectListBox) return;

  // placeholder
  selectListBox.innerHTML =
    '<div class="text-sm text-slate-500">選択リストを読み込み中…</div>';

  const res = await fetch("/api/inspection?op=select_options", { method: "GET" });
  if (!res.ok) {
    selectListBox.innerHTML =
      '<div class="text-sm text-red-600">選択リストの取得に失敗しました</div>';
    return;
  }

  const data = await res.json();
  const options = Array.isArray(data.options) ? data.options : [];

  // 全チェック（ユーザー要件）
  renderCheckboxList(selectListBox, options, true);
}

/* ===== Extract button ===== */
btnExtract?.addEventListener("click", async () => {
  if (isBusy) return;

  try {
    setBusy(true, "PDFを解析中…");

    currentPdfFile = pdfInput.files && pdfInput.files[0] ? pdfInput.files[0] : currentPdfFile;
    if (!currentPdfFile) throw new Error("PDFを選択してください");

    const pdfText = await extractPdfTextInBrowser(currentPdfFile);

    setBusy(true, "AIで抽出中…");

    // 413回避：PDFファイルは送らない。抽出済みテキストのみ送る
    const r = await fetch("/api/inspection?op=extract_text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: currentPdfFile.name,
        text: pdfText
      })
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`AI抽出に失敗しました ${t ? "(" + t + ")" : ""}`);
    }

    const obj = await r.json();

    // 型番/製品名：未入力なら自動反映（ユーザー要件）
    if (modelInput && !modelInput.value.trim() && obj.model) modelInput.value = obj.model;
    if (productInput && !productInput.value.trim() && obj.product) productInput.value = obj.product;

    // 抽出結果
    renderCheckboxList(specBox, obj.specText || [], false); // 初期未チェック
    renderCheckboxList(opBox, obj.opText || [], false);     // 初期未チェック
    renderCheckboxList(accBox, obj.accText || [], true);    // 付属品は全チェック（要件）
  } catch (e) {
    console.error(e);
    alert(e.message || "AI抽出に失敗しました");
  } finally {
    setBusy(false);
  }
});

/* ===== Generate button ===== */
btnGenerate?.addEventListener("click", async () => {
  if (isBusy) return;

  try {
    setBusy(true, "Excel生成中…");

    currentPdfFile = pdfInput.files && pdfInput.files[0] ? pdfInput.files[0] : currentPdfFile;
    if (!currentPdfFile) throw new Error("PDFを選択してください");

    // generate_text の仕様上 text が必須（バックエンドがチェックしているため）
    const pdfText = await extractPdfTextInBrowser(currentPdfFile);

    // ラベル2種（固定）
    const selectedLabels = [];
    if (lblLiion?.checked) selectedLabels.push("リチウムイオン電池");
    if (lblLegal?.checked) selectedLabels.push("法的対象(PSE/無線)");

    // SharePoint由来「選択リスト」（全チェック→不要のみ外す）
    const selectPicked = collectCheckedTexts(selectListBox);
    selectedLabels.push(...selectPicked);

    // 抽出結果（チェックされたものだけ）
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
      product: productInput?.value || ""
    };

    const r = await fetch("/api/inspection?op=generate_text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`生成に失敗しました ${t ? "(" + t + ")" : ""}`);
    }

    const blob = await r.blob();

    // ファイル名はサーバ側で Content-Disposition が付く想定
    // ただし付かない場合の保険
    const fallback = "inspection.xlsx";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fallback;
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
      selectListBox.innerHTML =
        '<div class="text-sm text-red-600">選択リストの取得に失敗しました</div>';
    }
  }
});
