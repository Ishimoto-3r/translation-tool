// inspection.js（全文）
console.log("[inspection] front version: v8");

let pdfFile = null;
let busy = false;

let aiExtract = { specText: [], opText: [], accText: [] };

const $ = (id) => document.getElementById(id);


// pdf.js 初期化（大きいPDFの413回避用：ブラウザ側でテキスト抽出して送信）
function initPdfJs() {
  if (!window.pdfjsLib) return false;
  try {
    // worker 指定（CDN版）
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.js";
    return true;
  } catch {
    return false;
  }
}

async function extractPdfTextClient(file, maxPages = 20, maxChars = 35000) {
  if (!initPdfJs()) throw new Error("pdf.js が読み込めませんでした。");
  const ab = await file.arrayBuffer();
  const loadingTask = window.pdfjsLib.getDocument({ data: ab });
  const pdf = await loadingTask.promise;
  const n = Math.min(pdf.numPages || 1, maxPages);
  let out = "";
  for (let p = 1; p <= n; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const strings = (content.items || []).map((it) => it.str || "").filter(Boolean);
    out += strings.join(" ") + "\n";
    if (out.length >= maxChars) break;
  }
  // 余計な連続空白を整理
  out = out.replace(/\s+/g, " ").trim();
  return out;
}


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
    if (el.tagName === "INPUT" || el.tagName === "BUTTON") {
      el.disabled = busy;
    }
    if (id === "selectListBox" || id.startsWith("ai")) {
      el.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.disabled = busy);
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

  const nameEl = $("pdfName");
  if (nameEl) nameEl.textContent = file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : "";

  const extractBtn = $("extractBtn");
  if (extractBtn) extractBtn.disabled = !pdfFile || busy;

  const genBtn = $("generateBtn");
  if (genBtn) genBtn.disabled = !pdfFile || busy;
}

async async function loadSelectOptions() {
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

function renderAiBox(boxId, kind, lines) {
  const box = $(boxId);
  if (!box) return;
  box.innerHTML = "";

  if (!lines || lines.length === 0) {
    box.innerHTML = `<div class="text-xs text-slate-500">（抽出なし）</div>`;
    return;
  }

  for (const raw of lines) {
    const line = toText(raw).trim();
    if (!line) continue;

    const row = document.createElement("label");
    row.className = "flex items-start gap-2 py-1";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = false; // 初期未チェック
    cb.dataset.kind = kind;
    cb.dataset.text = line;
    cb.className = "mt-1";

    const span = document.createElement("span");
    span.textContent = line;

    row.appendChild(cb);
    row.appendChild(span);
    box.appendChild(row);
  }
}

function collectAiSelected() {
  const picked = [];
  ["aiSpecBox", "aiOpBox", "aiAccBox"].forEach((id) => {
    const box = $(id);
    if (!box) return;
    box.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      if (cb.checked && cb.dataset.kind && cb.dataset.text) {
        picked.push({ kind: cb.dataset.kind, text: cb.dataset.text });
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
  if (!cur && next) el.value = next; // ★空のときだけ自動入力
}

async function runExtract() {
  if (!pdfFile) {
    alert("PDFを選択してください。");
    return;
  }

  setBusy(true, "PDFを解析しています（AI抽出）…");
  showStatus("AI抽出中…");

  const fileName = pdfFile.name || "manual.pdf";
  const SIZE_LIMIT = 4 * 1024 * 1024; // Vercelの受信上限対策（概ね4MB）

  // 送信方式：
  // - 小さいPDF：PDFバイナリを送る（従来通り）
  // - 大きいPDF：ブラウザでテキスト抽出してJSON送信（413回避）
  async function postAsPdfBinary() {
    const ab = await pdfFile.arrayBuffer();
    const res = await fetch("/api/inspection?op=extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "x-filename": encodeURIComponent(fileName),
      },
      body: ab,
    });
    return res;
  }

  async function postAsJsonText() {
    const pdfText = await extractPdfTextClient(pdfFile);
    if (!pdfText) throw new Error("PDFテキストを取得できませんでした。");
    const res = await fetch("/api/inspection?op=extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, pdfText }),
    });
    return res;
  }

  try {
    let res;
    if (pdfFile.size > SIZE_LIMIT) {
      res = await postAsJsonText();
    } else {
      res = await postAsPdfBinary();
      if (res.status === 413) {
        // 念のため：小さく見えても413ならテキスト送信へ切替
        res = await postAsJsonText();
      }
    }

    if (!res.ok) {
      const j = await res.json().catch(() => null);
      const msg = j?.detail ? String(j.detail) : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    const data = await res.json();

    aiExtract = {
      specText: Array.isArray(data.specText) ? data.specText : [],
      opText: Array.isArray(data.opText) ? data.opText : [],
      accText: Array.isArray(data.accText) ? data.accText : [],
    };

    // 型番/製品名が返ってきたら反映（手入力は維持）
    if (data.model && $("modelInput") && !$("modelInput").value) $("modelInput").value = String(data.model);
    if (data.productName && $("productNameInput") && !$("productNameInput").value) $("productNameInput").value = String(data.productName);

    renderAiExtract();
    showStatus("AI抽出が完了しました。");
  } catch (e) {
    console.error(e);
    alert(`AI抽出に失敗しました。\n${e?.message || e}`);
    showStatus("AI抽出に失敗しました。");
  } finally {
    setBusy(false);
  }
}

  setBusy(true, "PDFを解析しています（AI抽出）…");
  showStatus("AI抽出中…");

  try {
    const ab = await pdfFile.arrayBuffer();

    const res = await fetch("/api/inspection?op=extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "x-filename": encodeURIComponent(pdfFile.name || "manual.pdf"),
      },
      body: ab,
    });

    if (!res.ok) {
      const j = await res.json().catch(() => null);
      const msg = j?.detail ? String(j.detail) : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    const data = await res.json();

    aiExtract = {
      specText: Array.isArray(data.specText) ? data.specText : [],
      opText: Array.isArray(data.opText) ? data.opText : [],
      accText: Array.isArray(data.accText) ? data.accText : [],
    };

    renderAiBox("aiSpecBox", "仕様", aiExtract.specText);
    renderAiBox("aiOpBox", "動作", aiExtract.opText);
    renderAiBox("aiAccBox", "付属品", aiExtract.accText);

    // ★ 型番・製品名を自動入力（未入力時のみ）
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

    aiExtract = { specText: [], opText: [], accText: [] };
    renderAiBox("aiSpecBox", "仕様", []);
    renderAiBox("aiOpBox", "動作", []);
    renderAiBox("aiAccBox", "付属品", []);

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

    aiExtract = { specText: [], opText: [], accText: [] };
    renderAiBox("aiSpecBox", "仕様", []);
    renderAiBox("aiOpBox", "動作", []);
    renderAiBox("aiAccBox", "付属品", []);

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

    const ab = await pdfFile.arrayBuffer();

    const res = await fetch("/api/inspection?op=generate", {
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

  renderAiBox("aiSpecBox", "仕様", []);
  renderAiBox("aiOpBox", "動作", []);
  renderAiBox("aiAccBox", "付属品", []);
});
