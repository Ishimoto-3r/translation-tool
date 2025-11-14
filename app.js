// ====== 翻訳メイン処理 ======

// 翻訳ボタン（➔）を押したときの処理
async function startTranslation(button, inputId, outputId, fromLang, toLang) {
    const inputEl = document.getElementById(inputId);
    const outputEl = document.getElementById(outputId);
    const text = inputEl.value;

    if (!text || text.trim() === "") {
        showToast("原文を入力してください。");
        return;
    }

    setButtonLoading(button, true); // ローディング開始
    outputEl.value = ""; 

    try {
        const systemPrompt = `あなたはプロの翻訳者です。以下のテキストを「${fromLang}」から「${toLang}」に翻訳してください。`;
        const userPrompt = text;

        const res = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemPrompt, userPrompt })
        });

        const data = await res.json();
        
        if (!res.ok) {
            throw new Error(data.error || '翻訳APIエラー');
        }

        outputEl.value = data.translatedText.trim();

        // 日中翻訳の場合のみ、比較ログを更新
        if (inputId === 'jp-input') {
            updateComparisonLog(text, data.translatedText);
        }

    } catch (err) {
        console.error("翻訳エラー:", err);
        showToast(`エラー: ${err.message}`);
        outputEl.value = `翻訳エラーが発生しました: ${err.message}`;
    } finally {
        setButtonLoading(button, false); // ローディング終了
    }
}

// 逆翻訳ボタン（↻）を押したときの処理
async function startReverseTranslation(button) {
    const translatedOutput = document.getElementById('cn-output'); // 日→中 の「訳文（中国語）」
    const textToReverse = translatedOutput.value;

    if (!textToReverse || textToReverse.trim() === "") {
        showToast("逆翻訳するテキストがありません（先に日→中 翻訳を行ってください）。");
        return;
    }

    // ★修正点：
    // 2番目のセクション「任意の言語→日本語」の入力欄と出力欄、ボタンを取得します。
    const anyInput = document.getElementById('any-input');
    const jpOutput = document.getElementById('jp-output');
    
    // 2番目のセクションの「➔」ボタンを見つけます
    // (any-input の親の親の...次の要素...のボタン)
    const anyTranslateBtn = document.querySelector('button[onclick*="any-input"]');

    if (!anyInput || !jpOutput || !anyTranslateBtn) {
        showError("エラー: 「任意の言語」セクションが見つかりません。");
        return;
    }

    // 1. 中国語を「任意の言語」の入力欄にコピーする
    anyInput.value = textToReverse;
    
    // 2. 「任意の言語→日本語」の翻訳を自動で実行する
    //    (すでにある startTranslation 関数を、2番目のボタンを対象に呼び出す)
    showToast("「任意の言語→日本語」セクションで翻訳を開始します。");
    await startTranslation(anyTranslateBtn, 'any-input', 'jp-output', '入力されたテキスト', '日本語');
    
    // 3. 比較ログからは逆翻訳の記述を削除
    // (startTranslation が自動でログ更新するので、ここでは何もしない)
}

// ====== UIヘルパー関数 ======

// ローディング表示を切り替える関数
function setButtonLoading(button, isLoading) {
    if (isLoading) {
        button.disabled = true;
        button.dataset.originalContent = button.innerHTML;
        button.innerHTML = '<div class="loader"></div>';
    } else {
        button.disabled = false;
        if (button.dataset.originalContent) {
            button.innerHTML = button.dataset.originalContent;
        }
    }
}

// テキストエリアをクリア
function clearText(ids) {
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
    });
    if (ids.includes('jp-input')) {
        updateComparisonLog("", "");
    }
    showToast("クリアしました");
}

// クリップボードにコピー
function copyToClipboard(elementId, message) {
    const text = document.getElementById(elementId).value;
    if (!text) {
        showToast("コピーする内容がありません");
        return;
    }
    navigator.clipboard.writeText(text).then(() => {
        showToast(message);
    }).catch(err => {
        console.error('コピー失敗:', err);
        showToast("コピーに失敗しました");
    });
}

// 比較ログの表示切り替え
function toggleComparisonLog() {
    const logDiv = document.getElementById("comparison-log");
    const btn = document.getElementById("log-toggle-btn");
    if (logDiv.style.display === "none") {
        logDiv.style.display = "block";
        btn.textContent = "[-]";
    } else {
        logDiv.style.display = "none";
        btn.textContent = "[+]";
    }
}

// 比較ログの内容を更新
function updateComparisonLog(jpText, cnText) {
    const logTextEl = document.getElementById("comparison-log-text");
    if (!logTextEl) return;
    
    // ★修正点：逆翻訳のロジックを削除。原文と訳文のみ表示。
    let logContent = `【日本語原文】\n${jpText}\n\n【中国語訳文】\n${cnText}`;
    
    logTextEl.textContent = logContent;
}

// 比較ログをコピー
function copyComparisonLog() {
    const text = document.getElementById("comparison-log-text").textContent;
    if (!text || text.trim() === "") {
        showToast("コピーするログがありません");
        return;
    }
    navigator.clipboard.writeText(text).then(() => {
        showToast("比較ログをコピーしました");
    }).catch(err => {
        console.error('コピー失敗:', err);
        showToast("コピーに失敗しました");
    });
}

// Toast通知を表示
function showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        });
    }, 3000);
}
