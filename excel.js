// excel.js — Excel翻訳ツール フロントロジック（確定版）
// 前提：excel.html 側で SheetJS (XLSX) を読み込み済み。

let EXCEL_workbook = null;
let EXCEL_worksheet = null;
let EXCEL_fileName = null;
let advancedLocked = true;

// ---------- ユーティリティ ----------

function setStatus(message) {
  const el = document.getElementById("status-text");
  if (el) el.textContent = message;
  console.log("[excel] " + message);
}

function showError(message) {
  console.error("[excel] ERROR:", message);
  const modal = document.getElementById("error-modal");
  const msgEl = document.getElementById("error-message");
  if (modal && msgEl) {
    msgEl.textContent = message;
    modal.style.display = "flex";
  } else {
    alert(message);
  }
}

function hideErrorModal() {
  const modal = document.getElementById("error-modal");
  if (modal) modal.style.display = "none";
}

function toggleUI(disabled) {
  const ids = [
    "excel-file",
    "sheet-select",
    "to-lang",
    "source-column",
    "header-row",
    "start-row",
    "translate-btn",
    "unlock-advanced-btn",
  ];
  ids.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled && id !== "unlock-advanced-btn";
  });
}

// 詳細設定のロック状態反映
function updateAdvancedLockUI() {
  const inputs = [
    document.getElementById("source-column"),
    document.getElementById("header-row"),
    document.getElementById("start-row"),
  ];
  const btn = document.getElementById("unlock-advanced-btn");

  inputs.forEach((el) => {
    if (!el) return;
    el.disabled = advancedLocked;
    el.classList.toggle("editable", !advancedLocked);
    if (advancedLocked) {
      el.classList.add("locked-input");
    } else {
      el.classList.remove("locked-input");
    }
  });

  if (btn) {
    btn.textContent = advancedLocked
      ? "詳細設定を編集する"
      : "詳細設定をロックする";
  }
}

// ---------- ファイル読み込み & シート選択 ----------

function onWorkbookLoaded(workbook, fileName) {
  EXCEL_workbook = workbook;
  EXCEL_fileName = fileName.replace(/\.xlsx$/i, "");

  const sheetSelect = document.getElementById("sheet-select");
  if (sheetSelect) {
    sheetSelect.innerHTML = "";
    workbook.SheetNames.forEach((name, idx) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      if (idx === 0) opt.selected = true;
      sheetSelect.appendChild(opt);
    });

    const firstSheetName = workbook.SheetNames[0];
    EXCEL_worksheet = workbook.Sheets[firstSheetName];
    setStatus(`ファイル読込完了: シート「${firstSheetName}」`);

    sheetSelect.onchange = (e) => {
      const name = e.target.value;
      EXCEL_worksheet = workbook.Sheets[name];
      setStatus(`シート変更: 「${name}」`);
    };
  }
}

function handleFileSelected(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array", cellStyles: true });
      onWorkbookLoaded(wb, file.name);
    } catch (err) {
      console.error(err);
      showError("Excelファイルの読み込みに失敗しました。");
    }
  };
  reader.onerror = () => {
    showError("Excelファイルの読み込み中にエラーが発生しました。");
  };
  reader.readAsArrayBuffer(file);
}

function setupDragAndDrop() {
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("excel-file");
  if (!dropZone || !fileInput) return;

  ["dragenter", "dragover"].forEach((evtName) => {
    dropZone.addEventListener(evtName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("drag-over");
    });
  });

  ["dragleave", "drop"].forEach((evtName) => {
    dropZone.addEventListener(evtName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (evtName === "dragleave") {
        dropZone.classList.remove("drag-over");
      }
      if (evtName === "drop") {
        dropZone.classList.remove("drag-over");
        const file = e.dataTransfer && e.dataTransfer.files[0];
        if (!file) return;
        fileInput.files = e.dataTransfer.files;
        handleFileSelected({ target: fileInput });
      }
    });
  });
}

// ---------- 翻訳対象行の収集 ----------

function collectRowsToTranslate() {
  if (!EXCEL_worksheet) {
    showError("先にExcelファイルを読み込み、シートを選択してください。");
    return null;
  }

  const ref = EXCEL_worksheet["!ref"];
  if (!ref) {
    showError("シートにデータがありません。");
    return null;
  }
  const range = XLSX.utils.decode_range(ref);

  const headerRowInput = document.getElementById("header-row");
  const startRowInput = document.getElementById("start-row");

  const headerRow = parseInt(headerRowInput?.value || "1", 10) || 1;
  const startRow =
    parseInt(startRowInput?.value || String(headerRow + 1), 10) ||
    headerRow + 1;

  // 対象列は常に「最右列」
  const sourceColIndex = range.e.c;
  const targetColIndex = sourceColIndex + 1;

  const rows = [];
  const rowIndices = [];

  for (let r = startRow; r <= range.e.r + 1; r++) {
    const cellRef = XLSX.utils.encode_cell({
      c: sourceColIndex,
      r: r - 1,
    });
    const cell = EXCEL_worksheet[cellRef];
    const value = cell ? cell.v : "";
    const text = (value == null ? "" : String(value)).replace(/\n/g, "|||");
    rows.push(text);
    rowIndices.push(r);
  }

  return {
    rows,
    rowIndices,
    sourceColIndex,
    targetColIndex,
    headerRow,
  };
}

// ---------- API呼び出し ----------

