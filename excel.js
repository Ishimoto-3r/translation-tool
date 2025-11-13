let EXCEL_workbook = null; // ExcelJSのWorkbookオブジェクト
let EXCEL_buffer = null;   // ファイルの生データ
let EXCEL_fileName = null;
let advancedLocked = true;

// ====== UI制御系 ======

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
  const ids = ["excel-file", "sheet-select", "to-lang", "source-column", "header-row", "start-row", "translate-btn"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  const unlockBtn = document.getElementById("unlock-advanced-btn");
  if(unlockBtn) unlockBtn.disabled = false; // ロック解除ボタンは常に有効
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

// ====== ファイル読み込み (ExcelJS使用) ======

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
    EXCEL_buffer = arrayBuffer; // 翻訳時に再利用するため保存

    // 読み込みテスト
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);

    EXCEL_workbook = workbook;

    const sheetSelect = document.getElementById("sheet-select");
    sheetSelect.innerHTML = "";
    
    workbook.eachSheet((sheet, id) => {
      const opt = document.createElement("option");
      opt.value = sheet.name; // 名前で管理
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
  const headerRowVal = parseInt(document.getElementById("header-row").value) || 1;
  const startRowVal = parseInt(document.getElementById("start-row").value) || 2;
  
  // データが存在する最終列を探す（ExcelJSは columnCount が正確でない場合があるので走査する）
  let maxCol = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber >= headerRowVal) { // 見出し行以降をチェック
      maxCol = Math.max(maxCol, row.cellCount); 
    }
  });

  // もし「詳細設定」で列指定があればそれを使う実装も可能だが、基本は「最右列」
  const sourceColIndex = maxCol; 
  const targetColIndex = maxCol + 1;

  const rows = [];
  const rowIndices = [];

  // startRow から順にデータを取得
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber >= startRowVal) {
      const cell = row.getCell(sourceColIndex);
      // valueがオブジェクト(数式やリンク)の場合の対応
      let text = "";
      if (cell.value && typeof cell.value === 'object') {
        text = cell.value.result || cell.value.text || "";
      } else {
        text = String(cell.value || "");
      }
      
      // 改行コードを置換
      text = text.replace(/\n/g, "|||");
      
      rows.push(text);
      rowIndices.push(rowNumber);
    }
  });

  return { rows, rowIndices, sourceColIndex, targetColIndex, headerRow: headerRowVal };
}

// ====== API呼び出し (変更なし) ======

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
    allTranslations.push(...data.translations);

    if (onProgress) onProgress(Math.min(i + BATCH_SIZE, total), total);
  }
  return allTranslations;
}

// ====== 書き込み & ダウンロード (ExcelJSの強み) ======

async function writeAndDownload(sheet, info, translations, toLang) {
  const { rowIndices, sourceColIndex, targetColIndex, headerRow } = info;

  // 1. ヘッダー書き込み
  const headerCell = sheet.getRow(headerRow).getCell(targetColIndex);
  headerCell.value = "翻訳結果";
  
  // 元のヘッダーのスタイルをコピー
  const srcHeader = sheet.getRow(headerRow).getCell(sourceColIndex);
  headerCell.style = srcHeader.style;

  // さらに右隣に「メーカー/スリーアール」
  const labelCell = sheet.getRow(headerRow).getCell(targetColIndex + 1);
  labelCell.value = toLang === "zh" ? "メーカー" : "スリーアール";
  labelCell.style = srcHeader.style;

  // 2. データ書き込み
  rowIndices.forEach((rowNum, i) => {
    const row = sheet.getRow(rowNum);
    const srcCell = row.getCell(sourceColIndex);
    const targetCell = row.getCell(targetColIndex);

    const translatedText = (translations[i] || "").replace(/\|\|\|/g, "\n");
    
    // 値をセット
    targetCell.value = translatedText;

    // ★ここが重要：スタイル（フォント、背景、罫線）を完全コピー
    targetCell.style = srcCell.style;
  });

  // 3. 列幅のコピー
  const srcCol = sheet.getColumn(sourceColIndex);
  const tgtCol = sheet.getColumn(targetColIndex);
  const labelCol = sheet.getColumn(targetColIndex + 1);

  if (srcCol && srcCol.width) {
    tgtCol.width = srcCol.width;
    labelCol.width = 20; // ラベル列は適当な幅
  } else {
    tgtCol.width = 30;
  }

  // 4. ファイル生成
  const buffer = await EXCEL_workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
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
    setStatus("データ解析中...");

    const info = collectRowsToTranslate(sheet);
    if (info.rows.length === 0) {
      throw new Error("翻訳対象のデータが見つかりませんでした");
    }

    setStatus(`翻訳中... ${info.rows.length}件`);
    
    const translations = await callExcelTranslateAPI(info.rows, toLang, (done, total) => {
      setStatus(`翻訳進行中: ${done}/${total}`);
    });

    setStatus("Excel生成中...");
    await writeAndDownload(sheet, info, translations, toLang);
    
    setStatus("完了しました");

  } catch (e) {
    showError(e.message);
  } finally {
    toggleUI(false);
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
