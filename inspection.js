// inspection.js（全文）

let pdfFile = null;
let busy = false;

let extractedPdfText = ""; // ← pdf.jsで抽出したテキスト（413回避用）

let aiExtract = {
  specText: [],
  opText: [],
  accText: [],
  opGroups: null, // [{title, items}]
};

const $ = (id) => document.getElementById(id);

function toText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    if (typeof v.text === "string") return v.text;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function setBusy(on, msg) {
  busy = !!on;

  const overlay = $("overlay");
  const overlayMsg = $("overlayMsg");
  if (overlay) overlay.classList.toggle("show", busy);
  if (overlayMsg) overlayMsg.textContent = msg || "";

  const ids = [
    "modelInput", "productInput", "pdfDrop", "pdfInput",
    "extractBtn", "generateBtn",
    "selectListBox", "aiSpecBox", "aiOpBox", "aiAccBox"
  ];
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    if (el.tagName === "INPUT" || el.tagName === "BUTTON") el.disabled = busy;

    if (id === "selectListBox" || id.startsWith("ai")) {
      el.querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.disabled = busy));
    }
    if (id === "pdfDrop") {
      el.style.pointerEvents = busy ? "none" : "auto";
      el.style.opacity = busy ? "0.65" : "1";
    }
  }

  document.querySelectorAll('input[type="checkbox"][name="labels"]').forEach((cb) => {
    cb.disabled = busy;
  });
}

function showStatus(msg) {
  const el = $("statusText");
  if (el) el.textContent = msg || "";
}

function setPdf(file) {
  pdfFile = file;
  extractedPdfText = ""; // ← PDF変えたらテキスト抽出は無効化

  const nameEl = $("pdfName");
  if (nameEl) nameEl.textContent = file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : "";

  const extractBtn = $("extractBtn");
  if (extractBtn) extractBtn.disabled = !pdfFile || busy;

  const genBtn = $("generateBtn");
  if (genBtn) genBtn.disabled = !pdfFile || busy;
}

async function loadSelectOptions() {
  const box = $("selectListBox");
  if (!box) return;

  box.textContent = "読み込み中…";

  try {
    const res = await fetch("/api/inspection?op=select_options");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const options = Array.isArray(data.options) ? data.options : [];

    if (options.length === 0) {
      box.textContent = "（選択肢がありません）";
      return;
    }

    box.innerHTML = "";
    for (const raw of options) {
      const text = toText(raw).trim();
      if (!text) continue;

      const row = document.createElement("label");
      row.className = "flex items-start gap-2 py-1";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.dataset.value = text;
      cb.className = "mt-1";

      const span = document.createElement("span");
      span.textContent = text;

      row.appendChild(cb);
      row.appendChild(span);
      box.appendChild(row);
    }
  } catch (e) {
    console.error(e);
    box.textContent = "選択肢の取得に失敗しました";
  }
}

