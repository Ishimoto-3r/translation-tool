// pdftranslate.js - PDF→画像変換＆Vision API翻訳

let pdfFile = null;
const $ = (id) => document.getElementById(id);

function setBusy(on) {
    const ov = $("overlay");
    if (ov) ov.classList.toggle("show", !!on);

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
    if (urlInput) urlInput.disabled = !!on;

    const directionSelect = $("directionSelect");
    if (directionSelect) directionSelect.disabled = !!on;
}

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

// PDF→画像変換関数
async function convertPDFToImages(pdfData) {
    const images = [];

    try {
        const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
        const numPages = pdf.numPages;

        console.log(`PDF has ${numPages} pages. Processing first page only (MVP).`);

        // MVP: 最初の1ページのみ処理
        const maxPages = Math.min(numPages, 1);

        for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.5 }); // 適度な解像度

            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({
                canvasContext: context,
                viewport: viewport
            }).promise;

            // Canvas→JPEG Base64（サイズ抑制）
            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            images.push(dataUrl);

            console.log(`Page ${pageNum} converted to image (${Math.round(dataUrl.length / 1024)} KB)`);
        }

        return images;
    } catch (err) {
        console.error("PDF to image conversion error:", err);
        throw new Error(`PDF変換エラー: ${err.message}`);
    }
}

// 翻訳実行処理
async function handleExecute() {
    clearError();

    if (!pdfFile) {
        showError("PDFファイルを選択してください（ドラッグ&ドロップまたはクリック）");
        return;
    }

    setBusy(true);
    const resultArea = $("resultArea");

    try {
        if (resultArea) {
            resultArea.textContent = "PDFを画像に変換中...";
        }

        // 1. PDFを読み込み
        const arrayBuffer = await pdfFile.arrayBuffer();

        // 2. PDF→画像配列に変換
        const images = await convertPDFToImages(arrayBuffer);

        if (resultArea) {
            resultArea.textContent = `${images.length}ページを変換完了。翻訳中...`;
        }

        // 3. APIに送信
        const direction = $("directionSelect").value;

        const response = await fetch("/api/pdftranslate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                images: images,
                direction: direction
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            let errDetail = response.statusText;
            try {
                const errJson = JSON.parse(errText);
                if (errJson && errJson.error) errDetail = errJson.error;
            } catch (e) {
                if (errText) errDetail = errText.slice(0, 300);
            }
            throw new Error(`APIエラー: ${response.status} ${errDetail}`);
        }

        // 4. 翻訳済みPDFをダウンロード
        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = `translated_${pdfFile.name}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);

        if (resultArea) {
            resultArea.textContent = "✅ 翻訳が完了しました。ダウンロードを開始します。";
            resultArea.classList.remove("text-blue-600");
            resultArea.classList.add("text-green-600");
        }

    } catch (error) {
        console.error("Execution error:", error);
        showError("処理中にエラーが発生しました: " + error.message);

        if (resultArea) {
            resultArea.textContent = "エラーが発生しました";
            resultArea.classList.remove("text-blue-600", "text-green-600");
            resultArea.classList.add("text-red-600");
        }
    } finally {
        setBusy(false);
    }
}

// ドラッグ&ドロップの初期化
function initDragAndDrop() {
    const dz = $("dropzone");
    const input = $("pdfInput");

    if (!dz || !input) {
        console.error("dropzone or pdfInput not found!");
        return;
    }

    console.log("Drag and drop initialized");

    dz.addEventListener("click", () => {
        console.log("Dropzone clicked");
        input.click();
    });

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
            updateStatus();
            console.log("PDF file selected via drop:", file.name);
        } else {
            showError("PDFファイルのみ受け付けています。");
        }
    });

    input.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file && file.type === "application/pdf") {
            pdfFile = file;
            updateStatus();
            console.log("PDF file selected via click:", file.name);
        }
    });
}

// 初期化
document.addEventListener("DOMContentLoaded", () => {
    console.log("DOMContentLoaded - Initializing...");

    initDragAndDrop();

    const btnExecute = $("btnExecute");
    if (btnExecute) {
        btnExecute.addEventListener("click", handleExecute);
        console.log("Execute button listener attached");
    } else {
        console.error("btnExecute not found!");
    }
});
