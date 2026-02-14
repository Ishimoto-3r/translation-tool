let EXCEL_workbook = null;
let EXCEL_fileName = null;
let EXCEL_arrayBuffer = null; // ZIPレベル処理用に元データを保持

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
    EXCEL_arrayBuffer = arrayBuffer.slice(0); // ZIPレベル処理用に保持
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

// ====== ヘルパー関数 ======

// 列番号(1始まり)をExcel列文字に変換（1→A, 27→AA）
function colToLetter(col) {
  let letter = "";
  let c = col;
  while (c > 0) {
    c--;
    letter = String.fromCharCode(65 + (c % 26)) + letter;
    c = Math.floor(c / 26);
  }
  return letter;
}

// ====== ZIPレベル シート複製 ======
// 元のArrayBufferをJSZipで操作し、シートを丸ごとコピーする
// ExcelJSのwriteBuffer()を使わないため、グラフ・図形・画像がすべて保持される

async function duplicateSheetInZip(originalSheetName, newSheetName) {
  const zip = await JSZip.loadAsync(EXCEL_arrayBuffer);
  const parser = new DOMParser();

  // デバッグ: ZIP内の全ファイル一覧
  const allFiles = Object.keys(zip.files).filter(f => !zip.files[f].dir);
  console.log("[ZIP-DEBUG] ZIP内ファイル一覧:", allFiles);

  // 1. workbook.xmlからシート情報を取得
  const wbXml = await zip.file("xl/workbook.xml").async("string");
  const wbDoc = parser.parseFromString(wbXml, "application/xml");
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

  const sheets = wbDoc.getElementsByTagNameNS(ns, "sheet");
  let sourceRId = null;
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getAttribute("name") === originalSheetName) {
      sourceRId = sheets[i].getAttributeNS(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"
      );
      break;
    }
  }
  if (!sourceRId) throw new Error("元シートがworkbook.xml内に見つかりません");
  console.log("[ZIP-DEBUG] 元シートRId:", sourceRId);

  // 2. workbook.xml.relsから元シートのファイルパスを特定
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
  if (!sourceSheetPath) throw new Error("元シートのファイルパスが特定できません");
  console.log("[ZIP-DEBUG] 元シートパス:", sourceSheetPath);

  // 3. 新しいシート番号を決定
  const existingSheets = Object.keys(zip.files)
    .filter(f => f.match(/^xl\/worksheets\/sheet\d+\.xml$/))
    .map(f => parseInt(f.match(/sheet(\d+)/)[1]));
  const newSheetNum = Math.max(...existingSheets) + 1;
  const newSheetFile = `worksheets/sheet${newSheetNum}.xml`;
  const newSheetFullPath = `xl/${newSheetFile}`;

  // 4. シートXMLをコピー
  const sourceFullPath = sourceSheetPath.startsWith("xl/")
    ? sourceSheetPath
    : `xl/${sourceSheetPath}`;
  const sheetContent = await zip.file(sourceFullPath).async("uint8array");
  zip.file(newSheetFullPath, sheetContent);
  console.log("[ZIP-DEBUG] シートコピー:", sourceFullPath, "→", newSheetFullPath);

  // 5. シートのrelsファイルをコピー（drawing/chart等の参照を含む）
  const sourceBaseName = sourceSheetPath.replace(/^.*\//, "");
  const sourceRelsPath = sourceFullPath.replace(
    sourceBaseName,
    `_rels/${sourceBaseName}.rels`
  );
  const newRelsPath = `xl/worksheets/_rels/sheet${newSheetNum}.xml.rels`;

  console.log("[ZIP-DEBUG] シートrels検索:", sourceRelsPath, "→", zip.file(sourceRelsPath) ? "見つかった" : "見つからない");

  if (zip.file(sourceRelsPath)) {
    let relsContent = await zip.file(sourceRelsPath).async("string");
    console.log("[ZIP-DEBUG] シートrels内容:", relsContent);
    const relsDoc = parser.parseFromString(relsContent, "application/xml");
    const sheetRels = relsDoc.getElementsByTagName("Relationship");

    for (let i = 0; i < sheetRels.length; i++) {
      const target = sheetRels[i].getAttribute("Target");
      const type = sheetRels[i].getAttribute("Type") || "";
      console.log(`[ZIP-DEBUG] rels[${i}] type=${type}, target=${target}`);

      // drawingのコピー
      if (type.includes("/drawing") && target) {
        const drawingSource = target.startsWith("../")
          ? `xl/${target.replace("../", "")}`
          : `xl/drawings/${target}`;
        console.log("[ZIP-DEBUG] drawing検索:", drawingSource, "→", zip.file(drawingSource) ? "見つかった" : "見つからない");
        if (zip.file(drawingSource)) {
          const drawingMatch = target.match(/drawing(\d+)/);
          if (drawingMatch) {
            const existingDrawings = Object.keys(zip.files)
              .filter(f => f.match(/^xl\/drawings\/drawing\d+\.xml$/))
              .map(f => parseInt(f.match(/drawing(\d+)/)[1]));
            const newDrawNum = existingDrawings.length > 0
              ? Math.max(...existingDrawings) + 1 : 1;
            const newDrawFile = `drawing${newDrawNum}.xml`;

            const drawContent = await zip.file(drawingSource).async("uint8array");
            zip.file(`xl/drawings/${newDrawFile}`, drawContent);
            console.log("[ZIP-DEBUG] drawingコピー:", drawingSource, "→", `xl/drawings/${newDrawFile}`);

            // drawing の rels を解析し、chart/imageの参照を処理
            const drawRelsSource = drawingSource.replace(/([^\/]+)$/, "_rels/$1.rels");
            console.log("[ZIP-DEBUG] drawing rels検索:", drawRelsSource, "→", zip.file(drawRelsSource) ? "見つかった" : "見つからない");

            if (zip.file(drawRelsSource)) {
              let drawRelsContent = await zip.file(drawRelsSource).async("string");
              console.log("[ZIP-DEBUG] drawing rels内容:", drawRelsContent);

              // drawing rels内のRelationshipを解析
              const drawRelsDoc = parser.parseFromString(drawRelsContent, "application/xml");
              const drawRelsList = drawRelsDoc.getElementsByTagName("Relationship");

              for (let j = 0; j < drawRelsList.length; j++) {
                const dTarget = drawRelsList[j].getAttribute("Target");
                const dType = drawRelsList[j].getAttribute("Type") || "";
                console.log(`[ZIP-DEBUG] drawing rels[${j}] type=${dType}, target=${dTarget}`);

                // chartの個別コピー（同一chart共有を避ける）
                if (dType.includes("/chart") && dTarget) {
                  const chartSource = dTarget.startsWith("../")
                    ? `xl/${dTarget.replace("../", "")}`
                    : dTarget;
                  console.log("[ZIP-DEBUG] chart検索:", chartSource, "→", zip.file(chartSource) ? "見つかった" : "見つからない");

                  if (zip.file(chartSource)) {
                    const chartMatch = dTarget.match(/chart(\d+)/);
                    if (chartMatch) {
                      const existingCharts = Object.keys(zip.files)
                        .filter(f => f.match(/^xl\/charts\/chart\d+\.xml$/))
                        .map(f => parseInt(f.match(/chart(\d+)/)[1]));
                      const newChartNum = existingCharts.length > 0
                        ? Math.max(...existingCharts) + 1 : 1;
                      const newChartFile = `chart${newChartNum}.xml`;

                      // chart XMLをコピー
                      const chartContent = await zip.file(chartSource).async("uint8array");
                      zip.file(`xl/charts/${newChartFile}`, chartContent);
                      console.log("[ZIP-DEBUG] chartコピー:", chartSource, "→", `xl/charts/${newChartFile}`);

                      // chart relsもコピー（style等の参照）
                      const chartRelsSource = chartSource.replace(/([^\/]+)$/, "_rels/$1.rels");
                      if (zip.file(chartRelsSource)) {
                        const chartRelsContent = await zip.file(chartRelsSource).async("uint8array");
                        zip.file(`xl/charts/_rels/${newChartFile}.rels`, chartRelsContent);
                        console.log("[ZIP-DEBUG] chart relsコピー:", chartRelsSource);
                      }

                      // Content_Typesにchart追加
                      let ctXmlChart = await zip.file("[Content_Types].xml").async("string");
                      if (!ctXmlChart.includes(`/xl/charts/${newChartFile}`)) {
                        ctXmlChart = ctXmlChart.replace(
                          "</Types>",
                          `<Override PartName="/xl/charts/${newChartFile}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`
                        );
                        zip.file("[Content_Types].xml", ctXmlChart);
                      }

                      // drawing rels内の参照を新chartに更新
                      const newChartTarget = dTarget.replace(/chart\d+/, `chart${newChartNum}`);
                      drawRelsContent = drawRelsContent.replace(dTarget, newChartTarget);
                      console.log("[ZIP-DEBUG] chart参照更新:", dTarget, "→", newChartTarget);
                    }
                  }
                }
                // image参照はそのまま（共有OK）
              }

              // 更新済みdrawing relsを保存
              zip.file(`xl/drawings/_rels/${newDrawFile}.rels`, drawRelsContent);
              console.log("[ZIP-DEBUG] drawing rels保存:", `xl/drawings/_rels/${newDrawFile}.rels`);
            }

            // Content_Typesにdrawing追加
            let ctXml = await zip.file("[Content_Types].xml").async("string");
            if (!ctXml.includes(`/xl/drawings/${newDrawFile}`)) {
              ctXml = ctXml.replace(
                "</Types>",
                `<Override PartName="/xl/drawings/${newDrawFile}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`
              );
              zip.file("[Content_Types].xml", ctXml);
            }

            const newTarget = target.replace(/drawing\d+/, `drawing${newDrawNum}`);
            relsContent = relsContent.replace(target, newTarget);
          }
        }
      }

      // chartのコピー
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

            const chartRelsSource = chartSource.replace(/([^\/]+)$/, "_rels/$1.rels");
            if (zip.file(chartRelsSource)) {
              const chartRelsContent = await zip.file(chartRelsSource).async("uint8array");
              zip.file(`xl/charts/_rels/${newChartFile}.rels`, chartRelsContent);
            }

            let ctXml2 = await zip.file("[Content_Types].xml").async("string");
            if (!ctXml2.includes(`/xl/charts/${newChartFile}`)) {
              ctXml2 = ctXml2.replace(
                "</Types>",
                `<Override PartName="/xl/charts/${newChartFile}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`
              );
              zip.file("[Content_Types].xml", ctXml2);
            }

            const newChartTarget = target.replace(/chart\d+/, `chart${newChartNum}`);
            relsContent = relsContent.replace(target, newChartTarget);
          }
        }
      }
    }

    console.log("[ZIP-DEBUG] 新relsファイル保存:", newRelsPath);
    console.log("[ZIP-DEBUG] 新rels内容:", relsContent);
    zip.file(newRelsPath, relsContent);
  } else {
    console.warn("[ZIP-DEBUG] シートrelsファイルが見つかりません！drawingなしの可能性");
  }

  // 6. workbook.xmlに新シートを追加
  const maxSheetId = Array.from(sheets).reduce(
    (max, s) => Math.max(max, parseInt(s.getAttribute("sheetId")) || 0), 0
  );
  const newSheetId = maxSheetId + 1;
  const newRIdNum = newSheetNum + 100;
  const newRId = `rId${newRIdNum}`;

  const updatedWbXml = wbXml.replace(
    "</sheets>",
    `<sheet name="${newSheetName}" sheetId="${newSheetId}" r:id="${newRId}"/></sheets>`
  );
  zip.file("xl/workbook.xml", updatedWbXml);

  // 7. workbook.xml.relsに参照追加
  const updatedRelsXml = wbRelsXml.replace(
    "</Relationships>",
    `<Relationship Id="${newRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${newSheetFile}"/></Relationships>`
  );
  zip.file("xl/_rels/workbook.xml.rels", updatedRelsXml);

  // 8. [Content_Types].xmlに新シートを追加
  let ctXml = await zip.file("[Content_Types].xml").async("string");
  if (!ctXml.includes(newSheetFullPath)) {
    ctXml = ctXml.replace(
      "</Types>",
      `<Override PartName="/${newSheetFullPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
    );
    zip.file("[Content_Types].xml", ctXml);
  }

  console.log("[sheet-trans] ZIPレベルでシートを複製しました: " + newSheetName);
  return { zip, newSheetFullPath };
}

// ====== ZIPレベル 翻訳テキスト書き込み ======
// シートXMLのセル値を直接インライン文字列で置き換える
// ExcelJSを経由しないので、グラフ・図形は一切影響を受けない

async function applyTranslationsToZip(zip, sheetPath, cellRefs, translations) {
  let sheetXml = await zip.file(sheetPath).async("string");

  cellRefs.forEach((ref, idx) => {
    const addr = colToLetter(ref.c) + ref.r;
    const transText = (translations[idx] || "").replace(/\|\|\|/g, "\n");

    // XMLエスケープ
    const escaped = transText
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    // セル要素を正規表現で検索: <c ...r="ADDR"...>...</c>
    // ※属性の順序に依存しないパターン
    const cellRegex = new RegExp(
      '(<c\\b[^>]*?\\br="' + addr + '")(\\b[^>]*?)>([\\s\\S]*?)</c>',
      ''
    );

    sheetXml = sheetXml.replace(cellRegex, (match, prefix, rest) => {
      // 既存のt="..."属性を除去し、t="inlineStr"を設定
      const cleanPrefix = prefix.replace(/\s+t="[^"]*"/, "");
      const cleanRest = rest.replace(/\s+t="[^"]*"/, "");
      return `${cleanPrefix} t="inlineStr"${cleanRest}><is><t>${escaped}</t></is></c>`;
    });
  });

  zip.file(sheetPath, sheetXml);
  console.log("[ZIP-DEBUG] 翻訳テキスト書き込み完了（文字列置換方式）");
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

    const res = await fetch("/api/translate?op=sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: batch,
        toLang: toLang,
        context: context
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
  if (!EXCEL_workbook || !EXCEL_arrayBuffer) {
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

    // 1. ExcelJSで翻訳対象セルを収集（読み取り専用）
    setStatus("翻訳対象を収集中...");
    const info = collectCellsToTranslate(originalSheet);

    if (info.texts.length === 0) {
      showLoading(false);
      alert("翻訳対象となるテキストが見つかりませんでした。");
      return;
    }

    // 2. APIで翻訳を取得
    showLoading(true, info.texts.length, 0);
    const translations = await callSheetTranslateAPI(info.texts, toLang, context, (done, total) => {
      showLoading(true, total, done);
    });

    // 3. ZIPレベルでシートを複製（画像・図形・グラフすべて保持）
    setStatus("シートを複製中...");
    const newSheetName = originalSheetName + "_翻訳";
    const { zip, newSheetFullPath } = await duplicateSheetInZip(originalSheetName, newSheetName);

    // 4. ZIPレベルで翻訳テキストを書き込み（ExcelJSを経由しない）
    setStatus("翻訳結果を書き込み中...");
    await applyTranslationsToZip(zip, newSheetFullPath, info.cellRefs, translations);

    // 5. ZIPから最終ファイルを生成してダウンロード
    setStatus("ファイルを生成中...");
    const outputBuffer = await zip.generateAsync({ type: "arraybuffer" });
    downloadBuffer(outputBuffer);

    setStatus("完了");
    showLoading(false);
    alert("翻訳が完了しました。");

  } catch (e) {
    showError(e.message);
  } finally {
    toggleUI(false);
    showLoading(false);
  }
}

// ====== ダウンロード ======
function downloadBuffer(buffer) {
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
