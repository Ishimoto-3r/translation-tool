// --- JavaScript (動作) ---

// --- DOM要素の取得 ---
const checkY = document.getElementById('reproduced-y');
const checkN = document.getElementById('reproduced-n');
const generateButton = document.getElementById('generate-report');
const resultOutput = document.getElementById('result-output');
const inquiryInput = document.getElementById('inquiry');
const verificationInput = document.getElementById('verification');
const copyButton = document.getElementById('copy-report-btn');
const clearButtonTop = document.getElementById('clear-all-btn-top');
const causeInput = document.getElementById('cause');
const questionInput = document.getElementById('question');
const actionInput = document.getElementById('action');
const remarksInput = document.getElementById('remarks');
const remarksLabel = document.getElementById('remarks-label');

// ★ 0番「5年以上経過」用
const over5YYes = document.getElementById('over5y-y');
const over5YNo = document.getElementById('over5y-n');
const over5YWarning = document.getElementById('over5y-warning');


// --- チェックボックスの排他制御（再現有無） ---
checkY.addEventListener('change', () => {
    if (checkY.checked) {
        checkN.checked = false;
    }
    toggleSections();
});
checkN.addEventListener('change', () => {
    if (checkN.checked) {
        checkY.checked = false;
    }
    toggleSections();
});

// --- 0番「5年以上経過」チェックボックスの排他制御 & 注意表示 ---
if (over5YYes && over5YNo) {
    over5YYes.addEventListener('change', () => {
        if (over5YYes.checked) {
            over5YNo.checked = false;
            if (over5YWarning) over5YWarning.classList.remove('hidden');
        } else {
            if (over5YWarning) over5YWarning.classList.add('hidden');
        }
    });

    over5YNo.addEventListener('change', () => {
        if (over5YNo.checked) {
            over5YYes.checked = false;
            if (over5YWarning) over5YWarning.classList.add('hidden');
        }
    });
}

// --- セクション表示の切り替え（再現有無）---
function toggleSections() {
    const reproducedY = checkY.checked;
    document.getElementById('section-reproduced-y-cause').classList.toggle('hidden', !reproducedY);
    document.getElementById('section-reproduced-y-action').classList.toggle('hidden', !reproducedY);
    document.getElementById('section-reproduced-n-question').classList.toggle('hidden', reproducedY);

    if (reproducedY) {
        remarksLabel.textContent = "6. 備考";
    } else {
        remarksLabel.textContent = "5. 備考";
    }

    // ★Aram Wi-Fiチェックボックスの表示制御
    const aramSection = document.getElementById('aram-wifi-section');
    const aramCheck = document.getElementById('aram-wifi');
    if (aramSection) {
        if (!reproducedY && checkN.checked) {
            aramSection.classList.remove('hidden');
        } else {
            aramSection.classList.add('hidden');
            if (aramCheck) aramCheck.checked = false; // 非表示時はチェックも外す
        }
    }
}

// --- 実行ボタンのクリック処理 ---
generateButton.addEventListener('click', async () => {

    // 必須項目のバリデーション
    if (inquiryInput.value.trim() === "") {
        resultOutput.innerHTML = '<span class="error-message">エラー: 「1. 問い合わせ内容」を入力してください。</span>';
        inquiryInput.focus();
        return;
    }
    if (!checkY.checked && !checkN.checked) {
        resultOutput.innerHTML = '<span class="error-message">エラー: 「2. 再現有無」を選択してください。</span>';
        return;
    }
    if (verificationInput.value.trim() === "") {
        resultOutput.innerHTML = '<span class="error-message">エラー: 「3. 検証内容」を入力してください。</span>';
        verificationInput.focus();
        return;
    }

    // --- バリデーション (入力チェック) ---
    const verificationText = verificationInput.value.trim();
    if (verificationText.length > 3000) {
        alert(`検証内容が長すぎます（現在${verificationText.length}文字）。3000文字以内で入力してください。`);
        return;
    }

    // ローディング開始
    const originalButtonText = "最終レポートを生成";
    generateButton.innerHTML = '<div class="loader"></div> 生成中...';
    generateButton.disabled = true;
    resultOutput.textContent = 'GPT-5 APIに問い合わせ中です...';
    resultOutput.classList.remove('error-message');

    // フォームデータを収集
    const aramCheck = document.getElementById('aram-wifi'); // ★追加
    const formData = {
        over5Years: over5YYes && over5YYes.checked ? 'y' : 'n',
        inquiry: inquiryInput.value,
        reproduced: checkY.checked ? 'y' : 'n',
        aramWifi: aramCheck && aramCheck.checked ? 'y' : 'n', // ★追加
        verification: verificationInput.value,
        cause: causeInput.value,
        question: questionInput.value,
        action: actionInput.value,
        remarks: remarksInput.value
    };

    // APIに送信するプロンプトを構築
    const finalPrompt = buildApiPrompt(formData);

    try {
        // --- Vercel バックエンド連携 ---
        const response = await fetch('/api/report', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                finalPrompt: finalPrompt
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMsg = errorData.error || `APIエラー (Status: ${response.status})。サーバーが応答しませんでした。`;
            throw new Error(errorMsg);
        }

        const data = await response.json();

        if (!data.gptResponse) {
            throw new Error("APIから予期しない形式の応答がありました。");
        }

        const gptResponse = data.gptResponse;



        // 最終結果を表示
        resultOutput.textContent = gptResponse.trim();

    } catch (error) {
        console.error('API呼び出しエラー:', error);

        if (error.message.includes("JSON.parse")) {
            resultOutput.innerHTML = `<span class="error-message">エラー: サーバーから予期しない応答がありました。<br>ファイルパス (api/report.js) が正しいか確認してください。</span>`;
        } else {
            resultOutput.innerHTML = `<span class="error-message">エラーが発生しました: ${error.message}</span>`;
        }

    } finally {
        // ローディング終了
        generateButton.innerHTML = originalButtonText;
        generateButton.disabled = false;
    }
});

