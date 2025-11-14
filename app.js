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
    const originalInput = document.getElementById('jp-input');
    const translatedOutput = document.getElementById('cn-output');
    const anyInput = document.getElementById('any-input');
    const jpOutput = document.getElementById('jp-output');
    
    // 1番目のセクションの(➔)ボタン
    const jpCnBtn = document.querySelector('button[onclick*="jp-input"]');
    // 2番目のセクションの(➔)ボタン
    const anyJpBtn = document.querySelector('button[onclick*="any-input"]');

    const originalText = originalInput.value;
    if (!originalText || originalText.trim() === "") {
        showToast("原文（日本語）を入力してください。");
        return;
    }

    setButtonLoading(button, true); // (↻)ボタンをローディング開始

    try {
        // --- ステップ1: 日本語 -> 中国語 ---
        setButtonLoading(jpCnBtn, true); // (➔)ボタンもローディング
        
        const systemPrompt1 = `あなたはプロの翻訳者です。以下のテキストを「日本語」から「中国語」に翻訳してください。`;
        const res1 = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemPrompt: systemPrompt1, userPrompt: originalText })
        });
        const data1 = await res1.json();
        if (!res1.ok) throw new Error(data1.error || '日→中 翻訳エラー');
        
        const chineseText = data1.translatedText.trim();
        translatedOutput.value = chineseText; // 中国語欄を更新
        updateComparisonLog(originalText, chineseText); // ログも更新
        setButtonLoading(jpCnBtn, false); // (➔)ボタンのローディング解除

        // --- ステップ2: 中国語 -> 日本語 ---
        anyInput.value = chineseText; // 任意言語欄に中国語をセット
        setButtonLoading(anyJpBtn, true); // 2番目の(➔)ボタンをローディング

        const systemPrompt2 = "あなたはプロの翻訳者です。以下のテキストを「中国語」から「日本語」に翻訳してください。";
        const res2 = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ systemPrompt: systemPrompt2, userPrompt: chineseText })
        });
        const data2 = await res2.json();
        if (!res2.ok) throw new Error(data2.error || '中→日 翻訳エラー');

        const reversedText = data2.translatedText.trim();
        jpOutput.value = reversedText; // 最終的な日本語欄を更新
        setButtonLoading(anyJpBtn, false); // 2番目の(➔)ボタンのローディング解除

        showToast("ワンクリック逆翻訳が完了しました。");

    } catch (err) {
        console.error("逆翻訳エラー:", err);
        showToast(`エラー: ${err.message}`);
        // エラーが起きたらすべてのボタンをリセット
        setButtonLoading(jpCnBtn, false);
        setButtonLoading(anyJpBtn, false);
    } finally {
        setButtonLoading(button, false); // (↻)ボタンのローディング解除
    }
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
    
    // 原文と訳文のみ表示
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
