let EXCEL_workbook = null;
let EXCEL_buffer = null;
let EXCEL_fileName = null;
let advancedLocked = true;

// ====== UI制御系 ======

function setStatus(message) {
  const el = document.getElementById("status-text");
  if (el) el.textContent = message;
  console.log("[excel] " + message);
}

function showLoading(show, total = 0, current = 0) {
  const overlay = document.getElementById("loading-overlay");
  const msg = document.getElementById("loading-detail");
  if (overlay) {
    overlay.style.display = show ? "flex" : "none";
    if (show && msg) {
      msg.textContent = total > 0 ? `${current} / ${total} 行完了` : "準備中...";
    }
  }
}

function showError(message) {
  console.error("[excel] ERROR:", message);
  showLoading(false);
  
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
  const ids = ["excel-file", "sheet-select", "to-lang", "source-column", "header-row", "start-row", "translate-btn"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  const unlockBtn = document.getElementById("unlock-advanced-btn");
  if(unlockBtn) unlockBtn.disabled = false;
}

function updateAdvancedLockUI() {
  const ids = ["source-column", "header-row", "start-row"];
  const btn = document.getElementById("unlock-advanced-btn");
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = advancedLocked;
    if (advancedLocked) {
      el.classList.add("locked-input");
      el.classList.remove("editable");
    } else {
      el.classList.remove("locked-input");
      el.classList.add("editable");
    }
  });
  if (btn) btn.textContent = advancedLocked ? "詳細設定を編集する" : "詳細設定をロックする";
}

// ====== ファイル読み込み (ExcelJS) ======

async function handleFileSelected(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;
  await loadExcelFile(file);
}

async function loadExcelFile(file) {
  try {
    EXCEL_fileName = file.name.replace(/\.xlsx$/i, "");
    const arrayBuffer = await file.arrayBuffer();
    EXCEL_buffer = arrayBuffer;

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);

    EXCEL_workbook = workbook;

    const sheetSelect = document.getElementById("sheet-select");
    sheetSelect.innerHTML = "";
    
    workbook.eachSheet((sheet, id) => {
      const opt = document.createElement("option");
      opt.value = sheet.name;
      opt.textContent = sheet.name;
      sheetSelect.appendChild(opt);
    });

    setStatus(`読込完了: ${file.name}`);
  } catch (err) {
    console.error(err);
    showError("Excelファイルの読み込みに失敗しました。\n" + err.message);
  }
}

function setupDragAndDrop() {
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("excel-file");
  if (!dropZone || !fileInput) return;

  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", (e) => { e.preventDefault(); dropZone.classList.remove("drag-over"); });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) {
      fileInput.files = e.dataTransfer.files;
      loadExcelFile(file);
    }
  });
}

// ====== データ抽出 ======

function getTargetSheet() {
  if (!EXCEL_workbook) return null;
  const select = document.getElementById("sheet-select");
  const sheetName = select.value;
  return EXCEL_workbook.getWorksheet(sheetName);
}

function collectRowsToTranslate(sheet) {
  const headerRowVal = parseInt(document.getElementById("header-row").value) || 5;
  const startRowVal = parseInt(document.getElementById("start-row").value) || 6;
  
  let maxCol = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber >= headerRowVal) {
      maxCol = Math.max(maxCol, row.cellCount); 
    }
  });

  const sourceColIndex = maxCol; 
  const targetColIndex = maxCol + 1;

  const rows = [];
  const rowIndices = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber >= startRowVal) {
      const cell = row.getCell(sourceColIndex);
      let text = "";
      if (cell.value && typeof cell.value === 'object') {
        text = cell.value.result || cell.value.text || "";
      } else {
        text = String(cell.value || "");
      }
      
      // 改行コードの置換
      text = text.replace(/\n/g, "|||");
      
      // ★ここが重要修正：空白のセルはリストに入れない（ズレ防止）
      if (text.trim() === "") {
        return; // スキップ
      }

      rows.push(text);
      rowIndices.push(rowNumber);
    }
  });

  return { rows, rowIndices, sourceColIndex, targetColIndex, headerRow: headerRowVal };
}

// ====== API呼び出し ======

