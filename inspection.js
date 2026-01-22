// inspection.js（全文）

let pdfFile = null;
let busy = false;

// 抽出結果を保持（{specText:[], opText:[], accText:[] }）
let aiExtract = { specText: [], opText: [], accText: [] };

const $ = (id) => document.getElementById(id);

function setBusy(on, msg) {
  busy = !!on;

  const overlay = $("overlay");
  const overlayMsg = $("overlayMsg");
  if (overlay) overlay.classList.toggle("show", busy);
  if (overlayMsg) overlayMsg.textContent = msg || "";

  // 画面内操作をまとめて無効化
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
    // checkboxもまとめて無効
    if (id === "selectListBox" || id.startsWith("ai")) {
      el.querySelectorAll("input[type=checkbox]").forEach((cb) => cb.disabled = busy);
    }
    // dropzoneはpointer-eventsで抑止
    if (id === "pdfDrop") {
      el.style.pointerEvents = busy ? "none" : "auto";
      el.style.opacity = busy ? "0.65" : "1";
    }
  }

  // 固定ラベルも無効
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

  // PDFがあれば「読み取り」ボタンを有効化
  const extractBtn = $("extractBtn");
  if (extractBtn) extractBtn.disabled = !pdfFile || busy;

  // 生成ボタンは「PDFがあり、かつ（抽出チェック or 選択リスト or 固定ラベル）いずれかが選ばれる可能性がある」前提でPDFのみで有効化
  const genBtn = $("generateBtn");
  if (genBtn) genBtn.disabled = !pdfFile || busy;
}

// ===== ⑤ 選択リスト（C列） =====
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
    for (const text of options) {
      const row = document.createElement("label");
      row.className = "flex items-start gap-2 py-1";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;            // 選択リストは全チェック
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

  // 固定ラベル
  document.querySelectorAll('input[type="checkbox"][name="labels"]:checked')
    .forEach((cb) => { if (cb.value) labels.push(cb.value); });

  // 選択リスト（C列テキスト）
  document.querySelectorAll('#selectListBox input[type="checkbox"]')
    .forEach((cb) => { if (cb.checked && cb.dataset.value) labels.push(cb.dataset.value); });

  // 重複除去（順序維持）
  const seen = new Set();
  return labels.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

// ===== ② AI抽出（別枠：初期未チェック） =====
function renderAiBox(boxId, kind, lines) {
  const box = $(boxId);
  if (!box) return;
  box.innerHTML = "";

  if (!lines || lines.length === 0) {
    box.innerHTML = `<div class="text-xs text-slate-500">（抽出なし）</div>`;
    return;
  }

  for (const line of lines) {
    const row = document.createElement("label");
    row.className = "flex items-start gap-2 py-1";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = false; // ★デフォルト未チェック
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

async function runExtract() {
  if (!pdfFile) {
    alert("PDFを選択してください。");
    return;
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

// ===== ① PDFピッカー =====
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

    // 新しいPDFなら抽出表示はリセット
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
    const aiPicked = collectAiSelected(); // ② チェックされた抽出項目のみ

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
    setPdf(pdfFile); // ボタン状態を復元
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

  // AI枠を初期化（空表示）
  renderAiBox("aiSpecBox", "仕様", []);
  renderAiBox("aiOpBox", "動作", []);
  renderAiBox("aiAccBox", "付属品", []);
});
