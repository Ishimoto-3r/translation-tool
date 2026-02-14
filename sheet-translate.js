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


  // 5. シートのrelsファイルをコピー（drawing/chart等の参照を含む）
  const sourceBaseName = sourceSheetPath.replace(/^.*\//, "");
  const sourceRelsPath = sourceFullPath.replace(
    sourceBaseName,
    `_rels/${sourceBaseName}.rels`
  );
  const newRelsPath = `xl/worksheets/_rels/sheet${newSheetNum}.xml.rels`;

  if (zip.file(sourceRelsPath)) {
    // 元シートのrelsをそのままコピー（drawing/chart参照は元ファイルを共有）
    // 描画ファイルをコピーするとExcelの修復対象になるため、元のdrawingを共有する
    const relsContent = await zip.file(sourceRelsPath).async("uint8array");
    zip.file(newRelsPath, relsContent);
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

  // 9. docProps/app.xmlのシートメタデータを更新
  const appXmlPath = "docProps/app.xml";
  if (zip.file(appXmlPath)) {
    let appXml = await zip.file(appXmlPath).async("string");

    // TitlesOfPartsのvector sizeを+1し、新シート名を追加
    // ※<TitlesOfParts>をアンカーにして正しいvectorを特定
    appXml = appXml.replace(
      /(<TitlesOfParts>\s*<vt:vector\s+size=")(\d+)("[\s\S]*?)(<\/vt:vector>\s*<\/TitlesOfParts>)/,
      (match, prefix, size, mid, suffix) => {
        const newSize = parseInt(size) + 1;
        return `${prefix}${newSize}${mid}<vt:lpstr>${newSheetName}</vt:lpstr>${suffix}`;
      }
    );

    // HeadingPairsのワークシート数を+1（vector sizeは変更しない）
    appXml = appXml.replace(
      /(<HeadingPairs>[\s\S]*?<vt:i4>)(\d+)(<\/vt:i4>)/,
      (match, prefix, count, suffix) => {
        return `${prefix}${parseInt(count) + 1}${suffix}`;
      }
    );

    zip.file(appXmlPath, appXml);
    console.log("[ZIP-DEBUG] app.xmlシートメタデータ更新完了");
  }

  console.log("[sheet-trans] ZIPレベルでシートを複製しました: " + newSheetName);
  return { zip, newSheetFullPath };
}

// ====== ZIPレベル 翻訳テキスト書き込み ======
// シートXMLのセル値を直接インライン文字列で置き換える
// ExcelJSを経由しないので、グラフ・図形は一切影響を受けない

async function applyTranslationsToZip(zip, sheetPath, cellRefs, translations) {
  let sheetXml = await zip.file(sheetPath).async("string");
  let matchCount = 0;

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
      '(<c\\b[^>]*?\\br="' + addr + '")([^>]*)>([\\s\\S]*?)</c>',
      ''
    );

    const before = sheetXml;
    sheetXml = sheetXml.replace(cellRegex, (match, prefix, rest) => {
      // 既存のt="..."属性を除去し、t="inlineStr"を設定
      const cleanPrefix = prefix.replace(/\s+t="[^"]*"/, "");
      const cleanRest = rest.replace(/\s+t="[^"]*"/, "");
      matchCount++;
      return `${cleanPrefix} t="inlineStr"${cleanRest}><is><t>${escaped}</t></is></c>`;
    });

    if (before === sheetXml && idx < 5) {
      console.warn(`[ZIP-DEBUG] セル ${addr} がマッチしませんでした`);
    }
  });

  zip.file(sheetPath, sheetXml);
  console.log(`[ZIP-DEBUG] 翻訳テキスト書き込み完了: ${matchCount}/${cellRefs.length}セル置換`);
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

    // 5. sharedStrings.xmlのcount属性を除去（ExcelJSに再計算させる）
    const ssPath = "xl/sharedStrings.xml";
    if (zip.file(ssPath)) {
      let ssXml = await zip.file(ssPath).async("string");
      ssXml = ssXml.replace(/\s+count="\d+"/, "");
      ssXml = ssXml.replace(/\s+uniqueCount="\d+"/, "");
      zip.file(ssPath, ssXml);
      console.log("[ZIP-DEBUG] sharedStrings count属性を除去");
    }



    // 6. ZIPから最終ファイルを生成してダウンロード
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