async function callExcelTranslateAPI(rows, toLang, onProgress) {
  const BATCH_SIZE = 40;
  const allTranslations = [];
  const total = rows.length;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    
    const res = await fetch("/api/excel-translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: batch, toLang }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`サーバーエラー: ${text}`);
    }
    const data = await res.json();
    
    // バッチごとの整合性チェック
    if (!data.translations || data.translations.length !== batch.length) {
       throw new Error(`翻訳エラー：送信数(${batch.length})と受信数(${data.translations?.length})が一致しません。`);
    }

    allTranslations.push(...data.translations);

    if (onProgress) onProgress(Math.min(i + BATCH_SIZE, total), total);
  }
  return allTranslations;
}

// ====== 書き込み & ダウンロード ======

async function writeAndDownload(sheet, info, translations, toLang) {
  const { rowIndices, sourceColIndex, targetColIndex, headerRow } = info;

  const headerRowObj = sheet.getRow(headerRow);
  
  // ヘッダー：翻訳列
  const transHeaderCell = headerRowObj.getCell(targetColIndex);
  transHeaderCell.value = "翻訳";
  const srcHeaderCell = headerRowObj.getCell(sourceColIndex);
  transHeaderCell.style = srcHeaderCell.style;

  // ヘッダー：メーカー/スリーアール列
  const labelColIndex = targetColIndex + 1;
  const labelHeaderCell = headerRowObj.getCell(labelColIndex);
  labelHeaderCell.value = toLang === "ja" ? "スリーアール" : "メーカー";
  labelHeaderCell.style = srcHeaderCell.style;

  // データ書き込み（リストにある行だけ書き込む＝空白行は無視して飛ばす）
  rowIndices.forEach((rowNum, i) => {
    const row = sheet.getRow(rowNum);
    const srcCell = row.getCell(sourceColIndex);
    
    const transCell = row.getCell(targetColIndex);
    const labelCell = row.getCell(labelColIndex);

    const translatedText = (translations[i] || "").replace(/\|\|\|/g, "\n");
    
    transCell.value = translatedText;
    transCell.style = srcCell.style;

    labelCell.value = null; 
    labelCell.style = srcCell.style;
  });

  // 列幅コピー
  const srcCol = sheet.getColumn(sourceColIndex);
  const transCol = sheet.getColumn(targetColIndex);
  const labelCol = sheet.getColumn(labelColIndex);

  if (srcCol && srcCol.width) {
    transCol.width = srcCol.width;
    labelCol.width = srcCol.width;
  } else {
    transCol.width = 30;
    labelCol.width = 30;
  }

  const buffer = await EXCEL_workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement("a");
  a.href = url;
  a.download = (EXCEL_fileName || "download") + "_翻訳.xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ====== メイン処理 ======

async function handleTranslateClick() {
  if (!EXCEL_workbook) {
    showError("ファイルを選択してください");
    return;
  }

  const sheet = getTargetSheet();
  const toLang = document.getElementById("to-lang").value;

  try {
    toggleUI(true);
    showLoading(true, 0, 0);

    const info = collectRowsToTranslate(sheet);
    if (info.rows.length === 0) {
      throw new Error("翻訳対象のデータが見つかりませんでした（すべて空白の可能性があります）");
    }

    showLoading(true, info.rows.length, 0);
    
    const translations = await callExcelTranslateAPI(info.rows, toLang, (done, total) => {
      showLoading(true, total, done);
    });

    setStatus("Excel生成中...");
    await writeAndDownload(sheet, info, translations, toLang);
    
    showLoading(false);
    setStatus("完了");
    alert("翻訳が完了しました。\nファイルがダウンロードされます。");

  } catch (e) {
    showError(e.message);
  } finally {
    toggleUI(false);
    showLoading(false);
  }
}

// ====== 初期化 ======

document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("excel-file");
  if (fileInput) fileInput.addEventListener("change", handleFileSelected);

  const btn = document.getElementById("translate-btn");
  if (btn) btn.addEventListener("click", handleTranslateClick);

  const unlock = document.getElementById("unlock-advanced-btn");
  if (unlock) unlock.addEventListener("click", () => {
    advancedLocked = !advancedLocked;
    updateAdvancedLockUI();
  });

  const closeErr = document.getElementById("error-close");
  if (closeErr) closeErr.addEventListener("click", hideErrorModal);

  setupDragAndDrop();
  updateAdvancedLockUI();
});
