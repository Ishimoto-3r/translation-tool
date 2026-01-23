// inspection.js（全文置き換え）
let pdfFile = null;

let selectionItems = []; // SharePointの「選択リスト」C列（表示用）
let extracted = {
  model: "",
  productName: "",
  specs: [],     // string[]
  ops: [],       // { title: string, items: string[] }[]
  accs: []       // string[]
};

const $ = (id) => document.getElementById(id);

function showError(msg) {
  const box = $("errorBox");
  box.textContent = msg;
  box.classList.remove("hidden");
}

function clearError() {
  const box = $("errorBox");
  box.textContent = "";
  box.classList.add("hidden");
}

function setBusy(on, title = "処理中", step = "", msg = "処理しています。画面は操作できません。", hint = "") {
  const ov = $("overlay");
  $("overlayTitle").textContent = title;
  $("overlayStep").textContent = step || "";
  $("overlayMsg").textContent = msg || "";
  $("overlayHint").textContent = hint || "";
  ov.classList.toggle("show", !!on);

  // 入力をまとめて無効化（二重押し防止）
  const disableIds = [
    "pdfInput","dropzone","btnExtract","btnGenerate",
    "lblLiion","lblLegal","modelInput","productInput"
  ];
  for (const id of disableIds) {
    const el = $(id);
    if (!el) continue;
    if (id === "dropzone") {
      el.style.pointerEvents = on ? "none" : "auto";
      el.style.opacity = on ? "0.7" : "1";
    } else {
      el.disabled = !!on;
    }
  }

  // 選択リストも無効化
  document.querySelectorAll('input[data-select-item="1"]').forEach((cb) => {
    cb.disabled = !!on;
  });
  // 抽出リストも無効化
  document.querySelectorAll('input[data-extract="1"]').forEach((cb) => {
    cb.disabled = !!on;
  });
}

function normalizeText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  // [object Object] 対策：絶対にオブジェクトをそのまま表示しない
  try { return JSON.stringify(v); } catch { return String(v); }
}

function setPdfStatus() {
  if (!pdfFile) {
    $("pdfStatus").textContent = "未選択";
    $("pdfNameHint").textContent = "※PDFをAI抽出に使用します";
    return;
  }
  $("pdfStatus").textContent = `選択中: ${pdfFile.name} (${Math.round(pdfFile.size/1024)} KB)`;
  $("pdfNameHint").textContent = pdfFile.name;
}

function renderCheckboxList(containerId, items, { defaultChecked = false, dataAttr = {} } = {}) {
  const wrap = $(containerId);
  wrap.innerHTML = "";

  if (!items || items.length === 0) {
    wrap.textContent = "（抽出なし）";
    return;
  }

  const frag = document.createDocumentFragment();

  for (let i = 0; i < items.length; i++) {
    const txt = normalizeText(items[i]).trim();
    if (!txt) continue;

    const label = document.createElement("label");
    label.className = "flex items-start gap-2";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "h-4 w-4 mt-0.5";
    cb.checked = !!defaultChecked;

    // data attributes
    for (const [k, v] of Object.entries(dataAttr)) {
      cb.dataset[k] = v;
    }
    cb.dataset.value = txt;
    cb.dataset.extract = "1";

    const span = document.createElement("span");
    span.textContent = txt;

    label.appendChild(cb);
    label.appendChild(span);
    frag.appendChild(label);
  }

  wrap.appendChild(frag);
}