// ====== 診断テスト（コンソールから呼び出し用）======
// テスト1: JSZipパススルー（変更なし → 修復出たらJSZip自体が原因）
window._test1 = async function () {
  if (!EXCEL_arrayBuffer) { alert("ファイルを先にロード"); return; }
  const zip = await JSZip.loadAsync(EXCEL_arrayBuffer);
  const buf = await zip.generateAsync({ type: "arraybuffer" });
  downloadBuffer(buf);
  alert("テスト1完了: 変更なしパススルー");
};

// テスト2: シート追加+翻訳のみ（drawing/chartコピーなし → 修復出たらシート追加が原因）
window._test2 = async function () {
  if (!EXCEL_arrayBuffer || !EXCEL_workbook) { alert("ファイルを先にロード"); return; }
  const zip = await JSZip.loadAsync(EXCEL_arrayBuffer);
  const parser = new DOMParser();

  const select = document.getElementById("sheet-select");
  const originalSheetName = select.value;

  // workbook.xmlからシート情報取得
  const wbXml = await zip.file("xl/workbook.xml").async("string");
  const wbDoc = parser.parseFromString(wbXml, "application/xml");
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const sheets = wbDoc.getElementsByTagNameNS(ns, "sheet");
  let sourceRId = null;
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getAttribute("name") === originalSheetName) {
      sourceRId = sheets[i].getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      break;
    }
  }

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

  const sourceFullPath = sourceSheetPath.startsWith("xl/") ? sourceSheetPath : `xl/${sourceSheetPath}`;
  const newSheetNum = 2;
  const newSheetFile = `worksheets/sheet${newSheetNum}.xml`;
  const newSheetFullPath = `xl/${newSheetFile}`;
  const newSheetName = originalSheetName + "_test2";

  // シートXMLをコピー（描画参照を除去）
  let sheetXml = await zip.file(sourceFullPath).async("string");
  sheetXml = sheetXml.replace(/<drawing[^/]*\/>/g, "");  // drawing参照を削除
  zip.file(newSheetFullPath, sheetXml);

  // workbook.xmlに追加
  const maxSheetId = Array.from(sheets).reduce(
    (max, s) => Math.max(max, parseInt(s.getAttribute("sheetId")) || 0), 0
  );
  zip.file("xl/workbook.xml", wbXml.replace(
    "</sheets>",
    `<sheet name="${newSheetName}" sheetId="${maxSheetId + 1}" r:id="rId200"/></sheets>`
  ));

  // workbook.xml.relsに追加
  zip.file("xl/_rels/workbook.xml.rels", wbRelsXml.replace(
    "</Relationships>",
    `<Relationship Id="rId200" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${newSheetFile}"/></Relationships>`
  ));

  // Content_Types追加
  let ctXml = await zip.file("[Content_Types].xml").async("string");
  ctXml = ctXml.replace("</Types>", `<Override PartName="/${newSheetFullPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("[Content_Types].xml", ctXml);

  // app.xml更新
  if (zip.file("docProps/app.xml")) {
    let appXml = await zip.file("docProps/app.xml").async("string");
    appXml = appXml.replace(
      /(<TitlesOfParts>\s*<vt:vector\s+size=")(\d+)("[\s\S]*?)(<\/vt:vector>\s*<\/TitlesOfParts>)/,
      (m, pre, sz, mid, suf) => `${pre}${parseInt(sz) + 1}${mid}<vt:lpstr>${newSheetName}</vt:lpstr>${suf}`
    );
    appXml = appXml.replace(
      /(<HeadingPairs>[\s\S]*?<vt:i4>)(\d+)(<\/vt:i4>)/,
      (m, pre, cnt, suf) => `${pre}${parseInt(cnt) + 1}${suf}`
    );
    zip.file("docProps/app.xml", appXml);
  }

  const buf = await zip.generateAsync({ type: "arraybuffer" });
  downloadBuffer(buf);
  alert("テスト2完了: drawing/chartなしでシート追加のみ");
};
