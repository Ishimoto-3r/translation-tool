// ====== 翻訳メイン処理 ======

// 翻訳ボタンを押したときの処理
async function startTranslation(button, inputId, outputId, fromLang, toLang) {
    const inputEl = document.getElementById(inputId);
    const outputEl = document.getElementById(outputId);
    const text = inputEl.value;

    if (!text || text.trim() === "") {
        showToast("原文を入力してください。");
        return;
    }

    setButtonLoading(button, true); // ★ローディング開始
    outputEl.value = ""; // 訳文欄をクリア

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
        setButtonLoading(button, false); // ★ローディング終了
    }
}

// 逆翻訳ボタン（↻）を押したときの処理
async function startReverseTranslation(button) {
    const originalInput = document.getElementById('jp-input');
    const translatedOutput = document.getElementById('cn-output');
    
    const textToReverse = translatedOutput.value;
    if (!textToReverse || textToReverse.trim() === "") {
        showToast("逆翻訳するテキストがありません（先に日→中 翻訳を行ってください）。");
        return;
    }

    setButtonLoading(button, true); // ★ローディング開始

    try {
        // 中国語 → 日本語 への翻訳
        const systemPrompt = "あなたはプロの翻訳者です。以下のテキストを「中国語」から「日本語」に翻訳してください。";
        const userPrompt = textToReverse;

        const res = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemPrompt, userPrompt })
        });

        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || '逆翻訳APIエラー');
        }

        const reversedText = data.translatedText.trim();

        // 比較ログに「逆翻訳の結果」を追記
        updateComparisonLog(originalInput.value, textToReverse, reversedText);
        showToast("逆翻訳が完了しました。比較ログを確認してください。");

    } catch (err) {
        console.error("逆翻訳エラー:", err);
        showToast(`エラー: ${err.message}`);
    } finally {
        setButtonLoading(button, false); // ★ローディング終了
    }
}

// ====== UIヘルパー関数 ======

// ★ローディング表示を切り替える関数（新設）
function setButtonLoading(button, isLoading) {
    if (isLoading) {
        button.disabled = true;
        // 元のアイコン(➔ や ↻)を記憶
        button.dataset.originalContent = button.innerHTML;
        // ローダーに入れ替え
        button.innerHTML = '<div class="loader"></div>';
    } else {
        button.disabled = false;
        // 記憶していた元のアイコンに戻す
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
    // 日中翻訳の比較ログもクリア
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
function updateComparisonLog(jpText, cnText, reversedJpText = null) {
    const logTextEl = document.getElementById("comparison-log-text");
    if (!logTextEl) return;
    
    let logContent = `【日本語原文】\n${jpText}\n\n【中国語訳文】\n${cnText}`;
    
    if (reversedJpText !== null) {
        logContent += `\n\n【逆翻訳（中→日）】\n${reversedJpText}`;
    }
    
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

    // すぐに 'show' クラスを追加してフェードイン開始
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    // 3秒後にフェードアウトして削除
    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        });
    }, 3000);
}
