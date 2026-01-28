let EXCEL_workbook = null;
let EXCEL_fileName = null;

// ====== UI制御系 ======
function setStatus(message) {
  const el = document.getElementById("status-text");
  if (el) el.textContent = message;
  console.log("[sheet-trans] " + message);
}

function showLoading(show, total = 0, current = 0) {
  const overlay = document.getElementById("loading-overlay");
  const msg = document.getElementById("loading-detail");
  if (overlay) {
    overlay.style.display = show ? "flex" : "none";
    if (show && msg) {
      msg.textContent = total > 0 ? `${current} / ${total} 件完了` : "準備中...";
    }
  }
}

function showError(message) {
  console.error("[sheet-trans] ERROR:", message);
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
  const ids = ["excel-file", "sheet-select", "to-lang", "sheet-context", "translate-btn"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

// ====== ファイル読み込み ======
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
    workbook.eachSheet((sheet) => {
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

// ====== シート複製ロジック ======
function duplicateSheet(originalSheet, newSheetName) {
  // 新しいシートを作成（ExcelJSには単純なdeep copyがないため、手動でコピー）
  const newSheet = EXCEL_workbook.addWorksheet(newSheetName);
  
  // 行ごとにコピー
  originalSheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const newRow = newSheet.getRow(rowNumber);
    
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const newCell = newRow.getCell(colNumber);
      newCell.value = cell.value;
      newCell.style = cell.style; // 書式コピー
    });
    
    newRow.height = row.height;
    newRow.commit();
  });

  // 列幅のコピー（ある程度）
  // ExcelJSで正確な列幅取得は難しい場合があるが、設定されているものはコピー
  if (originalSheet.columns) {
    // 列数分ループ
    const maxCol = originalSheet.columnCount;
    for(let i=1; i<=maxCol; i++) {
        const col = originalSheet.getColumn(i);
        if (col && col.width) {
            newSheet.getColumn(i).width = col.width;
        }
    }
  }

  const merges = Array.isArray(originalSheet.model?.merges) ? originalSheet.model.merges : [];
  merges.forEach(range => newSheet.mergeCells(range));
  
  return newSheet;
}

// ====== 翻訳対象収集ロジック ======
function collectCellsToTranslate(sheet) {
  const texts = [];     // 翻訳するテキストのリスト
  const cellRefs = [];  // そのテキストがどのセルか {r, c}
  const masterCells = new Set();
  
  sheet.eachRow((row, rowNumber) => {
    row.eachCell((cell, colNumber) => {
      if (cell.master && cell.master.address !== cell.address) return;
      if (cell.master) {
        if (masterCells.has(cell.master.address)) return;
        masterCells.add(cell.master.address);
      }
      let val = cell.value;
      
      // 数式やリッチテキストの場合は、単純な文字列だけ取る
      if (val && typeof val === 'object') {
         if (val.result) val = val.result;
         else if (val.text) val = val.text;
         else if (val.richText) val = val.richText.map(rt => rt.text).join("");
      }

      // 文字列でなければスキップ（数値、日付、空、nullなど）
      if (typeof val !== 'string') return;

      const text = val.trim();
      if (text === "") return;

      // ★フィルタリング：翻訳不要なものはリストに入れない
      // 1. 半角英数字・記号のみで構成される短い文字列（型番、ODM、USBなど）
      //    (ここでは30文字以下の英数字記号のみの場合スキップとする)
      if (/^[A-Za-z0-9\s\-_.,()]+$/.test(text) && text.length < 30) {
          return;
      }

      // 改行コード置換
      const safeText = text.replace(/\n/g, "|||");
      
      texts.push(safeText);
      cellRefs.push({ r: rowNumber, c: colNumber });
    });
  });

  return { texts, cellRefs };
}

// ====== API呼び出し ======
async function callSheetTranslateAPI(rows, toLang, context, onProgress) {
  const BATCH_SIZE = 40;
  const allTranslations = [];
  const total = rows.length;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    
    // api/sheet を呼び出し
    const res = await fetch("/api/translate?op=sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        rows: batch, 
        toLang: toLang,
        context: context // コンテキストも送信
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`サーバーエラー: ${text}`);
    }
    const data = await res.json();
    
    if (!data.translations || data.translations.length !== batch.length) {
       throw new Error(`整合性エラー: 送信数と受信数が一致しません`);
    }

    allTranslations.push(...data.translations);
    if (onProgress) onProgress(Math.min(i + BATCH_SIZE, total), total);
  }
  return allTranslations;
}

// ====== メイン処理 ======
async function handleTranslateClick() {
  if (!EXCEL_workbook) {
    showError("ファイルを選択してください");
    return;
  }
  
  const select = document.getElementById("sheet-select");
  const originalSheetName = select.value;
  const originalSheet = EXCEL_workbook.getWorksheet(originalSheetName);
  
  const toLang = document.getElementById("to-lang").value;
  const context = document.getElementById("sheet-context").value;

  try {
    toggleUI(true);
    showLoading(true, 0, 0);

    // 1. シートをコピー作成
    setStatus("シートを複製中...");
    const newSheetName = originalSheetName + "_翻訳";
    
    // 同名シートがある場合は削除してから（または名前を変えるなど）
    // ここでは簡易的に、既にあるなら削除する
    const existing = EXCEL_workbook.getWorksheet(newSheetName);
    if (existing) {
        EXCEL_workbook.removeWorksheet(existing.id);
    }
    
    const targetSheet = duplicateSheet(originalSheet, newSheetName);

    // 2. 翻訳対象セルを収集
    setStatus("翻訳対象を収集中...");
    const info = collectCellsToTranslate(targetSheet);
    
    if (info.texts.length === 0) {
        showLoading(false);
        alert("翻訳対象となるテキストが見つかりませんでした。\nファイルのみダウンロードします。");
        await downloadWorkbook();
        return;
    }

    // 3. 翻訳実行
    showLoading(true, info.texts.length, 0);
    const translations = await callSheetTranslateAPI(info.texts, toLang, context, (done, total) => {
        showLoading(true, total, done);
    });

    // 4. 結果を書き込み
    setStatus("翻訳結果を書き込み中...");
    info.cellRefs.forEach((ref, idx) => {
        const cell = targetSheet.getRow(ref.r).getCell(ref.c);
        const transText = (translations[idx] || "").replace(/\|\|\|/g, "\n");
        cell.value = transText;
    });

    setStatus("完了");
    showLoading(false);
    await downloadWorkbook();
    alert("翻訳が完了しました。");

  } catch (e) {
    showError(e.message);
  } finally {
    toggleUI(false);
    showLoading(false);
  }
}

async function downloadWorkbook() {
  const buffer = await EXCEL_workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // ファイル名末尾に_翻訳をつけるルール
  a.download = (EXCEL_fileName || "download") + "_翻訳.xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