function renderOpGroups(containerId, groups) {
  const wrap = $(containerId);
  wrap.innerHTML = "";

  if (!groups || groups.length === 0) {
    wrap.textContent = "（抽出なし）";
    return;
  }

  const frag = document.createDocumentFragment();

  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi] || {};
    const title = normalizeText(g.title).trim();
    const items = Array.isArray(g.items) ? g.items : [];

    // title（チェックあり・太字・下線） ※Excel投入時は太字/下線しない（API側で解除）
    if (title) {
      const titleRow = document.createElement("label");
      titleRow.className = "flex items-start gap-2 mt-2";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "h-4 w-4 mt-0.5";
      cb.checked = false; // 初期は未チェック
      cb.dataset.extract = "1";
      cb.dataset.kind = "opTitle";
      cb.dataset.group = String(gi);
      cb.dataset.value = title;

      const span = document.createElement("span");
      span.innerHTML = `<span style="font-weight:700;text-decoration:underline;">${escapeHtml(title)}</span>`;

      titleRow.appendChild(cb);
      titleRow.appendChild(span);
      frag.appendChild(titleRow);
    }

    // items
    for (let ii = 0; ii < items.length; ii++) {
      const it = normalizeText(items[ii]).trim();
      if (!it) continue;

      const row = document.createElement("label");
      row.className = "flex items-start gap-2 ml-5";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "h-4 w-4 mt-0.5";
      cb.checked = false; // 初期は未チェック
      cb.dataset.extract = "1";
      cb.dataset.kind = "opItem";
      cb.dataset.group = String(gi);
      cb.dataset.value = it;

      const span = document.createElement("span");
      span.textContent = it;

      row.appendChild(cb);
      row.appendChild(span);
      frag.appendChild(row);
    }
  }

  wrap.appendChild(frag);

  // タイトルチェック＝配下を全ON/OFF（視認性と操作性）
  wrap.querySelectorAll('input[data-kind="opTitle"]').forEach((tcb) => {
    tcb.addEventListener("change", () => {
      const g = tcb.dataset.group;
      wrap.querySelectorAll(`input[data-kind="opItem"][data-group="${g}"]`).forEach((icb) => {
        icb.checked = tcb.checked;
      });
    });
  });

  // 配下が1つでもONならタイトルもON（Excelにタイトルも入れる要件対応）
  wrap.querySelectorAll('input[data-kind="opItem"]').forEach((icb) => {
    icb.addEventListener("change", () => {
      const g = icb.dataset.group;
      const items = Array.from(wrap.querySelectorAll(`input[data-kind="opItem"][data-group="${g}"]`));
      const anyOn = items.some(x => x.checked);
      const t = wrap.querySelector(`input[data-kind="opTitle"][data-group="${g}"]`);
      if (t) t.checked = anyOn;
    });
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

async function api(op, payload) {
  const res = await fetch(`/api/inspection?op=${encodeURIComponent(op)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${txt}`);
  }
  return res.json();
}

// pdf.js (unpkg) を module で読み込み、ブラウザでテキスト抽出する（PDF丸投げしない＝413回避）
async function extractPdfTextInBrowser(file) {
  const ab = await file.arrayBuffer();

  // dynamic import
  const pdfjsLib = await import("https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.worker.mjs";

  const loadingTask = pdfjsLib.getDocument({ data: ab });
  const pdf = await loadingTask.promise;

  // 全ページからテキスト抽出（重いPDFもあるので上限を設ける：まずは最大30p）
  const maxPages = Math.min(pdf.numPages, 30);
  let out = [];
  for (let p = 1; p <= maxPages; p++) {
    $("overlayStep").textContent = `PDF解析 ${p}/${maxPages}`;
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const strings = tc.items.map((it) => (it && it.str ? it.str : "")).filter(Boolean);
    const text = strings.join(" ");
    if (text.trim()) {
      out.push(`--- page ${p} ---\n${text}`);
    }
  }
  return out.join("\n\n");
}


async function renderPdfImagesInBrowser(file, maxPages = 5) {
  const ab = await file.arrayBuffer();
  const pdfjsLib = await import("https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://unpkg.com/pdfjs-dist@4.10.38/build/pdf.worker.mjs";

  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  const pages = Math.min(pdf.numPages, maxPages);
  const images = [];

  for (let p = 1; p <= pages; p++) {
    $("overlayStep").textContent = `PDF画像化 ${p}/${pages}`;
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.25 });
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    // JPEGで軽量化（payload肥大を抑える）
    const dataUrl = canvas.toDataURL("image/jpeg", 0.65);
    images.push(dataUrl);
  }
  return images;
}


function getSelectedLabels() {
  const labels = [];
  if ($("lblLiion").checked) labels.push("リチウムイオン電池");
  if ($("lblLegal").checked) labels.push("法的対象(PSE/無線)");
  return labels;
}

function renderSelectionList() {
  const wrap = $("selectList");
  wrap.innerHTML = "";

  if (!selectionItems || selectionItems.length === 0) {
    wrap.textContent = "（選択リストなし）";
    return;
  }

  const frag = document.createDocumentFragment();
  for (const txt0 of selectionItems) {
    const txt = normalizeText(txt0).trim();
    if (!txt) continue;

    const label = document.createElement("label");
    label.className = "flex items-start gap-2";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "h-4 w-4 mt-0.5";
    cb.checked = true; // 選択リストは「不要なものだけ外す」運用
    cb.dataset.selectItem = "1";
    cb.dataset.value = txt;

    const span = document.createElement("span");
    span.textContent = txt;

    label.appendChild(cb);
    label.appendChild(span);
    frag.appendChild(label);
  }
  wrap.appendChild(frag);
}

function getSelectedSelectionItems() {
  return Array.from(document.querySelectorAll('input[data-select-item="1"]'))
    .filter(cb => cb.checked)
    .map(cb => cb.dataset.value)
    .filter(Boolean);
}

function getCheckedExtracted() {
  const spec = [];
  const acc = [];
  const opTitles = [];
  const opItems = [];

  document.querySelectorAll('input[data-extract="1"]').forEach((cb) => {
    if (!cb.checked) return;
    const kind = cb.dataset.kind || "";
    const v = (cb.dataset.value || "").trim();
    if (!v) return;

    if (kind === "opTitle") opTitles.push(v);
    else if (kind === "opItem") opItems.push(v);
    else {
      // specs/accs は containerごとに区別したいので、親のIDで判定
      const parent = cb.closest("#specList, #accList");
      if (parent && parent.id === "specList") spec.push(v);
      else if (parent && parent.id === "accList") acc.push(v);
      else {
        // 保険：入らないなら spec に寄せる
        spec.push(v);
      }
    }
  });

  return { spec, opTitles, opItems, acc };
}

async function loadMeta() {
  clearError();
  try {
    const r = await api("meta", {});
    selectionItems = Array.isArray(r.selectionItems) ? r.selectionItems : [];
    renderSelectionList();
  } catch (e) {
    showError("初期化に失敗しました: " + e.message);
    $("selectList").textContent = "読み込み失敗";
  }
}

async function runExtract() {
  clearError();
  if (!pdfFile) {
    showError("PDFが未選択です。");
    return;
  }

  try {
    setBusy(true, "AI抽出中", "準備", "PDFから仕様/動作/付属品/型番/製品名を抽出しています。", "PDF解析→AI抽出の順で実行します。");
    $("overlayBar").style.width = "25%";

    // ブラウザでPDFテキスト抽出（413回避）
    $("overlayStep").textContent = "PDF解析 0/0";
    const pdfText = await extractPdfTextInBrowser(pdfFile);
    $("overlayBar").style.width = "55%";

    // テキスト抽出できないPDF（文字がパス化/画像）対策：先頭数ページを画像化してAIへ渡す
    let pdfImages = [];
    if (!pdfText || pdfText.trim().length < 30) {
      pdfImages = await renderPdfImagesInBrowser(pdfFile, 5);
    }

    // 未入力ならPDF抽出結果で埋める（API側でも補完するが、ここで明示）
    const model = $("modelInput").value.trim();
    const productName = $("productInput").value.trim();

    $("overlayStep").textContent = "AI抽出";
    const r = await api("extract", {
      pdfText: pdfText || "",
      pdfImages,
      fileName: pdfFile.name,
      modelHint: model || "",
      productHint: productName || ""
    });

    $("overlayBar").style.width = "85%";

    extracted.model = normalizeText(r.model || "").trim();
    extracted.productName = normalizeText(r.productName || "").trim();
    extracted.specs = Array.isArray(r.specs) ? r.specs.map(normalizeText) : [];
    extracted.ops = Array.isArray(r.ops) ? r.ops : [];
    extracted.accs = Array.isArray(r.accs) ? r.accs.map(normalizeText) : [];

    // フォーム自動反映（未入力時のみ）
    if (!$("modelInput").value.trim() && extracted.model) $("modelInput").value = extracted.model;
    if (!$("productInput").value.trim() && extracted.productName) $("productInput").value = extracted.productName;

    // 仕様/付属品：初期未チェック
    renderCheckboxList("specList", extracted.specs, { defaultChecked: false });

    // 動作：タイトル+アイテム。初期未チェック（タイトル連動あり）
    renderOpGroups("opList", extracted.ops);

    // 付属品：初期全チェック（要件）
    renderCheckboxList("accList", extracted.accs, { defaultChecked: true });

    $("overlayBar").style.width = "100%";
  } catch (e) {
    showError("AI抽出に失敗しました: " + e.message);
  } finally {
    setBusy(false);
  }
}

async function runGenerate() {
  clearError();

  const model = $("modelInput").value.trim();
  const productName = $("productInput").value.trim();

  if (!model || !productName) {
    showError("型番と製品名を入力してください（未入力なら先に「PDFをAIに読み取らせる」を実行してください）。");
    return;
  }

  const selectedLabels = getSelectedLabels();
  const selectedSelectionItems = getSelectedSelectionItems();
  const checked = getCheckedExtracted();

  try {
    setBusy(true, "Excel生成中", "準備", "テンプレートに差し込み、Excelを生成しています。", "SharePointテンプレ取得→差し込み→書式調整→DL");
    $("overlayBar").style.width = "25%";

    const r = await api("generate", {
      model,
      productName,
      selectedLabels,
      selectedSelectionItems,
      specText: checked.spec,
      opTitles: checked.opTitles,
      opItems: checked.opItems,
      accText: checked.acc
    });

    $("overlayBar").style.width = "90%";

    if (!r || !r.fileBase64) {
      throw new Error("生成結果が不正です。");
    }

    const bin = Uint8Array.from(atob(r.fileBase64), c => c.charCodeAt(0));
    const blob = new Blob([bin], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = r.fileName || `検品リスト_${model}_${productName}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);

    $("overlayBar").style.width = "100%";
  } catch (e) {
    showError("Excel生成に失敗しました: " + e.message);
  } finally {
    setBusy(false);
  }
}

function initPdfDrop() {
  const dz = $("dropzone");
  const input = $("pdfInput");

  dz.addEventListener("click", () => input.click());

  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("border-blue-400");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("border-blue-400"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("border-blue-400");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type === "application/pdf") {
      pdfFile = f;
      setPdfStatus();
    } else {
      showError("PDFファイルを指定してください。");
    }
  });

  input.addEventListener("change", () => {
    const f = input.files && input.files[0];
    if (f && f.type === "application/pdf") {
      pdfFile = f;
      setPdfStatus();
    } else if (f) {
      showError("PDFファイルを指定してください。");
    }
  });

  // ラベルはデフォルトOFF（要件：両方ONになってしまう不具合対策）
  $("lblLiion").checked = false;
  $("lblLegal").checked = false;
}

window.addEventListener("DOMContentLoaded", async () => {
  initPdfDrop();
  setPdfStatus();

  $("btnExtract").addEventListener("click", runExtract);
  $("btnGenerate").addEventListener("click", runGenerate);

  await loadMeta();
});
