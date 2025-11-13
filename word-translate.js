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
      // 手動発火
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

// XMLテキストから特殊文字をエスケープ解除/再エスケープ
// (簡単な実装として、テキストコンテンツをそのまま扱うDOMParserを使用)

async function processWordTranslation(arrayBuffer, toLang, context) {
  const zip = new JSZip();
  const loadedZip = await zip.loadAsync(arrayBuffer);

  // Wordの本文は通常 "word/document.xml" にある
  const docXmlPath = "word/document.xml";
  if (!loadedZip.files[docXmlPath]) {
    throw new Error("有効なWordファイルではありません (document.xmlが見つかりません)");
  }

  // XMLをテキストとして取得
  const docXmlStr = await loadedZip.files[docXmlPath].async("string");
  
  // DOMParserでXMLをパース
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(docXmlStr, "application/xml");
  
  // エラーチェック
  const parseError = xmlDoc.getElementsByTagName("parsererror");
  if (parseError.length > 0) {
    throw new Error("Wordファイルの解析に失敗しました (XML Parse Error)");
  }

  // <w:t> タグ（テキストノード）をすべて取得
  const textNodes = xmlDoc.getElementsByTagName("w:t");
  const textsToTranslate = [];
  const nodeIndices = []; // 翻訳対象のノードインデックスを記録

  for (let i = 0; i < textNodes.length; i++) {
    const node = textNodes[i];
    const text = node.textContent;

    // 空白のみ、数値のみ、短い記号のみはスキップ（Excel同様のフィルタ）
    if (!text || text.trim() === "") continue;
    if (/^[0-9\s.,\-%]+$/.test(text)) continue; // 数値のみ
    // 3文字以下の英数字記号のみもスキップ（単位など）
    if (/^[A-Za-z0-9\s.,\-%]+$/.test(text) && text.length <= 3) continue;

    textsToTranslate.push(text);
    nodeIndices.push(i);
  }

  if (textsToTranslate.length === 0) {
    throw new Error("翻訳対象となるテキストが見つかりませんでした。");
  }

  // API呼び出し
  showLoading(true, textsToTranslate.length, 0);
  
  const translatedTexts = await callWordTranslateAPI(textsToTranslate, toLang, context, (done, total) => {
      showLoading(true, total, done);
  });

  // 翻訳結果をXMLに書き戻す
  for (let k = 0; k < nodeIndices.length; k++) {
    const index = nodeIndices[k];
    const node = textNodes[index];
    const originalText = textsToTranslate[k];
    const translated = translatedTexts[k];

    if (translated) {
        node.textContent = translated;
    }
  }

  // XMLを文字列に戻す
  const serializer = new XMLSerializer();
  const newDocXmlStr = serializer.serializeToString(xmlDoc);

  // Zip内のファイルを更新
  loadedZip.file(docXmlPath, newDocXmlStr);

  // ファイル生成
  const outBlob = await loadedZip.generateAsync({
      type: "blob",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
  
  return outBlob;
}

// ====== API呼び出し ======
async function callWordTranslateAPI(rows, toLang, context, onProgress) {
  const BATCH_SIZE = 30; // Wordは文脈が大事なので少し少なめに
  const allTranslations = [];
  const total = rows.length;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    
    const res = await fetch("/api/word", {
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
       throw new Error("翻訳整合性エラー: 送受信数が一致しません");
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

    // ダウンロード
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
