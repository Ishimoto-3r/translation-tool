// inspection.js（全文）

let pdfFile = null;
let busy = false;

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
    if (el.tagName === "INPUT" || el.tagName === "BUTTON") {
      el.disabled = busy;
    }
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
  // 見出しや注意喚起
  if (/^(安全|注意|警告|禁止|中止|危険)/.test(t)) return true;
  if (/(使用しない|使用を中止|しないでください|禁止|分解|改造|修理しない|感電|火災|高温|濡れた手|水にかけない)/.test(t)) return true;
  // 「安全・取扱注意（…）」系の括弧見出し
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

// 動作：グループ（タイトル＋items）表示（タイトルは太字＋下線）
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

    // タイトル自体もノイズなら捨てる
    const okTitle = title && !isOperationNoise(title) ? title : "";

    if (!okTitle && items.length === 0) continue;
    normalized.push({ title: okTitle, items });
  }

  if (normalized.length === 0) {
    box.innerHTML = `<div class="text-xs text-slate-500">（抽出なし）</div>`;
    return;
  }

  for (const g of normalized) {
    const title = g.title;

    if (title) {
      const rowT = document.createElement("label");
      rowT.className = "flex items-start gap-2 py-1";

      const cbT = document.createElement("input");
      cbT.type = "checkbox";
      cbT.checked = false; // 動作は初期未チェック（タイトルも同様）
      cbT.dataset.kind = "動作";
      cbT.dataset.text = title;
      cbT.dataset.isTitle = "1";
      cbT.className = "mt-1";

      const spanT = document.createElement("span");
      spanT.textContent = title;
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
      cb.checked = false; // 動作は初期未チェック
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
      opGroups: Array.isArray(data.opGroups) ? data.opGroups : null,
    };

    // 仕様：初期未チェック
    renderSimpleList("aiSpecBox", "仕様", aiExtract.specText, false);

    // 動作：opGroupsがあればタイトル＋itemsで描画（タイトルは下線）
    if (aiExtract.opGroups && aiExtract.opGroups.length > 0) {
      renderOpGrouped(aiExtract.opGroups);
    } else {
      renderSimpleList("aiOpBox", "動作", aiExtract.opText, false);
    }

    // 付属品：初期全チェック
    renderSimpleList("aiAccBox", "付属品", aiExtract.accText, true);

    // 型番・製品名を自動入力（未入力時のみ）
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

    // 表示クリア
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

    // 表示クリア
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

  renderSimpleList("aiSpecBox", "仕様", [], false);
  renderSimpleList("aiOpBox", "動作", [], false);
  renderSimpleList("aiAccBox", "付属品", [], true);
});