function collectSelectedLabels() {
  const labels = [];

  document.querySelectorAll('input[type="checkbox"][name="labels"]:checked')
    .forEach((cb) => { if (cb.value) labels.push(cb.value); });

  document.querySelectorAll('#selectListBox input[type="checkbox"]')
    .forEach((cb) => { if (cb.checked && cb.dataset.value) labels.push(cb.dataset.value); });

  const seen = new Set();
  return labels.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

// 動作の不要抽出（安全注意/禁止/中止）を弾く（表示側の二重保険）
function isOperationNoise(s) {
  const t = (s || "").toString().trim();
  if (!t) return true;
  if (/^(安全|注意|警告|禁止|中止|危険)/.test(t)) return true;
  if (/(使用しない|使用を中止|しないでください|禁止|分解|改造|修理しない|感電|火災|高温|濡れた手|水にかけない)/.test(t)) return true;
  if (/安全.*取扱.*注意/.test(t)) return true;
  return false;
}

function renderSimpleList(boxId, kind, lines, defaultChecked) {
  const box = $(boxId);
  if (!box) return;
  box.innerHTML = "";

  const arr = (lines || [])
    .map((x) => toText(x).trim())
    .filter((x) => x.length > 0);

  const filtered =
    kind === "動作"
      ? arr.filter((x) => !isOperationNoise(x))
      : arr;

  if (filtered.length === 0) {
    box.innerHTML = `<div class="text-xs text-slate-500">（抽出なし）</div>`;
    return;
  }

  for (const line of filtered) {
    const row = document.createElement("label");
    row.className = "flex items-start gap-2 py-1";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!defaultChecked;
    cb.dataset.kind = kind;
    cb.dataset.text = line;
    cb.dataset.isTitle = "0";
    cb.className = "mt-1";

    const span = document.createElement("span");
    span.textContent = line;

    row.appendChild(cb);
    row.appendChild(span);
    box.appendChild(row);
  }
}

// 動作：グループ（タイトル＋items）表示（タイトルは太字＋下線、チェックあり）
function renderOpGrouped(opGroups) {
  const box = $("aiOpBox");
  if (!box) return;
  box.innerHTML = "";

  const groups = Array.isArray(opGroups) ? opGroups : [];
  const normalized = [];

  for (const g of groups) {
    const title = toText(g?.title).trim();
    const items = (Array.isArray(g?.items) ? g.items : [])
      .map((x) => toText(x).trim())
      .filter((x) => x.length > 0)
      .filter((x) => !isOperationNoise(x));

    const okTitle = title && !isOperationNoise(title) ? title : "";
    if (!okTitle && items.length === 0) continue;
    normalized.push({ title: okTitle, items });
  }

  if (normalized.length === 0) {
    box.innerHTML = `<div class="text-xs text-slate-500">（抽出なし）</div>`;
    return;
  }

  for (const g of normalized) {
    if (g.title) {
      const rowT = document.createElement("label");
      rowT.className = "flex items-start gap-2 py-1";

      const cbT = document.createElement("input");
      cbT.type = "checkbox";
      cbT.checked = false; // 動作は初期未チェック
      cbT.dataset.kind = "動作";
      cbT.dataset.text = g.title;
      cbT.dataset.isTitle = "1";
      cbT.className = "mt-1";

      const spanT = document.createElement("span");
      spanT.textContent = g.title;
      spanT.className = "font-bold underline decoration-slate-400 underline-offset-4";

      rowT.appendChild(cbT);
      rowT.appendChild(spanT);
      box.appendChild(rowT);
    }

    for (const line of g.items) {
      const row = document.createElement("label");
      row.className = "flex items-start gap-2 py-1";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = false;
      cb.dataset.kind = "動作";
      cb.dataset.text = line;
      cb.dataset.isTitle = "0";
      cb.className = "mt-1";

      const span = document.createElement("span");
      span.textContent = line;

      row.appendChild(cb);
      row.appendChild(span);
      box.appendChild(row);
    }
  }
}

function collectAiSelected() {
  const picked = [];
  ["aiSpecBox", "aiOpBox", "aiAccBox"].forEach((id) => {
    const box = $(id);
    if (!box) return;
    box.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      if (cb.checked && cb.dataset.kind && cb.dataset.text) {
        picked.push({
          kind: cb.dataset.kind,
          text: cb.dataset.text,
          isTitle: cb.dataset.isTitle === "1",
        });
      }
    });
  });
  return picked;
}

function setIfEmpty(inputId, newVal) {
  const el = $(inputId);
  if (!el) return;
  const cur = (el.value || "").trim();
  const next = (newVal || "").toString().trim();
  if (!cur && next) el.value = next;
}

// ===== 413回避：pdf.jsでテキスト抽出 =====
async function extractPdfTextInBrowser(file) {
  if (!window.pdfjsLib) throw new Error("pdf.js が読み込まれていません");

  const ab = await file.arrayBuffer();
  const loadingTask = window.pdfjsLib.getDocument({ data: ab });
  const pdf = await loadingTask.promise;

  let out = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const txt = await page.getTextContent();
    const line = txt.items.map((it) => it.str).join(" ");
    out += line + "\n";
  }
  return out.trim();
}

