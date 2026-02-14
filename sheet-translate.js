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
  const ids = ["excel-file", "to-lang", "sheet-context", "translate-btn"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  // チェックボックスも制御
  document.querySelectorAll('#sheet-checklist input[type="checkbox"]').forEach(cb => {
    cb.disabled = disabled;
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

    // チェックボックスリストを生成
    const checklist = document.getElementById("sheet-checklist");
    checklist.innerHTML = "";
    workbook.eachSheet((sheet) => {
      const label = document.createElement("label");
      label.style.cssText = "display:block; cursor:pointer; padding:3px 0; font-size:0.9rem; user-select:none;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = sheet.name;
      cb.checked = false; // デフォルトは未選択
      cb.style.cssText = "width:auto; margin:0; margin-right:6px; cursor:pointer; vertical-align:middle;";
      label.appendChild(cb);
      label.appendChild(document.createTextNode(sheet.name));
      checklist.appendChild(label);
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

// ====== ZIPレベル シートパス特定 ======
// workbook.xml.relsからシート名に対応するXMLファイルパスを取得する

async function getSheetPathInZip(zip, sheetName) {
  const parser = new DOMParser();

  const wbXml = await zip.file("xl/workbook.xml").async("string");
  const wbDoc = parser.parseFromString(wbXml, "application/xml");
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const sheets = wbDoc.getElementsByTagNameNS(ns, "sheet");

  let sourceRId = null;
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getAttribute("name") === sheetName) {
      sourceRId = sheets[i].getAttributeNS(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"
      );
      break;
    }
  }
  if (!sourceRId) throw new Error("シートがworkbook.xml内に見つかりません");

  const wbRelsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const wbRelsDoc = parser.parseFromString(wbRelsXml, "application/xml");
  const rels = wbRelsDoc.getElementsByTagName("Relationship");

  let sheetPath = null;
  for (let i = 0; i < rels.length; i++) {
    if (rels[i].getAttribute("Id") === sourceRId) {
      sheetPath = rels[i].getAttribute("Target");
      break;
    }
  }
  if (!sheetPath) throw new Error("シートのファイルパスが特定できません");

  return sheetPath.startsWith("xl/") ? sheetPath : `xl/${sheetPath}`;
}

// ====== ZIPレベル 翻訳テキスト書き込み ======
// シートXMLのセル値を直接インライン文字列で置き換える
// ファイル構造を変更しないので、グラフ・図形・画像はすべて保持される

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

    // セル要素を正規表現で検索
    const cellRegex = new RegExp(
      '(<c\\b[^>]*?\\br="' + addr + '")([^>]*)>([\\s\\S]*?)</c>',
      ''
    );

    const before = sheetXml;
    sheetXml = sheetXml.replace(cellRegex, (match, prefix, rest) => {
      const cleanPrefix = prefix.replace(/\s+t="[^"]*"/, "");
      const cleanRest = rest.replace(/\s+t="[^"]*"/, "");
      matchCount++;
      return `${cleanPrefix} t="inlineStr"${cleanRest}><is><t>${escaped}</t></is></c>`;
    });

    if (before === sheetXml && idx < 5) {
      console.warn(`[sheet-trans] セル ${addr} がマッチしませんでした`);
    }
  });

  zip.file(sheetPath, sheetXml);
  console.log(`[sheet-trans] 翻訳書き込み完了: ${matchCount}/${cellRefs.length}セル`);
}

// ====== 翻訳対象収集ロジック ======
function collectCellsToTranslate(sheet) {
  const cellRefs = [];
  const texts = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const val = cell.value;
      let text = null;

      if (typeof val === "string" && val.trim().length > 0) {
        text = val.trim();
      } else if (val && typeof val === "object") {
        if (val.richText) {
          const joined = val.richText.map(r => r.text).join("").trim();
          if (joined.length > 0) text = joined;
        } else if (val.text && typeof val.text === "string") {
          text = val.text.trim();
        }
      }

      if (text) {
        cellRefs.push({ r: rowNumber, c: colNumber });
        texts.push(text);
      }
    });
  });

  return { cellRefs, texts };
}

// ====== API呼び出し ======
async function callSheetTranslateAPI(rows, toLang, context, onProgress) {
  const BATCH = 30;
  const results = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const body = { rows: batch, toLang };
    if (context) body.context = context;

    const resp = await fetch("/api/translate?op=sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`API error (${resp.status}): ${errText}`);
    }

    const data = await resp.json();
    results.push(...data.translations);
    if (onProgress) onProgress(results.length, rows.length);
  }
  return results;
}

// ====== メイン処理 ======
// ファイル分離方式: 元ファイルのコピーに翻訳を直接適用して別ファイルとしてダウンロード
// シートの追加・複製は行わないため、グラフ・図形・画像がすべて保持される
async function handleTranslateClick() {
  if (!EXCEL_workbook || !EXCEL_arrayBuffer) {
    showError("ファイルを選択してください");
    return;
  }

  // 選択されたシート名を取得
  const selectedSheets = [];
  document.querySelectorAll('#sheet-checklist input[type="checkbox"]:checked').forEach(cb => {
    selectedSheets.push(cb.value);
  });

  if (selectedSheets.length === 0) {
    showError("翻訳するシートを1つ以上選択してください");
    return;
  }

  const toLang = document.getElementById("to-lang").value;
  const context = document.getElementById("sheet-context").value;

  try {
    toggleUI(true);
    showLoading(true, 0, 0);

    // 各シートの翻訳情報を収集
    setStatus(`翻訳対象を収集中...（${selectedSheets.length}シート）`);
    const sheetInfos = [];
    let totalTexts = 0;

    for (const sheetName of selectedSheets) {
      const sheet = EXCEL_workbook.getWorksheet(sheetName);
      const info = collectCellsToTranslate(sheet);
      if (info.texts.length > 0) {
        sheetInfos.push({ name: sheetName, info });
        totalTexts += info.texts.length;
      }
    }

    if (sheetInfos.length === 0) {
      showLoading(false);
      alert("翻訳対象となるテキストが見つかりませんでした。");
      return;
    }

    // 各シートの翻訳をAPIで取得
    let doneTexts = 0;
    showLoading(true, totalTexts, 0);
    const allTranslations = [];

    for (const si of sheetInfos) {
      const translations = await callSheetTranslateAPI(si.info.texts, toLang, context, (done, total) => {
        showLoading(true, totalTexts, doneTexts + done);
      });
      allTranslations.push(translations);
      doneTexts += si.info.texts.length;
      showLoading(true, totalTexts, doneTexts);
    }

    // ZIPとして読み込み、全シートに翻訳を適用
    setStatus("翻訳を適用中...");
    const zip = await JSZip.loadAsync(EXCEL_arrayBuffer);

    for (let i = 0; i < sheetInfos.length; i++) {
      const sheetPath = await getSheetPathInZip(zip, sheetInfos[i].name);
      await applyTranslationsToZip(zip, sheetPath, sheetInfos[i].info.cellRefs, allTranslations[i]);
    }

    // 別ファイルとしてダウンロード
    setStatus("ファイルを生成中...");
    const outputBuffer = await zip.generateAsync({ type: "arraybuffer" });
    downloadBuffer(outputBuffer);

    setStatus("完了");
    showLoading(false);
    const msg = sheetInfos.length === 1
      ? "翻訳が完了しました。\n翻訳済みファイルがダウンロードされました。"
      : `翻訳が完了しました。\n${sheetInfos.length}シートを翻訳したファイルがダウンロードされました。`;
    alert(msg);

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
