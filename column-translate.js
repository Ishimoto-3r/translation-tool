let EXCEL_workbook = null;
let EXCEL_fileName = null;

// ====== UI制御系 ======

function setStatus(message) {
  const el = document.getElementById("status-text");
  if (el) el.textContent = message;
  console.log("[col-trans] " + message);
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
  console.error("[col-trans] ERROR:", message);
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
  const ids = ["excel-file", "sheet-select", "to-lang", "target-column-letter", "start-row", "end-row", "translate-btn", "translation-context"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
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

// ====== ユーティリティ: 列アルファベットを数値に変換 ======
function colLetterToNumber(colStr) {
  let base = 'A'.charCodeAt(0) - 1;
  let col = colStr.toUpperCase().trim();
  let n = 0;
  for (let i = 0; i < col.length; i++) {
    n = n * 26 + (col.charCodeAt(i) - base);
  }
  return n;
}

// ====== データ抽出 ======

function getTargetSheet() {
  if (!EXCEL_workbook) return null;
  const select = document.getElementById("sheet-select");
  const sheetName = select.value;
  return EXCEL_workbook.getWorksheet(sheetName);
}

function collectRowsToTranslate(sheet) {
  const colStr = document.getElementById("target-column-letter").value;
  if (!colStr) throw new Error("翻訳したい列（アルファベット）を指定してください。");
  
  const sourceColIndex = colLetterToNumber(colStr); 
  if (sourceColIndex < 1) throw new Error("列の指定が正しくありません。");

  const startRowInput = document.getElementById("start-row");
  if (!startRowInput.value) throw new Error("開始行を入力してください。");
  
  const startRowVal = parseInt(startRowInput.value);
  let endRowVal = parseInt(document.getElementById("end-row").value);
  
  if (!endRowVal || isNaN(endRowVal)) {
    endRowVal = sheet.actualRowCount;
    if (endRowVal < startRowVal) endRowVal = startRowVal;
  }

  const targetColIndex = sourceColIndex + 1;
  const rows = [];
  const rowNumToTranslationIndex = {}; 

  for (let r = startRowVal; r <= endRowVal; r++) {
    const row = sheet.getRow(r);
    const cell = row.getCell(sourceColIndex);
    
    let text = "";
    if (cell.value && typeof cell.value === 'object') {
      text = cell.value.result || cell.value.text || "";
    } else {
      text = String(cell.value || "");
    }
    text = text.replace(/\n/g, "|||");
    
    if (text.trim() !== "") { 
      rowNumToTranslationIndex[r] = rows.length; 
      rows.push(text);
    }
  }

  return { 
    rows, 
    rowNumToTranslationIndex, 
    sourceColIndex, 
    targetColIndex, 
    startRow: startRowVal, 
    endRow: endRowVal 
  };
}

// ====== API呼び出し ======

// ★変更点: context 引数を追加
async function callTranslateAPI(rows, toLang, context, onProgress) {
  const BATCH_SIZE = 40;
  const allTranslations = [];
  const total = rows.length;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    
    const res = await fetch("/api/translate?op=verify", {

      method: "POST",
      headers: { "Content-Type": "application/json" },
      // ★変更点: context を送信
      body: JSON.stringify({ rows: batch, toLang, context }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`サーバーエラー: ${text}`);
    }
    const data = await res.json();
    
    if (!data.translations || data.translations.length !== batch.length) {
       throw new Error(`翻訳エラー：整合性不一致`);
    }

    allTranslations.push(...data.translations);

    if (onProgress) onProgress(Math.min(i + BATCH_SIZE, total), total);
  }
  return allTranslations;
}

// ====== 書き込み & ダウンロード ======

async function writeAndDownload(sheet, info, translations) {
  const { rowNumToTranslationIndex, sourceColIndex, targetColIndex, startRow, endRow } = info;

  for (let rowNum = startRow; rowNum <= endRow; rowNum++) {
    const row = sheet.getRow(rowNum);
    const targetCell = row.getCell(targetColIndex);

    const translationIndex = rowNumToTranslationIndex[rowNum];
    if (translationIndex !== undefined) {
      const translatedText = (translations[translationIndex] || "").replace(/\|\|\|/g, "\n");
      targetCell.value = translatedText;
    } else {
      targetCell.value = null;
    }
  }

  const srcCol = sheet.getColumn(sourceColIndex);
  const targetCol = sheet.getColumn(targetColIndex);
  if (srcCol && srcCol.width) {
    targetCol.width = srcCol.width; 
  } else {
    targetCol.width = 20; 
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
  // ★変更点: コンテキストを取得
  const context = document.getElementById("translation-context").value;

  try {
    toggleUI(true);
    showLoading(true, 0, 0);

    const info = collectRowsToTranslate(sheet);
    if (info.rows.length === 0) {
      setStatus("翻訳対象がありませんでしたが、ファイルを作成します。");
      await writeAndDownload(sheet, info, []);
      showLoading(false);
      setStatus("完了");
      alert("翻訳対象セルがありませんでした（空欄または範囲外）。\nファイルを作成してダウンロードします。");
      return;
    }

    showLoading(true, info.rows.length, 0);
    
    // ★変更点: context を渡す
    const translations = await callTranslateAPI(info.rows, toLang, context, (done, total) => {
      showLoading(true, total, done);
    });

    setStatus("Excel生成中...");
    await writeAndDownload(sheet, info, translations);
    
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

  const closeErr = document.getElementById("error-close");
  if (closeErr) closeErr.addEventListener("click", hideErrorModal);

  setupDragAndDrop();
});
