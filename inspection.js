// inspection.js（全文）

let pdfFile = null;

const $ = (id) => document.getElementById(id);

function setPdf(file) {
  pdfFile = file;

  const nameEl = $("pdfName");
  if (nameEl) {
    nameEl.textContent = file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : "";
  }

  const btn = $("generateBtn");
  if (btn) btn.disabled = !pdfFile;
}

function showStatus(msg) {
  const el = $("statusText");
  if (el) el.textContent = msg || "";
}

function showWarnings(warnings) {
  const box = $("warningsBox");
  if (!box) return;

  const list = Array.isArray(warnings) ? warnings : [];
  if (list.length === 0) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  box.classList.remove("hidden");
  box.innerHTML =
    `<div class="font-bold mb-2">警告</div>` +
    `<ul class="list-disc pl-5 space-y-1">` +
    list.map((w) => `<li>${escapeHtml(w)}</li>`).join("") +
    `</ul>`;
}

function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function decodeWarningsFromHeader(res) {
  try {
    const h = res.headers.get("x-warnings");
    if (!h) return [];
    const json = decodeURIComponent(h);
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ②：選択リストは「検品項目リスト」A=選択リスト の C列を表示
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
      cb.checked = true; // デフォルト全チェック
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

  // 固定ラベル（name="labels"）
  document.querySelectorAll('input[type="checkbox"][name="labels"]:checked')
    .forEach((cb) => {
      if (cb.value) labels.push(cb.value);
    });

  // 選択リスト（C列テキスト）
  document.querySelectorAll('#selectListBox input[type="checkbox"]')
    .forEach((cb) => {
      if (cb.checked && cb.dataset.value) labels.push(cb.dataset.value);
    });

  // 重複除去（順序維持）
  const seen = new Set();
  return labels.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

// ①：D&D / クリック
function setupPdfPicker() {
  const drop = $("pdfDrop");
  const input = $("pdfInput");

  if (!drop || !input) return;

  // クリックで選択
  drop.addEventListener("click", () => input.click());

  // input選択
  input.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      alert("PDFを選択してください。");
      return;
    }
    setPdf(file);
    showStatus("PDFを選択しました");
  });

  // D&D
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("bg-slate-100");
  });

  drop.addEventListener("dragleave", () => {
    drop.classList.remove("bg-slate-100");
  });

  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("bg-slate-100");

    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
      alert("PDFをドロップしてください。");
      return;
    }
    setPdf(file);
    showStatus("PDFをドロップしました");
  });
}

async function runGenerate() {
  const btn = $("generateBtn");
  if (btn) btn.disabled = true;

  showStatus("生成中…");
  showWarnings([]);

  try {
    if (!pdfFile) throw new Error("PDFが未選択です");

    const model = $("modelInput")?.value || "";
    const product = $("productInput")?.value || "";
    const selected = collectSelectedLabels();

    const ab = await pdfFile.arrayBuffer();

    const res = await fetch("/api/inspection", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "x-filename": encodeURIComponent(pdfFile.name || "manual.pdf"),
        "x-selected-labels": encodeURIComponent(JSON.stringify(selected)),
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

    const warnings = decodeWarningsFromHeader(res);
    showWarnings(warnings);

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
    showStatus("エラーが発生しました");
    alert("生成に失敗しました。\n" + (e?.message || String(e)));
  } finally {
    if (btn) btn.disabled = !pdfFile;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  setupPdfPicker();
  loadSelectOptions();

  const btn = $("generateBtn");
  if (btn) {
    btn.disabled = true;
    btn.addEventListener("click", runGenerate);
  }
});