// --- APIに送信するプロンプトを組み立てる関数 ---
function buildApiPrompt(data) {
    const getVal = (val) => (val && val.toLowerCase() !== 'n' && val.trim() !== '') ? val.trim() : 'なし';
    const isAramWifi = data.aramWifi === 'y'; // ★Aramフラグ

    return `あなたは「修理担当者のための対話型レポート作成アシスタント」です。
以下のルールと入力データに基づき、最終的なレポート文を1つのテキストブロックで生成してください。
【最終出力ルール】
- 見出し・項目名・箇条書きは一切使用しない。
- 「お問い合わせ内容」のテキストは絶対に出力に含めない。
- すべて日本語の敬体（です・ます）で、簡潔な社内チャット向けの文体にする。
- 買い替え提案（例：「買い替えをご提案します」「新しい製品をご検討ください」など）は禁止します。
  入力に含まれていても、最終出力には絶対に含めないでください。
- 技術的断定は避け、「〜の可能性がある」「〜の可能性が高い」という表現を必ず使用する。
- ユーザーが入力した要素が「なし」（空欄または 'n'）の場合、その要素は最終文に絶対に含めない。
- ただし、「検証内容」は常に出力に含める。
- 数値・型番・単位は半角で記載する（例: 5V, 1m）。
- 購入からの年数にかかわらず、開発側から積極的に買い替えを勧める表現（「買い替えをご提案します」など）は基本的に使用しない。
- 冗長な重複は避け、「。」「、」を用い、複数の文を自然に接続する。
${isAramWifi ? '- ★重要★ 文末（備考の前あたり）に「お客様の使用環境(電波干渉等)によるものが考えられるため、機器のチャネル帯を変更します。」という文言を必ず追加してください。' : ''}
【構成順】
1. （必須）「お問い合わせのあった、[不具合症状の要約]という症状は[再現しました/再現しませんでした]。」
2. （必須）[検証内容]の要点（条件・手順・観察結果など）を自然な文章で続ける。
3. （再現時・原因入力あり）「[原因]が原因の可能性が高いです。」と続ける。
4. （再現時・原因入力なし）[検証内容]と[不具合症状]からAIが推測した原因を、「〜が原因の可能性が高いです。」と続ける。
5. （未再現時・質問入力あり）「お手数ですが、[お客様への質問]についてご教示ください。」と続ける。
6. （再現時・処置入力あり）「対応として[必要な処置]が必要です。」と続ける。
7. （備考入力あり）「なお、[備考]。」と続ける。
【入力データ】
- 購入から5年以上経過: ${data.over5Years} (y/n)
- お問い合わせ内容（症状の要約に利用）: ${data.inquiry}
- 再現有無: ${data.reproduced} (y/n)
- 検証内容: ${data.verification}
- （再現時）原因: ${getVal(data.cause)}
- （未再現時）お客様への質問: ${getVal(data.question)}
- （再現時）必要な処置: ${getVal(data.action)}
- 備考: ${getVal(data.remarks)}
最終出力のみを生成してください。
`;
}


// --- トースト通知を表示する関数 ---
function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            if (container.contains(toast)) {
                container.removeChild(toast);
            }
        }, 500);
    }, 3000);
}

// --- クリップボードにコピーする関数 (iFrame対応) ---
function copyReportToClipboard() {
    const textToCopy = resultOutput.textContent;
    if (resultOutput.classList.contains('error-message') || textToCopy === '（ここに結果が表示されます）' || textToCopy.trim() === '') {
        showToast("コピーする内容がありません。");
        return;
    }
    const textArea = document.createElement("textarea");
    textArea.value = textToCopy;
    textArea.style.position = "absolute";
    textArea.style.left = "-9999px";
    document.body.appendChild(textArea);
    textArea.select();
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showToast("レポートをコピーしました。");
        } else {
            showToast("コピーに失敗しました。");
        }
    } catch (err) {
        console.error('コピーに失敗しました:', err);
        showToast("コピーに失敗しました。");
    }
    document.body.removeChild(textArea);
}

// --- 入力内容をすべてクリアする関数 ---
function clearAllInputs() {
    // 0番
    if (over5YNo && over5YYes) {
        over5YNo.checked = true;
        over5YYes.checked = false;
    }
    if (over5YWarning) {
        over5YWarning.classList.add('hidden');
    }

    inquiryInput.value = '';
    verificationInput.value = '';
    causeInput.value = '';
    questionInput.value = '';
    actionInput.value = '';
    remarksInput.value = '';
    resultOutput.textContent = '（ここに結果が表示されます）';
    resultOutput.classList.remove('error-message');
    checkN.checked = true;
    checkY.checked = false;
    toggleSections();
    showToast("入力内容をクリアしました。");
}

// --- 初期化処理 ---
function initialize() {
    // 0番：デフォルト「いいえ」
    if (over5YNo && over5YYes) {
        over5YNo.checked = true;
        over5YYes.checked = false;
    }
    if (over5YWarning) {
        over5YWarning.classList.add('hidden');
    }

    // 再現有無：デフォルト「いいえ」
    checkN.checked = true;
    checkY.checked = false;
    toggleSections();

    copyButton.addEventListener('click', copyReportToClipboard);
    clearButtonTop.addEventListener('click', clearAllInputs);
}

// ページ読み込み時に初期化
initialize();