async function callExtractTextApi(filename, text) {
  const res = await fetch("/api/inspection?op=extract_text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, text }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    const msg = j?.detail ? String(j.detail) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return await res.json();
}

async function runExtract() {
  if (!pdfFile) {
    alert("PDFを選択してください。");
    return;
  }

  setBusy(true, "PDFを解析しています（AI抽出）…");
  showStatus("AI抽出中…");

  try {
    // 1) まずブラウザでPDF→テキスト抽出（サイズ依存で413回避）
    setBusy(true, "PDFからテキストを抽出しています…");
    const text = await extractPdfTextInBrowser(pdfFile);
    extractedPdfText = text;

    // 2) 抽出テキストをAPIへ（JSON）
    setBusy(true, "抽出テキストをAIに解析させています…");
    const data = await callExtractTextApi(pdfFile.name || "manual.pdf", extractedPdfText);

    aiExtract = {
      specText: Array.isArray(data.specText) ? data.specText : [],
      opText: Array.isArray(data.opText) ? data.opText : [],
      accText: Array.isArray(data.accText) ? data.accText : [],
      opGroups: Array.isArray(data.opGroups) ? data.opGroups : null,
    };

    renderSimpleList("aiSpecBox", "仕様", aiExtract.specText, false);

    if (aiExtract.opGroups && aiExtract.opGroups.length > 0) {
      renderOpGrouped(aiExtract.opGroups);
    } else {
      renderSimpleList("aiOpBox", "動作", aiExtract.opText, false);
    }

    renderSimpleList("aiAccBox", "付属品", aiExtract.accText, true);

    setIfEmpty("modelInput", data.model);
    setIfEmpty("productInput", data.product);

    showStatus("AI抽出が完了しました（必要な項目だけチェックしてください）");
  } catch (e) {
    console.error(e);
    showStatus("AI抽出に失敗しました");
    alert("AI抽出に失敗しました。\n" + (e?.message || String(e)));
  } finally {
    setBusy(false, "");
    const extractBtn = $("extractBtn");
    if (extractBtn) extractBtn.disabled = !pdfFile;
  }
}

function setupPdfPicker() {
  const drop = $("pdfDrop");
  const input = $("pdfInput");
  if (!drop || !input) return;

  drop.addEventListener("click", () => {
    if (busy) return;
    input.click();
  });

  input.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      alert("PDFを選択してください。");
      return;
    }
    setPdf(file);

    renderSimpleList("aiSpecBox", "仕様", [], false);
    renderSimpleList("aiOpBox", "動作", [], false);
    renderSimpleList("aiAccBox", "付属品", [], true);

    showStatus("PDFを選択しました。必要なら「PDFをAIに読み取らせる」を押してください。");
  });

  drop.addEventListener("dragover", (e) => {
    if (busy) return;
    e.preventDefault();
    drop.classList.add("bg-slate-100");
  });

  drop.addEventListener("dragleave", () => {
    drop.classList.remove("bg-slate-100");
  });

  drop.addEventListener("drop", (e) => {
    if (busy) return;
    e.preventDefault();
    drop.classList.remove("bg-slate-100");

    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      alert("PDFをドロップしてください。");
      return;
    }
    setPdf(file);

    renderSimpleList("aiSpecBox", "仕様", [], false);
    renderSimpleList("aiOpBox", "動作", [], false);
    renderSimpleList("aiAccBox", "付属品", [], true);

    showStatus("PDFをドロップしました。必要なら「PDFをAIに読み取らせる」を押してください。");
  });
}

async function runGenerate() {
  if (!pdfFile) {
    alert("PDFを選択してください。");
    return;
  }

  setBusy(true, "検品リストExcelを生成しています…");
  showStatus("生成中…");

  try {
    const model = $("modelInput")?.value || "";
    const product = $("productInput")?.value || "";
    const selectedLabels = collectSelectedLabels();
    const aiPicked = collectAiSelected();

    // 生成も413回避：テキストがあるならJSONで送る
    const useTextMode = !!extractedPdfText;

    let res;
    if (useTextMode) {
      res = await fetch("/api/inspection?op=generate_text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: pdfFile.name || "manual.pdf",
          text: extractedPdfText,
          selectedLabels,
          aiPicked,
          model,
          product,
        }),
      });
    } else {
      // 旧方式（万一の保険）
      const ab = await pdfFile.arrayBuffer();
      res = await fetch("/api/inspection?op=generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "x-filename": encodeURIComponent(pdfFile.name || "manual.pdf"),
          "x-selected-labels": encodeURIComponent(JSON.stringify(selectedLabels)),
          "x-ai-picked": encodeURIComponent(JSON.stringify(aiPicked)),
          "x-model": encodeURIComponent(model),
          "x-product": encodeURIComponent(product),
        },
        body: ab,
      });
    }

    if (!res.ok) {
      const j = await res.json().catch(() => null);
      const msg = j?.detail ? String(j.detail) : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") || "";
    const m = cd.match(/filename\*\=UTF-8''([^;]+)/i);
    const filename = m?.[1] ? decodeURIComponent(m[1]) : "検品リスト.xlsx";

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);

    showStatus("完了しました");
  } catch (e) {
    console.error(e);
    showStatus("生成に失敗しました");
    alert("生成に失敗しました。\n" + (e?.message || String(e)));
  } finally {
    setBusy(false, "");
    setPdf(pdfFile);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setupPdfPicker();
  loadSelectOptions();

  const extractBtn = $("extractBtn");
  if (extractBtn) {
    extractBtn.disabled = true;
    extractBtn.addEventListener("click", runExtract);
  }

  const genBtn = $("generateBtn");
  if (genBtn) {
    genBtn.disabled = true;
    genBtn.addEventListener("click", runGenerate);
  }

  renderSimpleList("aiSpecBox", "仕様", [], false);
  renderSimpleList("aiOpBox", "動作", [], false);
  renderSimpleList("aiAccBox", "付属品", [], true);
});
