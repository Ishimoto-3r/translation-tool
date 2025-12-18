/**
 * VercelのバックエンドAPIを呼び出す関数
 * ★ 元の callOpenAIAPI から書き換えています ★
 */
async function callOpenAIAPI(systemPrompt, userPrompt) {
    try {
        // Vercelのバックエンド (/api/translate) を呼び出す
        const response = await fetch('/api/translate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                systemPrompt: systemPrompt,
                userPrompt: userPrompt
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error("バックエンドAPIエラー:", errorData);
            
            // Vercelバックエンドからのエラーメッセージをトーストで表示
            const errorMessage = errorData.error || `APIエラー (Status: ${response.status})`;
            showToast(errorMessage);

            throw new Error(errorMessage);
        }

        const data = await response.json();
        
        if (!data.translatedText) {
             console.error("APIレスポンスの形式が不正です:", data);
             showToast("APIから予期しない形式の応答がありました。");
             throw new Error("Invalid API response format");
        }
        
        return data.translatedText; // バックエンドが整形した結果を返す

    } catch (error) { 
        console.error("通信エラー:", error);
        if (!error.message.startsWith("APIエラー")) { // 既にトーストが表示されているエラーは除く
             showToast("翻訳サーバーへの通信に失敗しました。");
        }
        return null; // エラー時はnullを返す
    }
}

function hasKana(s) {
  return /[\u3040-\u309F\u30A0-\u30FF]/.test(s || "");
}


/**
 * 通常の翻訳処理
 */
async function startTranslation(buttonElement, inputId, outputId, sourceLang, targetLang, inputText = null, shouldCopy = true) {
    const text = inputText ? inputText : document.getElementById(inputId).value;
    if (!text) return;

    const outputElement = document.getElementById(outputId);
    outputElement.value = "翻訳中...";

    // --- ローディング開始 ---
    let originalContent = null;
    if (buttonElement) {
        originalContent = buttonElement.innerHTML;
        buttonElement.disabled = true;
        buttonElement.innerHTML = '<div class="loader"></div>';
    }
    // --- ローディングここまで ---

try {
    const isJapaneseTarget = (targetLang === "日本語");

    const systemPrompt = `
あなたはプロの翻訳者です。
出力は必ず「${targetLang}」で返してください。
${isJapaneseTarget ? "原文が日本語以外の場合は、短文・単語・記号が多くても必ず日本語に翻訳してください。原文をそのまま返すことは禁止です。" : ""}
型番・数値・記号（USB-C, ODM, 3.7V など）は可能な限り保持してください。
余計な解説や前置きは不要です。翻訳結果の本文のみ返してください。
`.trim();

let translatedText = await callOpenAIAPI(systemPrompt, text);

// ★日本語ターゲット時：ひらがな/カタカナが1文字も無ければ「未翻訳」とみなして再試行
if (isJapaneseTarget && text.trim() && !hasKana(translatedText)) {
  const hardPrompt = `
あなたはプロの翻訳者です。
次の文章を「日本語（です・ます調）」に翻訳してください。
重要：出力に中国語の文として成立する文章を出さないでください。
必ず日本語として成立する文章にし、ひらがな/カタカナを含めてください。
余計な解説は不要。翻訳結果のみ返してください。
`.trim();

  translatedText = await callOpenAIAPI(hardPrompt, text);
}


        if (translatedText) {
            outputElement.value = translatedText;
            
            // --- クリップボードコピーロジック ---
            // ★★★ 修正: 自動コピー機能をすべて削除 ★★★
            if (shouldCopy) {
                if (inputId === 'jp-input') {
                    updateComparisonLog(translatedText, text);
                    
                    // autoCopyToClipboard(translatedText, "訳文 (中国語) をコピーしました");
                    
                } else {
                    // autoCopyToClipboard(translatedText, "訳文をコピーしました");
                }
            }
            // --- コピーロジックここまで ---
            
            return translatedText; // 逆翻訳で使うため
        } else {
            outputElement.value = "翻訳に失敗しました。";
            return null;
        }
    } catch (error) {
        console.error("startTranslation内でのエラー:", error);
        outputElement.value = "翻訳に失敗しました。";
        return null;
    } finally {
        // --- ローディング終了 ---
        if (buttonElement) {
            buttonElement.disabled = false;
            buttonElement.innerHTML = originalContent;
        }
    }
}

/**
 * 逆翻訳（日本語→中国語→日本語）の処理
 */
