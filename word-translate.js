let WORD_file = null;
let WORD_fileName = null;
let WORD_arrayBuffer = null;

// ====== UI制御系 ======
function setStatus(message) {
  const el = document.getElementById("status-text");
  if (el) el.textContent = message;
  console.log("[word-trans] " + message);
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
  console.error("[word-trans] ERROR:", message);
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
  const ids = ["word-file", "to-lang", "word-context", "translate-btn"];
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
  
  WORD_file = file;
  WORD_fileName = file.name.replace(/\.docx$/i, "");
  WORD_arrayBuffer = await file.arrayBuffer();
  
  setStatus(`読込完了: ${file.name}`);
}

function setupDragAndDrop() {
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("word-file");
  if (!dropZone || !fileInput) return;
  
  dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
  dropZone.addEventListener("dragleave", (e) => { e.preventDefault(); dropZone.classList.remove("drag-over"); });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) {
      fileInput.files = e.dataTransfer.files;
      WORD_file = file;
      WORD_fileName = file.name.replace(/\.docx$/i, "");
      file.arrayBuffer().then(buf => {
          WORD_arrayBuffer = buf;
          setStatus(`読込完了: ${file.name}`);
      });
    }
  });
}

// ====== Word解析・翻訳ロジック ======

async function processWordTranslation(arrayBuffer, toLang, context) {
  const zip = new JSZip();
  const loadedZip = await zip.loadAsync(arrayBuffer);

  const docXmlPath = "word/document.xml";
  if (!loadedZip.files[docXmlPath]) {
    throw new Error("有効なWordファイルではありません (document.xmlが見つかりません)");
  }

  const docXmlStr = await loadedZip.files[docXmlPath].async("string");
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(docXmlStr, "application/xml");
  
  const parseError = xmlDoc.getElementsByTagName("parsererror");
  if (parseError.length > 0) {
    throw new Error("Wordファイルの解析に失敗しました (XML Parse Error)");
  }

  const textNodes = xmlDoc.getElementsByTagName("w:t");
  const textsToTranslate = [];
  const nodeIndices = []; 

  for (let i = 0; i < textNodes.length; i++) {
    const node = textNodes[i];
    const text = node.textContent;

    if (!text || text.trim() === "") continue;
    if (/^[0-9\s.,\-%]+$/.test(text)) continue; 
    if (/^[A-Za-z0-9\s.,\-%]+$/.test(text) && text.length <= 3) continue;

    textsToTranslate.push(text);
    nodeIndices.push(i);
  }

  if (textsToTranslate.length === 0) {
    throw new Error("翻訳対象となるテキストが見つかりませんでした。");
  }

  showLoading(true, textsToTranslate.length, 0);
  
  const translatedTexts = await callWordTranslateAPI(textsToTranslate, toLang, context, (done, total) => {
      showLoading(true, total, done);
  });

  for (let k = 0; k < nodeIndices.length; k++) {
    const index = nodeIndices[k];
    const node = textNodes[index];
    const translated = translatedTexts[k];

    if (translated) {
        node.textContent = translated;
    }
  }

  const serializer = new XMLSerializer();
  const newDocXmlStr = serializer.serializeToString(xmlDoc);

  loadedZip.file(docXmlPath, newDocXmlStr);

  const outBlob = await loadedZip.generateAsync({
      type: "blob",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
  
  return outBlob;
}

// ====== API呼び出し ======
async function callWordTranslateAPI(rows, toLang, context, onProgress) {
  // ★変更点: バッチサイズを 30 -> 10 に縮小して安定化
  const BATCH_SIZE = 10; 
  const allTranslations = [];
  const total = rows.length;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    
    const res = await fetch("/api/translate?op=word", {

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
       // エラー詳細に数を含めてデバッグしやすくする
       throw new Error(`翻訳整合性エラー: 送信数(${batch.length})と受信数(${data.translations?.length})が一致しません。`);
    }

    allTranslations.push(...data.translations);
    if (onProgress) onProgress(Math.min(i + BATCH_SIZE, total), total);
  }
  return allTranslations;
}

// ====== メイン処理 ======
async function handleTranslateClick() {
  if (!WORD_arrayBuffer) {
    showError("ファイルを選択してください");
    return;
  }

  const toLang = document.getElementById("to-lang").value;
  const context = document.getElementById("word-context").value;

  try {
    toggleUI(true);
    showLoading(true, 0, 0);
    setStatus("Wordファイルを解析中...");

    const blob = await processWordTranslation(WORD_arrayBuffer, toLang, context);

    setStatus("完了");
    showLoading(false);

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (WORD_fileName || "document") + "_翻訳.docx";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    alert("翻訳が完了しました。");

  } catch (e) {
    showError(e.message);
  } finally {
    toggleUI(false);
    showLoading(false);
  }
}

// ====== 初期化 ======
document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("word-file");
  if (fileInput) fileInput.addEventListener("change", handleFileSelected);

  const btn = document.getElementById("translate-btn");
  if (btn) btn.addEventListener("click", handleTranslateClick);

  const closeErr = document.getElementById("error-close");
  if (closeErr) closeErr.addEventListener("click", hideErrorModal);

  setupDragAndDrop();
});
