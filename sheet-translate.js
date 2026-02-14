let EXCEL_workbook = null;
let EXCEL_fileName = null;
let EXCEL_arrayBuffer = null; // ZIPレベルコピー用に元データを保持

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
    EXCEL_arrayBuffer = arrayBuffer.slice(0); // ZIPレベルコピー用に保持
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

// ====== シート複製ロジック（ZIPレベル） ======

// フォールバック用：従来のExcelJSセル単位コピー
function duplicateSheetFallback(originalSheet, newSheetName) {
  const newSheet = EXCEL_workbook.addWorksheet(newSheetName);
  originalSheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const newRow = newSheet.getRow(rowNumber);
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const newCell = newRow.getCell(colNumber);
      newCell.value = cell.value;
      newCell.style = cell.style;
    });
    newRow.height = row.height;
    newRow.commit();
  });
  if (originalSheet.columns) {
    const maxCol = originalSheet.columnCount;
    for (let i = 1; i <= maxCol; i++) {
      const col = originalSheet.getColumn(i);
      if (col && col.width) newSheet.getColumn(i).width = col.width;
    }
  }
  const merges = Array.isArray(originalSheet.model?.merges) ? originalSheet.model.merges : [];
  merges.forEach(range => newSheet.mergeCells(range));
  return newSheet;
}