async function startReverseTranslation(buttonElement) {
    const jpInputText = document.getElementById('jp-input').value;
    if (!jpInputText) return;

    // --- ローディング開始 ---
    const originalContent = buttonElement.innerHTML;
    buttonElement.disabled = true;
    buttonElement.innerHTML = '<div class="loader"></div>';

    let chineseText = null;
    // --- ローディングここまで ---
    
    try {
        // 1. 日本語 → 中国語
        const systemPrompt = `${'日本語'}を${'中国語'}に翻訳してください。余計な解説は付けず、翻訳結果のテキストのみを返してください。`;
        chineseText = await callOpenAIAPI(systemPrompt, jpInputText);

        if (!chineseText) {
            // ★修正：alertの代わりにトースト通知
            showToast("最初の翻訳（日本語→中国語）に失敗したため、逆翻訳を中断します。");
            document.getElementById('cn-output').value = "翻訳に失敗しました。";
            throw new Error("Initial translation failed.");
        }
        
        document.getElementById('cn-output').value = chineseText;

        // 2. 中国語を「任意の言語→日本語」の入力欄にコピー
        const anyInputElement = document.getElementById('any-input');
        anyInputElement.value = chineseText;

        // 3. 中国語 → 日本語（自動実行）
        document.getElementById('jp-output').value = "逆翻訳中...";
        
        // 逆翻訳時は「任意の言語→日本語」のボタン(null)を渡し、
        // 内部でのクリップボードコピーを無効化 (shouldCopy = false)
        const reversedJapaneseText = await startTranslation(null, 'any-input', 'jp-output', '中国語', '日本語', chineseText, false);

        // 4. 比較ログの更新（逆翻訳版）
        if (reversedJapaneseText) {
            updateComparisonLog(chineseText, reversedJapaneseText);

            // ★★★ 修正: 自動コピー機能をすべて削除 ★★★
            // autoCopyToClipboard(reversedJapaneseText, "逆翻訳 (日本語) をコピーしました");

        } else {
            // 比較ログをエラー表示
            updateComparisonLog(chineseText, "（日本語への再翻訳に失敗しました）");
            
            // ★★★ 修正: 自動コピー機能をすべて削除 ★★★
            // autoCopyToClipboard(chineseText, "訳文 (中国語) をコピーしました");
        }
    } catch (error) {
        console.error("startReverseTranslation内でのエラー:", error);
        // (エラー処理は内部で実行済み、またはトースト通知が出ている)
    } finally {
        // --- 'finally' ブロックを追加してローディングを終了 ---
        buttonElement.disabled = false;
        buttonElement.innerHTML = originalContent;
    }
}

// --- ユーティリティ関数 ---
function updateComparisonLog(chineseText, japaneseText) {
    // ★変更: ログテキスト専用エレメントに書き込む
    const logTextElement = document.getElementById('comparison-log-text');
    if (!logTextElement) return;
    // 常に内容を上書き（過去のログは削除）
    logTextElement.textContent = `${chineseText}\n\n${japaneseText}`;
}


/**
 * 信頼性の高いクリップボードコピー（自動実行用）
 * @param {string} text - コピーするテキスト
 * @param {string} message - 表示する通知メッセージ
 */
function autoCopyToClipboard(text, message) {
    if (text === null || typeof text === 'undefined') return;
    
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "absolute";
    textArea.style.left = "-9999px"; // 画面外に隠す
    document.body.appendChild(textArea);
    textArea.select();
    
    try {
        // document.execCommand('copy') は古いですが、iFrame環境での信頼性が高いため採用
        document.execCommand('copy');
        // 成功時の通知
        if(message) {
            showToast(message);
        }
    } catch (err) {
        console.error('自動クリップボードコピーに失敗しました:', err);
        // 自動コピー失敗時はアラートを出さない
        // ★手動コピーボタンから呼ばれた場合を考慮し、トーストで失敗を通知
        showToast("コピーに失敗しました。");
    }
    document.body.removeChild(textArea);
}

/**
 * トースト通知を表示する
 */
function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return; // コンテナがない場合は何もしない
    
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    
    container.appendChild(toast);
    
    // 表示アニメーション
    setTimeout(() => {
        toast.classList.add('show');
    }, 10); // すぐにクラスを追加

    // 3秒後に消す
    setTimeout(() => {
        toast.classList.remove('show');
        // アニメーション後にDOMから削除
        setTimeout(() => {
            if (container.contains(toast)) {
                container.removeChild(toast);
            }
        }, 500); // CSSのtransition時間と合わせる
    }, 3000);
}

/**
 * 手動コピーボタン用（フォールバック付き）
 */
function copyToClipboard(elementId, message) { // ★message引数を追加
    const text = document.getElementById(elementId).value;
    if (text) {
        // iFrame環境を考慮し、自動コピーと同じロジック(execCommand)を使用
        // ★渡されたメッセージ、またはデフォルトメッセージを使用
        autoCopyToClipboard(text, message || "コピーしました");
    } else {
        showToast("コピーするテキストがありません。");
    }
}

/**
 * ★新設: 比較ログを手動コピーする
 */
function copyComparisonLog() {
    const logTextElement = document.getElementById('comparison-log-text');
    const text = logTextElement ? logTextElement.textContent : null;
    
    if (text && text.trim() !== "") {
        // ★★★ 修正: ボタンの文言変更に伴い、トーストメッセージも変更 ★★★
        autoCopyToClipboard(text, "コピーしました");
    } else {
        showToast("コピーするログ内容がありません。");
    }
}

/**
 * ★修正: 複数のテキストエリアを一括クリアする
 * @param {string[]} elementIds - クリアする要素のID配列
 */
function clearText(elementIds) {
    let clearedJpInput = false;
    
    elementIds.forEach(elementId => {
        const element = document.getElementById(elementId);
        if (element) {
            element.value = "";
        }
        
        // 「日本語→中国語」の原文がクリア対象に含まれていたかチェック
        if (elementId === 'jp-input') {
            clearedJpInput = true;
        }
    });

    // 「日本語→中国語」の原文を消したらログも消す
    if (clearedJpInput) {
        const logTextElement = document.getElementById('comparison-log-text');
        if (logTextElement) {
            logTextElement.textContent = "";
        }
    }
}

/**
 * 比較ログの表示/非表示を切り替える
 */
function toggleComparisonLog() {
    const logElement = document.getElementById('comparison-log');
    const btnElement = document.getElementById('log-toggle-btn');
    
    if (!logElement || !btnElement) return;

    if (logElement.style.display === 'none') {
        logElement.style.display = 'block';
        btnElement.textContent = '[-]';
    } else {
        logElement.style.display = 'none';
        btnElement.textContent = '[+]';
    }
}