async function callExcelTranslateAPI(rows, toLang) {
  const res = await fetch("/api/excel-translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows, toLang }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[excel] API error:", res.status, text);
    throw new Error(
      "サーバー側の翻訳処理に失敗しました。（HTTP " + res.status + "）"
    );
  }

  const data = await res.json();
  if (!data || !Array.isArray(data.translations)) {
    console.error("[excel] Unexpected API response:", data);
    throw new Error("サーバーから不正な形式の応答が返されました。");
  }
  if (data.translations.length !== rows.length) {
    console.error(
      "[excel] length mismatch",
      data.translations.length,
      rows.length
    );
    throw new Error("翻訳結果の件数が一致しませんでした。");
  }
  return data.translations;
}

// ---------- 書き込み（幅・書式・格子コピー＋ヘッダ） ----------

function writeTranslationsToSheet(info, translations, toLang) {
  const { rowIndices, sourceColIndex, targetColIndex, headerRow } = info;
  const ws = EXCEL_worksheet;
  if (!ws) throw new Error("ワークシートが存在しません。");

  // 各行のセル書き込み（元セルのスタイルをコピー）
  rowIndices.forEach((rowNumber, idx) => {
    const srcRef = XLSX.utils.encode_cell({
      c: sourceColIndex,
      r: rowNumber - 1,
    });
    const tgtRef = XLSX.utils.encode_cell({
      c: targetColIndex,
      r: rowNumber - 1,
    });

    const srcCell = ws[srcRef];
    const translated = (translations[idx] ?? "").replace(/\|\|\|/g, "\n");

    if (srcCell) {
      ws[tgtRef] = {
        ...srcCell, // フォント・罫線・塗りつぶしなどをコピー
        v: translated,
        w: undefined,
      };
    } else {
      ws[tgtRef] = {
        t: "s",
        v: translated,
      };
    }
  });

  // 列幅コピー（!cols）
  const cols = ws["!cols"] || [];
  ws["!cols"] = cols;
  cols[targetColIndex] = cols[sourceColIndex]
    ? { ...cols[sourceColIndex] }
    : { wch: 40 };

  // 見出し行の「翻訳」と「スリーアール／メーカー」
  const headerRowIndex = headerRow - 1;
  const srcHeaderRef = XLSX.utils.encode_cell({
    c: sourceColIndex,
    r: headerRowIndex,
  });
  const tgtHeaderRef = XLSX.utils.encode_cell({
    c: targetColIndex,
    r: headerRowIndex,
  });
  const labelRef = XLSX.utils.encode_cell({
    c: targetColIndex + 1,
    r: headerRowIndex,
  });

  const srcHeaderCell = ws[srcHeaderRef] || { t: "s" };

  // 「翻訳」ヘッダ
  ws[tgtHeaderRef] = {
    ...srcHeaderCell,
    v: "翻訳",
    w: undefined,
  };

  // 翻訳言語に応じて「スリーアール」 or 「メーカー」
  const labelText = toLang === "ja" ? "スリーアール" : "メーカー";
  ws[labelRef] = {
    ...srcHeaderCell,
    v: labelText,
    w: undefined,
  };

  // ラベル列（翻訳列の右隣）の列幅もコピー
  cols[targetColIndex + 1] = cols[sourceColIndex]
    ? { ...cols[sourceColIndex] }
    : { wch: 20 };

  setStatus("翻訳結果を書き込みました。");
}

// ---------- ダウンロード ----------

function downloadUpdatedWorkbook(toLang) {
  if (!EXCEL_workbook) {
    showError("ワークブックが存在しません。");
    return;
  }
  const wbout = XLSX.write(EXCEL_workbook, {
    bookType: "xlsx",
    type: "array",
    cellStyles: true,
  });
  const blob = new Blob([wbout], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const suffix = toLang ? "_" + toLang : "_translated";
  a.href = url;
  a.download = (EXCEL_fileName || "translated") + suffix + ".xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- メイン処理 ----------

async function handleTranslateClick() {
  try {
    if (!EXCEL_workbook || !EXCEL_worksheet) {
      showError("先にExcelファイルとシートを選択してください。");
      return;
    }

    const toLangSelect = document.getElementById("to-lang");
    const toLang = toLangSelect ? toLangSelect.value : "";
    if (!toLang) {
      showError("翻訳言語を選択してください。");
      return;
    }

    const info = collectRowsToTranslate();
    if (!info) return;

    const { rows } = info;
    if (rows.length === 0) {
      showError("翻訳対象のセルがありません。");
      return;
    }

    toggleUI(true);
    setStatus(`翻訳中… 全 ${rows.length} 行`);

    const translations = await callExcelTranslateAPI(rows, toLang);

    writeTranslationsToSheet(info, translations, toLang);
    downloadUpdatedWorkbook(toLang);
    setStatus("翻訳処理が完了しました。");
  } catch (err) {
    console.error(err);
    showError(
      "翻訳処理中にエラーが発生しました。\n\n" +
        (err.message || String(err))
    );
  } finally {
    toggleUI(false);
  }
}

// ---------- 初期化 ----------

document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("excel-file");
  const translateBtn = document.getElementById("translate-btn");
  const unlockBtn = document.getElementById("unlock-advanced-btn");
  const errorClose = document.getElementById("error-close");

  if (fileInput) {
    fileInput.addEventListener("change", handleFileSelected);
  }
  if (translateBtn) {
    translateBtn.addEventListener("click", handleTranslateClick);
  }
  if (unlockBtn) {
    unlockBtn.addEventListener("click", () => {
      advancedLocked = !advancedLocked;
      updateAdvancedLockUI();
    });
  }
  if (errorClose) {
    errorClose.addEventListener("click", hideErrorModal);
  }

  setupDragAndDrop();
  updateAdvancedLockUI();
  setStatus("Excelファイルを選択してください。");
});
