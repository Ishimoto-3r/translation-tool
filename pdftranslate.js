// pdftranslate.js

let pdfFile = null;
const $ = (id) => document.getElementById(id);

/**
 * UIの無効化・有効化とオーバーレイ制御
 */
function setBusy(on) {
    const ov = $("overlay");
    if (ov) {
        ov.classList.toggle("show", !!on);
    }

    const btnExecute = $("btnExecute");
    if (btnExecute) {
        btnExecute.disabled = !!on;
        btnExecute.style.opacity = on ? "0.7" : "1";
    }

    const dropzone = $("dropzone");
    if (dropzone) {
        dropzone.style.pointerEvents = on ? "none" : "auto";
        dropzone.style.opacity = on ? "0.7" : "1";
    }

    const urlInput = $("pdfUrlInput");
    if (urlInput) {
        urlInput.disabled = !!on;
    }

    const directionSelect = $("directionSelect");
    if (directionSelect) {
        directionSelect.disabled = !!on;
    }
}

/**
 * ファイル選択ステータスの更新
 */
function updateStatus() {
    const resultArea = $("resultArea");
    if (!resultArea) return;

    if (pdfFile) {
        resultArea.textContent = `選択完了: ${pdfFile.name} (${Math.round(pdfFile.size / 1024)} KB)`;
        resultArea.classList.remove("text-gray-500", "border-dashed");
        resultArea.classList.add("text-blue-600", "font-bold", "border-solid");
    } else {
        resultArea.textContent = "ここに翻訳後のファイルが表示されます";
        resultArea.classList.add("text-gray-500", "border-dashed");
        resultArea.classList.remove("text-blue-600", "font-bold", "border-solid");
    }
}

/**
 * エラー表示
 */
function showError(msg) {
    const errorBox = $("errorBox");
    if (errorBox) {
        errorBox.textContent = msg;
        errorBox.classList.remove("hidden");
    } else {
        alert(msg);
    }
}

function clearError() {
    const errorBox = $("errorBox");
    if (errorBox) {
        errorBox.textContent = "";
        errorBox.classList.add("hidden");
    }
}

/**
 * 翻訳実行処理
 */
async function handleExecute() {
    clearError();
    const urlInput = $("pdfUrlInput");
    const pdfUrl = urlInput ? urlInput.value.trim() : "";

    if (!pdfFile && !pdfUrl) {
        showError("PDFファイルを選択するか、URLを入力してください。");
        return;
    }

    setBusy(true);

    try {
        const formData = new FormData();
        if (pdfFile) {
            formData.append("file", pdfFile);
        }
        if (pdfUrl) {
            formData.append("pdfUrl", pdfUrl);
        }

        const direction = $("directionSelect").value;
        formData.append("direction", direction);

        // Step 2時点ではAPI未実装のため404等が返ることを想定
        const response = await fetch("/api/pdftranslate", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            throw new Error(`APIエラー: ${response.status} ${response.statusText}`);
        }

        // 成功時はBlob（PDF）として受け取りダウンロード
        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = pdfFile ? `translated_${pdfFile.name}` : "translated_manual.pdf";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);

        const resultArea = $("resultArea");
        if (resultArea) {
            resultArea.textContent = "翻訳が完了しました。ダウンロードを開始します。";
        }

    } catch (error) {
        console.error("Execution error:", error);
        showError("処理中にエラーが発生しました: " + error.message);
    } finally {
        setBusy(false);
    }
}

/**
 * ドラッグ&ドロップの初期化
 */
function initDragAndDrop() {
    const dz = $("dropzone");
    const input = $("pdfInput");

    if (!dz || !input) return;

    dz.addEventListener("click", () => input.click());

    dz.addEventListener("dragover", (e) => {
        e.preventDefault();
        dz.classList.add("border-blue-500", "bg-blue-50");
    });

    dz.addEventListener("dragleave", () => {
        dz.classList.remove("border-blue-500", "bg-blue-50");
    });

    dz.addEventListener("drop", (e) => {
        e.preventDefault();
        dz.classList.remove("border-blue-500", "bg-blue-50");

        const file = e.dataTransfer.files[0];
        if (file && file.type === "application/pdf") {
            pdfFile = file;
            if ($("pdfUrlInput")) $("pdfUrlInput").value = ""; // URLをクリア
            updateStatus();
        } else {
            showError("PDFファイルのみ受け付けています。");
        }
    });

    input.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file && file.type === "application/pdf") {
            pdfFile = file;
            if ($("pdfUrlInput")) $("pdfUrlInput").value = ""; // URLをクリア
            updateStatus();
        }
    });
}

// 初期化
document.addEventListener("DOMContentLoaded", () => {
    initDragAndDrop();

    const btnExecute = $("btnExecute");
    if (btnExecute) {
        btnExecute.addEventListener("click", handleExecute);
    }

    const urlInput = $("pdfUrlInput");
    if (urlInput) {
        urlInput.addEventListener("input", () => {
            if (urlInput.value.trim()) {
                pdfFile = null;
                const input = $("pdfInput");
                if (input) input.value = "";
                updateStatus();
            }
        });
    }
});
