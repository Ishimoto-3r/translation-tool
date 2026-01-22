// inspection.js
// PDF D&D → base64 → /api/inspection → 日本語Excel DL

const $ = (id) => document.getElementById(id);

let pdfFile = null; // File

function setStatus(msg) {
  $("status").textContent = msg || "";
}

function showWarnings(warnings) {
  const box = $("warnBox");
  const list = $("warnList");
  list.innerHTML = "";

  if (!warnings || warnings.length === 0) {
    box.style.display = "none";
    return;
  }
  for (const w of warnings) {
    const li = document.createElement("li");
    li.textContent = w;
    list.appendChild(li);
  }
  box.style.display = "block";
}

function decodeWarningsFromHeader(res) {
  try {
    const raw = res.headers.get("x-warnings");
    if (!raw) return [];
    const json = decodeURIComponent(raw);
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function getSelectedLabels() {
  const labels = [];
  if ($("lbl-li").checked) labels.push("リチウムイオン電池");
  if ($("lbl-law").checked) labels.push("法的対象(PSE/無線)");
  return labels;
}

function updateUI() {
  $("fileinfo").textContent = pdfFile ? `${pdfFile.name} (${Math.round(pdfFile.size / 1024)} KB)` : "未選択";
  $("run").disabled = !pdfFile;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("FileReadError"));
    fr.onload = () => {
      const s = String(fr.result || "");
      // data:application/pdf;base64,XXXX
      const idx = s.indexOf("base64,");
      if (idx >= 0) return resolve(s.slice(idx + "base64,".length));
      reject(new Error("Base64ParseError"));
    };
    fr.readAsDataURL(file);
  });
}

async function run() {
  const btn = $("run");
  btn.disabled = true;
  setStatus("生成中…");
  showWarnings([]);

  try {
    if (!pdfFile) throw new Error("PDFが未選択です");

    const labels = getSelectedLabels();

    // ★ base64化しない（413回避）
    const ab = await pdfFile.arrayBuffer();

    const res = await fetch("/api/inspection", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "x-filename": encodeURIComponent(pdfFile.name || "manual.pdf"),
        "x-selected-labels": encodeURIComponent(JSON.stringify(labels)),
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
    const name = (() => {
      const m = cd.match(/filename\*\=UTF-8''([^;]+)/i);
      if (m && m[1]) return decodeURIComponent(m[1]);
      return "検品リスト_日本語.xlsx";
    })();

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);

    setStatus("完了しました");
  } catch (e) {
    console.error(e);
    setStatus("エラーが発生しました");
    alert("生成に失敗しました。\n" + (e?.message ? e.message : String(e)));
  } finally {
    btn.disabled = !pdfFile;
  }
}


function setPdf(file) {
  if (!file) return;
  if (file.type !== "application/pdf") {
    alert("PDFのみ対応です");
    return;
  }
  pdfFile = file;
  updateUI();
}

window.addEventListener("DOMContentLoaded", () => {
  const dz = $("dropzone");
  const fp = $("filepicker");

  dz.addEventListener("click", () => fp.click());
  fp.addEventListener("change", () => setPdf(fp.files && fp.files[0]));

  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("dragover");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    setPdf(f);
  });

  $("run").addEventListener("click", run);
  updateUI();
});
