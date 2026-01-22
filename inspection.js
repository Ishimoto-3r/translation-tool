// inspection.js（全文）
// - PDF D&D / クリック選択
// - ⑤ 選択リスト（/api/inspection?op=select_options）を取得し、全チェックで表示
// - ③ 型番/製品名の入力をヘッダで送信
// - ④ 出力ファイル名はAPI側で「検品リスト_型番_製品名」
// - PDFはバイナリ送信（413回避）

let pdfFile = null;

function $(id) {
  return document.getElementById(id);
}

function setStatus(msg) {
  const el = $("status");
  if (el) el.textContent = msg || "";
}

function showWarnings(list) {
  const box = $("warnings");
  if (!box) return;

  const warnings = Array.isArray(list) ? list : [];
  if (warnings.length === 0) {
    box.innerHTML = "";
    box.style.display = "none";
    return;
  }

  box.style.display = "block";
  box.innerHTML =
    `<div style="font-weight:700; margin-bottom:6px;">警告</div>` +
    `<ul style="margin:0; padding-left:18px;">` +
    warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("") +
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

// ====== ⑤ 選択リスト（デフォルト全チェック） ======
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
    for (const label of options) {
      const row = document.createElement("label");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "8px";
      row.style.padding = "4px 0";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true; // ★デフォルト全チェック
      cb.dataset.label = label;

      const span = document.createElement("span");
      span.textContent = label;

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

  // 既存固定チェック（name="labels" か name="labelCheckbox" を拾う）
  const fixed =
    document.querySelectorAll('input[type="checkbox"][name="labels"]:checked');
  const fixed2 =
    document.querySelectorAll('input[type="checkbox"][name="labelCheckbox"]:checked');

  [...fixed, ...fixed2].forEach((cb) => {
    if (cb.value) labels.push(cb.value);
  });

  // ⑤ 選択リスト（selectListBox内）
  document.querySelectorAll('#selectListBox input[type="checkbox"]').forEach((cb) => {
    if (cb.checked && cb.dataset.label) labels.push(cb.dataset.label);
  });

  // 重複除去（順序維持）
  const seen = new Set();
  return labels.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

// ====== PDF取り込み ======
function setPdf(file) {
  pdfFile = file;

  const btn = $("run");
  if (btn) btn.disabled = !pdfFile;

  // 表示（dropZone内にファイル名が出る想定があるなら、適宜）
  const dz = $("dropZone");
  if (dz && pdfFile) {
    // 既存UIのテキストを壊したくないので、data属性だけ入れる
    dz.dataset.filename = pdfFile.name;
  }
}

function handleFiles(files) {
  if (!files || files.length === 0) return;
  const f = files[0];
  if (!f) return;

  if (!/pdf$/i.test(f.name) && f.type !== "application/pdf") {
    alert("PDFを選択してください。");
    return;
  }
  setPdf(f);
  setStatus(`PDF選択: ${f.name} (${Math.round(f.size / 1024)} KB)`);
}

// ====== 実行 ======
async function run() {
  const btn = $("run");
  if (btn) btn.disabled = true;

  setStatus("生成中…");
  showWarnings([]);

  try {
    if (!pdfFile) throw new Error("PDFが未選択です");

    const model = $("modelInput") ? $("modelInput").value : "";
    const product = $("productInput") ? $("productInput").value : "";

    const labels = collectSelectedLabels();

    // PDFをバイナリで送る（413回避）
    const ab = await pdfFile.arrayBuffer();

    const res = await fetch("/api/inspection", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "x-filename": encodeURIComponent(pdfFile.name || "manual.pdf"),
        "x-selected-labels": encodeURIComponent(JSON.stringify(labels)),
        // ③④：型番/製品名
        "x-model": encodeURIComponent(model || ""),
        "x-product": encodeURIComponent(product || ""),
      },
      body: ab,
    });

    if (!res.ok) {
      const j = await res.json().catch(() => null);
      const msg = j?.detail ? String(j.detail) : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    // 警告
    const warnings = decodeWarningsFromHeader(res);
    showWarnings(warnings);

    // ダウンロード
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") || "";
    const name = (() => {
      // RFC5987: filename*=UTF-8''xxx
      const m = cd.match(/filename\*\=UTF-8''([^;]+)/i);
      if (m && m[1]) return decodeURIComponent(m[1]);
      // fallback
      return "検品リスト.xlsx";
    })();

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);

    setStatus("完了しました");
  } catch (e) {
    console.error(e);
    setStatus("エラーが発生しました");
    alert("生成に失敗しました。\n" + (e?.message ? e.message : String(e)));
  } finally {
    if (btn) btn.disabled = !pdfFile;
  }
}

// ====== 初期化 ======
document.addEventListener("DOMContentLoaded", () => {
  // ⑤ 選択肢を取得して表示
  loadSelectOptions();

  // D&D
  const dropZone = $("dropZone");
  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList?.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList?.remove("dragover");
    });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList?.remove("dragover");
      handleFiles(e.dataTransfer.files);
    });

    // クリックでfileInputを開く
    dropZone.addEventListener("click", () => {
      const fi = $("fileInput");
      if (fi) fi.click();
    });
  }

  // fileInput
  const fileInput = $("fileInput");
  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      handleFiles(e.target.files);
    });
  }

  // 実行ボタン
  const runBtn = $("run");
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.addEventListener("click", run);
  }
});