// ZIPレベルでシートを丸ごとコピー（画像・図形・グラフすべて保持）
async function duplicateSheet(originalSheetName, newSheetName) {
  // JSZipが使えない場合やArrayBufferがない場合はフォールバック
  if (typeof JSZip === "undefined" || !EXCEL_arrayBuffer) {
    console.warn("[sheet-trans] JSZipが利用できません。従来方式でコピーします。");
    const sheet = EXCEL_workbook.getWorksheet(originalSheetName);
    return duplicateSheetFallback(sheet, newSheetName);
  }

  try {
    // 1. 現在のワークブックをバッファに書き出し（最新状態を使用）
    const currentBuffer = await EXCEL_workbook.xlsx.writeBuffer();
    const zip = await JSZip.loadAsync(currentBuffer);

    // 2. workbook.xmlからシート情報を取得
    const wbXml = await zip.file("xl/workbook.xml").async("string");
    const parser = new DOMParser();
    const wbDoc = parser.parseFromString(wbXml, "application/xml");
    const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

    // 対象シートを探す
    const sheets = wbDoc.getElementsByTagNameNS(ns, "sheet");
    let sourceSheetNode = null;
    let sourceRId = null;
    for (let i = 0; i < sheets.length; i++) {
      if (sheets[i].getAttribute("name") === originalSheetName) {
        sourceSheetNode = sheets[i];
        sourceRId = sheets[i].getAttributeNS(
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"
        );
        break;
      }
    }
    if (!sourceSheetNode || !sourceRId) {
      throw new Error("元シートがworkbook.xml内に見つかりません");
    }

    // 3. workbook.xml.relsから元シートのファイルパスを特定
    const wbRelsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
    const wbRelsDoc = parser.parseFromString(wbRelsXml, "application/xml");
    const rels = wbRelsDoc.getElementsByTagName("Relationship");
    let sourceSheetPath = null;
    for (let i = 0; i < rels.length; i++) {
      if (rels[i].getAttribute("Id") === sourceRId) {
        sourceSheetPath = rels[i].getAttribute("Target");
        break;
      }
    }
    if (!sourceSheetPath) {
      throw new Error("元シートのファイルパスが特定できません");
    }

    // 4. 新しいシート番号を決定
    const existingSheets = Object.keys(zip.files)
      .filter(f => f.match(/^xl\/worksheets\/sheet\d+\.xml$/))
      .map(f => parseInt(f.match(/sheet(\d+)/)[1]));
    const newSheetNum = Math.max(...existingSheets) + 1;
    const newSheetFile = `worksheets/sheet${newSheetNum}.xml`;
    const newSheetFullPath = `xl/${newSheetFile}`;

    // 5. シートXMLをコピー
    const sourceFullPath = sourceSheetPath.startsWith("xl/")
      ? sourceSheetPath
      : `xl/${sourceSheetPath}`;
    const sheetContent = await zip.file(sourceFullPath).async("uint8array");
    zip.file(newSheetFullPath, sheetContent);

    // 6. シートのrelsファイルをコピー（存在する場合 = drawing/chart等がある場合）
    const sourceBaseName = sourceSheetPath.replace(/^.*\//, "");
    const sourceRelsPath = sourceFullPath.replace(
      sourceBaseName,
      `_rels/${sourceBaseName}.rels`
    );
    const newRelsPath = `xl/worksheets/_rels/sheet${newSheetNum}.xml.rels`;

    if (zip.file(sourceRelsPath)) {
      let relsContent = await zip.file(sourceRelsPath).async("string");

      // drawing/chartファイルもコピーして参照を更新
      const relsDoc = parser.parseFromString(relsContent, "application/xml");
      const sheetRels = relsDoc.getElementsByTagName("Relationship");

      for (let i = 0; i < sheetRels.length; i++) {
        const target = sheetRels[i].getAttribute("Target");
        const type = sheetRels[i].getAttribute("Type") || "";

        // drawing のコピー
        if (type.includes("/drawing") && target) {
          const drawingSource = target.startsWith("../")
            ? `xl/${target.replace("../", "")}`
            : `xl/drawings/${target}`;
          if (zip.file(drawingSource)) {
            const drawingMatch = target.match(/drawing(\d+)/);
            if (drawingMatch) {
              // 新しいdrawing番号
              const existingDrawings = Object.keys(zip.files)
                .filter(f => f.match(/^xl\/drawings\/drawing\d+\.xml$/))
                .map(f => parseInt(f.match(/drawing(\d+)/)[1]));
              const newDrawNum = existingDrawings.length > 0
                ? Math.max(...existingDrawings) + 1 : 1;
              const newDrawFile = `drawing${newDrawNum}.xml`;

              // drawingの内容をコピー
              const drawContent = await zip.file(drawingSource).async("uint8array");
              zip.file(`xl/drawings/${newDrawFile}`, drawContent);

              // drawing の rels もコピー（画像参照を含む）
              const drawRelsSource = drawingSource.replace(
                /([^\/]+)$/,
                "_rels/$1.rels"
              );
              if (zip.file(drawRelsSource)) {
                const drawRelsContent = await zip.file(drawRelsSource).async("uint8array");
                zip.file(`xl/drawings/_rels/${newDrawFile}.rels`, drawRelsContent);
              }

              // Content_Typesにdrawing追加
              const ctXml = await zip.file("[Content_Types].xml").async("string");
              if (!ctXml.includes(`/xl/drawings/${newDrawFile}`)) {
                const updatedCt = ctXml.replace(
                  "</Types>",
                  `<Override PartName="/xl/drawings/${newDrawFile}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`
                );
                zip.file("[Content_Types].xml", updatedCt);
              }

              // relsの参照先を更新
              const oldTarget = target;
              const newTarget = target.replace(/drawing\d+/, `drawing${newDrawNum}`);
              relsContent = relsContent.replace(oldTarget, newTarget);
            }
          }
        }

        // chart のコピー
        if (type.includes("/chart") && target) {
          const chartSource = target.startsWith("../")
            ? `xl/${target.replace("../", "")}`
            : `xl/charts/${target}`;
          if (zip.file(chartSource)) {
            const chartMatch = target.match(/chart(\d+)/);
            if (chartMatch) {
              const existingCharts = Object.keys(zip.files)
                .filter(f => f.match(/^xl\/charts\/chart\d+\.xml$/))
                .map(f => parseInt(f.match(/chart(\d+)/)[1]));
              const newChartNum = existingCharts.length > 0
                ? Math.max(...existingCharts) + 1 : 1;
              const newChartFile = `chart${newChartNum}.xml`;

              const chartContent = await zip.file(chartSource).async("uint8array");
              zip.file(`xl/charts/${newChartFile}`, chartContent);

              // chart の rels もコピー
              const chartRelsSource = chartSource.replace(
                /([^\/]+)$/,
                "_rels/$1.rels"
              );
              if (zip.file(chartRelsSource)) {
                const chartRelsContent = await zip.file(chartRelsSource).async("uint8array");
                zip.file(`xl/charts/_rels/${newChartFile}.rels`, chartRelsContent);
              }

              // Content_Typesにchart追加
              const ctXml2 = await zip.file("[Content_Types].xml").async("string");
              if (!ctXml2.includes(`/xl/charts/${newChartFile}`)) {
                const updatedCt2 = ctXml2.replace(
                  "</Types>",
                  `<Override PartName="/xl/charts/${newChartFile}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`
                );
                zip.file("[Content_Types].xml", updatedCt2);
              }

              const oldChartTarget = target;
              const newChartTarget = target.replace(/chart\d+/, `chart${newChartNum}`);
              relsContent = relsContent.replace(oldChartTarget, newChartTarget);
            }
          }
        }
      }

      zip.file(newRelsPath, relsContent);
    }

    // 7. workbook.xmlに新シートを追加
    const maxSheetId = Array.from(sheets).reduce(
      (max, s) => Math.max(max, parseInt(s.getAttribute("sheetId")) || 0), 0
    );
    const newSheetId = maxSheetId + 1;
    const newRIdNum = newSheetNum + 100; // 既存rIdと衝突しないように大きめの番号
    const newRId = `rId${newRIdNum}`;

    const updatedWbXml = wbXml.replace(
      "</sheets>",
      `<sheet name="${newSheetName}" sheetId="${newSheetId}" r:id="${newRId}"/></sheets>`
    );
    zip.file("xl/workbook.xml", updatedWbXml);

    // 8. workbook.xml.relsに新シートの参照を追加
    const updatedRelsXml = wbRelsXml.replace(
      "</Relationships>",
      `<Relationship Id="${newRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${newSheetFile}"/></Relationships>`
    );
    zip.file("xl/_rels/workbook.xml.rels", updatedRelsXml);

    // 9. [Content_Types].xmlに新シートを追加
    let ctXml = await zip.file("[Content_Types].xml").async("string");
    if (!ctXml.includes(newSheetFullPath)) {
      ctXml = ctXml.replace(
        "</Types>",
        `<Override PartName="/${newSheetFullPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
      );
      zip.file("[Content_Types].xml", ctXml);
    }

    // 10. 更新したZIPをExcelJSで再読み込み
    const newBuffer = await zip.generateAsync({ type: "arraybuffer" });
    const newWorkbook = new ExcelJS.Workbook();
    await newWorkbook.xlsx.load(newBuffer);
    EXCEL_workbook = newWorkbook;

    const newSheet = EXCEL_workbook.getWorksheet(newSheetName);
    if (!newSheet) {
      throw new Error("ZIPコピー後にシートが見つかりません");
    }

    console.log("[sheet-trans] ZIPレベルでシートを複製しました: " + newSheetName);
    return newSheet;

  } catch (err) {
    console.error("[sheet-trans] ZIPコピーに失敗しました。従来方式にフォールバック:", err);
    // フォールバック：従来のセル単位コピー
    const sheet = EXCEL_workbook.getWorksheet(originalSheetName);
    if (!sheet) throw new Error("元シートが見つかりません: " + originalSheetName);
    return duplicateSheetFallback(sheet, newSheetName);
  }
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

  const toLang = document.getElementById("to-lang").value;
  const context = document.getElementById("sheet-context").value;

  try {
    toggleUI(true);
    showLoading(true, 0, 0);

    // 1. シートをコピー作成（ZIPレベルで丸ごとコピー）
    setStatus("シートを複製中...");
    const newSheetName = originalSheetName + "_翻訳";

    const targetSheet = await duplicateSheet(originalSheetName, newSheetName);

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
