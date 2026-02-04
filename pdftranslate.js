// PDF翻訳ツール - フロントエンド
// pdf.js getTextContent()による正確な座標取得 + 画像フォールバック + ページ選択UI

// グローバル変数
let pdfDoc = null;
let pagesData = []; // 全ページデータ
let selectedPages = new Set(); // 選択されたページ番号（1-indexed）

// 範囲選択モード用
let isCropMode = false;
let cropAreas = []; // { pageIndex: number, x, y, width, height, id }
let isDrawing = false;
let startX = 0;
let startY = 0;
let currentCropPage = null; // 現在ドラッグ中のページインデックス

// PDF.js設定
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ユーティリティ関数
function $(id) {
    return document.getElementById(id);
}

function setBusy(busy) {
    const overlay = $("overlay");
    if (busy) {
        overlay.classList.add("show");
        overlay.setAttribute("aria-hidden", "false");
    } else {
        overlay.classList.remove("show");
        overlay.setAttribute("aria-hidden", "true");
    }
}

function updateStatus(title = "処理中", step = "...", msg = "処理しています。画面は操作できません。", hint = "") {
    const overlayTitle = $("overlayTitle");
    const overlayStep = $("overlayStep");
    const overlayMsg = $("overlayMsg");
    const overlayHint = $("overlayHint");
    if (overlayTitle) overlayTitle.textContent = title;
    if (overlayStep) overlayStep.textContent = step;
    if (overlayMsg) overlayMsg.textContent = msg;
    if (overlayHint) overlayHint.textContent = hint;
}

function showError(msg) {
    const errorBox = $("errorBox");
    if (errorBox) {
        errorBox.textContent = msg;
        errorBox.classList.remove("hidden");
    }
    console.error(msg);
}

function clearError() {
    const errorBox = $("errorBox");
    if (errorBox) {
        errorBox.classList.add("hidden");
        errorBox.textContent = "";
    }
}

// プレビュー生成関数
async function generatePreviews(pdfData) {
    const pdf = await pdfjsLib.getDocument({
        data: pdfData,
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
        cMapPacked: true
    }).promise;
    const numPages = pdf.numPages;

    pagesData = [];
    selectedPages.clear();

    const previewContainer = $("previewContainer");
    previewContainer.innerHTML = "";

    updateStatus("プレビュー生成中", `0/${numPages}`, "PDFのプレビューを作成しています...");

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        try {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 0.5 }); // プレビュー用サムネイル（軽量化）

            // Canvas作成
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            // ページをCanvasに描画
            await page.render({
                canvasContext: context,
                viewport: viewport
            }).promise;

            // プレビューアイテム作成
            const itemDiv = document.createElement('div');
            itemDiv.className = 'page-preview-item cursor-pointer'; // デフォルト: 未選択
            itemDiv.dataset.pageNum = pageNum;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = false; // デフォルト: チェックなし
            checkbox.id = `page-check-${pageNum}`;
            checkbox.className = 'mr-2';

            const toggleSelection = () => {
                checkbox.checked = !checkbox.checked;
                if (checkbox.checked) {
                    selectedPages.add(pageNum);
                    itemDiv.classList.add('selected');
                } else {
                    selectedPages.delete(pageNum);
                    itemDiv.classList.remove('selected');
                }
                updateSelectionCount();
            };

            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                if (e.target.checked) {
                    selectedPages.add(pageNum);
                    itemDiv.classList.add('selected');
                } else {
                    selectedPages.delete(pageNum);
                    itemDiv.classList.remove('selected');
                }
                updateSelectionCount();
            });

            // アイテム全体をクリック可能に
            itemDiv.addEventListener('click', (e) => {
                if (e.target !== checkbox) {
                    toggleSelection();
                }
            });

            const label = document.createElement('label');
            label.htmlFor = `page-check-${pageNum}`;
            label.className = 'flex items-center gap-2 mb-2 cursor-pointer select-none';
            label.innerHTML = `<span class="text-sm font-bold">ページ ${pageNum}</span>`;

            const labelContainer = document.createElement('div');
            labelContainer.className = 'flex items-center gap-2 mb-2';
            labelContainer.appendChild(checkbox);
            labelContainer.appendChild(label);

            canvas.className = 'page-preview-canvas';

            itemDiv.appendChild(labelContainer);
            itemDiv.appendChild(canvas);

            previewContainer.appendChild(itemDiv);

            updateStatus("プレビュー生成中", `${pageNum}/${numPages}`, "PDFのプレビューを作成しています...");
        } catch (error) {
            console.error(`ページ${pageNum}のプレビュー生成失敗:`, error);
            // エラーページを表示
            const itemDiv = document.createElement('div');
            itemDiv.className = 'page-preview-item bg-gray-100 opacity-50';
            itemDiv.innerHTML = `
                <div class="text-sm font-bold mb-2 text-gray-600">ページ ${pageNum}</div>
                <div class="w-full h-32 border rounded flex items-center justify-center text-xs text-red-600">
                    エラー
                </div>
            `;
            previewContainer.appendChild(itemDiv);
        }
    }

    // プレビューセクションを表示
    $("previewSection").classList.remove("hidden");
    updateSelectionCount();
}

// 選択数表示更新
function updateSelectionCount() {
    const count = selectedPages.size;
    const total = pagesData.length || document.querySelectorAll('.page-preview-item').length;
    $("selectionCount").textContent = `${count}/${total} ページ選択中`;
}

// すべて選択/解除
function setupSelectionButtons() {
    $("btnSelectAll").addEventListener("click", () => {
        document.querySelectorAll('.page-preview-item').forEach(item => {
            const pageNum = parseInt(item.dataset.pageNum);
            const checkbox = item.querySelector('input[type="checkbox"]');
            checkbox.checked = true;
            selectedPages.add(pageNum);
            item.classList.add('selected');
        });
        updateSelectionCount();
    });

    $("btnDeselectAll").addEventListener("click", () => {
        document.querySelectorAll('.page-preview-item').forEach(item => {
            const pageNum = parseInt(item.dataset.pageNum);
            const checkbox = item.querySelector('input[type="checkbox"]');
            checkbox.checked = false;
            selectedPages.delete(pageNum);
            item.classList.remove('selected');
        });
        updateSelectionCount();
    });
}

// PDF→テキスト+座標抽出関数（画像フォールバック付き）
async function convertPDFToTextItems(pdfData) {
    const pdf = await pdfjsLib.getDocument({
        data: pdfData,
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
        cMapPacked: true
    }).promise;

    const numPages = pdf.numPages;
    const pages = [];

    updateStatus("PDF読み込み中", `0/${numPages}`, "PDFからテキストと座標を抽出しています...");

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        try {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 2.0 }); // スケール〉2.0に上げる（高品質）

            const textContent = await page.getTextContent();

            const textItems = textContent.items
                .filter(item => item.str && item.str.trim() !== "")
                .map(item => ({
                    text: item.str,
                    x: item.transform[4],
                    y: viewport.height - item.transform[5] - item.height,
                    width: item.width,
                    height: item.height
                }));

            // 常に画像として処理（元のページを表示するため）
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;

            await page.render({
                canvasContext: context,
                viewport: viewport
            }).promise;

            const imageDataUrl = canvas.toDataURL('image/jpeg', 0.95); // 圧縮率を0.95に（高品質）

            pages.push({
                page: pageNum,
                width: viewport.width,
                height: viewport.height,
                textItems: textItems, // テキストがあれば翻訳に使用
                image: imageDataUrl   // 常に画像を含める
            });

            updateStatus("PDF読み込み中", `${pageNum}/${numPages}`, "PDFからテキストと座標を抽出しています...");
        } catch (error) {
            console.error(`ページ${pageNum}のテキスト抽出失敗:`, error);
            // エラーページを空白として追加
            pages.push({
                page: pageNum,
                width: 595,
                height: 842,
                textItems: [],
                error: error.message
            });
        }
    }

    pagesData = pages;
    return pages;
}

// 翻訳実行処理
async function handleExecute() {
    try {
        clearError();

        // ページ選択確認（プレビューが表示されている場合）
        if (pagesData.length > 0 && selectedPages.size === 0) {
            showError("翻訳するページを少なくとも1つ選択してください。");
            return;
        }

        // プレビューが表示されている場合、すぐに翻訳処理へ
        if (pagesData.length > 0 && selectedPages.size > 0) {
            setBusy(true);

            // 選択されたページのみフィルタリング
            const selectedPagesArray = Array.from(selectedPages).sort((a, b) => a - b);
            const selectedPagesData = selectedPagesArray.map(pageNum => pagesData[pageNum - 1]);

            updateStatus("翻訳中", `0/${selectedPagesData.length}`, "選択されたページを翻訳しています...");

            const direction = $("directionSelect").value;

            // API呼び出し
            const response = await fetch("/api/pdftranslate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    pages: selectedPagesData,
                    direction: direction
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || "翻訳に失敗しました");
            }

            updateStatus("完了", "Done", "翻訳が完了しました。PDFをダウンロードしています...");

            const blob = await response.blob();
            const url = URL.createObjectURL(blob);

            // 新しいタブでPDFを開く
            window.open(url, '_blank');

            // 結果表示
            const resultArea = $("resultArea");
            resultArea.innerHTML = `
                <div class="text-center">
                    <div class="text-lg font-bold text-green-600 mb-4">✓ 翻訳完了</div>
                    <div class="mb-4 text-sm text-gray-600">
                        新しいタブでPDFを開きました。開かない場合は下のボタンをクリックしてください。
                    </div>
                    <a href="${url}" download="translated.pdf" 
                       class="inline-block px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition">
                        翻訳済みPDFをダウンロード
                    </a>
                    <div class="mt-3 text-sm text-gray-600">
                        ${selectedPages.size}ページを翻訳しました（元のページ + 翻訳ページ = ${selectedPages.size * 2}ページ）
                    </div>
                </div>
            `;

            setBusy(false);
            return;
        }

        // プレビュー未生成の場合、PDFを読み込んでプレビュー生成
        const urlInput = $("pdfUrlInput").value;

        if (!pdfFile && !urlInput) {
            showError("PDFファイルを選択するか、URLを入力してください。");
            return;
        }

        setBusy(true);
        updateStatus("PDF読み込み中", "0/0", "PDFを読み込んでいます...");

        let pdfData;

        // URLから読み込み（API経由でCORS回避）
        if (urlInput) {
            try {
                const response = await fetch("/api/pdftranslate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ url: urlInput })
                });

                if (!response.ok) {
                    throw new Error("ファイルのダウンロードに失敗しました");
                }

                const data = await response.json();
                const base64 = data.pdfBase64;

                // Base64をArrayBufferに変換
                const binaryString = atob(base64);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                pdfData = bytes.buffer;
            } catch (error) {
                setBusy(false);
                showError(`URLからの読み込みエラー: ${error.message}`);
                return;
            }
        }
        // ファイルから読み込み
        else {
            pdfData = await pdfFile.arrayBuffer();
        }

        // プレビュー生成
        await generatePreviews(pdfData);

        // 再度新しいArrayBufferを取得（URL/ファイルから）
        let pdfData2;
        if (urlInput) {
            const response = await fetch("/api/pdftranslate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: urlInput })
            });
            const data = await response.json();
            const base64 = data.pdfBase64;

            const binaryString = atob(base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            pdfData2 = bytes.buffer;
        } else {
            pdfData2 = await pdfFile.arrayBuffer();
        }

        await convertPDFToTextItems(pdfData2);

        setBusy(false);

        // プレビュー生成後、ユーザーに選択を促す
        showError("ページを選択して、もう一度「翻訳を実行する」ボタンを押してください。");

    } catch (error) {
        console.error("Error:", error);
        showError(`エラー: ${error.message}`);
        setBusy(false);
    }
}

// ドラッグ&ドロップの初期化
function initDragAndDrop() {
    const dropzone = $("dropzone");
    const pdfInput = $("pdfInput");

    if (!dropzone || !pdfInput) {
        console.error("dropzone or pdfInput not found");
        return;
    }

    dropzone.addEventListener("click", () => pdfInput.click());

    pdfInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (file && file.type === "application/pdf") {
            pdfFile = file;
            dropzone.innerHTML = `
                <div class="text-center">
                    <div class="font-semibold text-lg text-green-600">✓ ${file.name}</div>
                    <div class="mt-2 text-sm text-gray-500">プレビューを生成しています...</div>
                </div>
            `;

            // プレビュー生成
            try {
                setBusy(true);
                // 毎回新しいArrayBufferを取得
                const pdfData1 = await file.arrayBuffer();
                await generatePreviews(pdfData1);

                // 再度新しいArrayBufferを取得
                const pdfData2 = await file.arrayBuffer();
                await convertPDFToTextItems(pdfData2);

                dropzone.innerHTML = `
                    <div class="text-center">
                        <div class="font-semibold text-lg text-green-600">✓ ${file.name}</div>
                        <div class="mt-2 text-sm text-gray-500">プレビュー生成完了（下にスクロール）</div>
                    </div>
                `;
                setBusy(false);
            } catch (error) {
                showError(`プレビュー生成エラー: ${error.message}`);
                setBusy(false);
            }
        }
    });

    dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("border-blue-500", "bg-blue-50");
    });

    dropzone.addEventListener("dragleave", () => {
        dropzone.classList.remove("border-blue-500", "bg-blue-50");
    });

    dropzone.addEventListener("drop", async (e) => {
        e.preventDefault();
        dropzone.classList.remove("border-blue-500", "bg-blue-50");

        const file = e.dataTransfer.files[0];
        if (file && file.type === "application/pdf") {
            pdfFile = file;
            dropzone.innerHTML = `
                <div class="text-center">
                    <div class="font-semibold text-lg text-green-600">✓ ${file.name}</div>
                    <div class="mt-2 text-sm text-gray-500">プレビューを生成しています...</div>
                </div>
            `;

            // プレビュー生成
            try {
                setBusy(true);
                // 毎回新しいArrayBufferを取得
                const pdfData1 = await file.arrayBuffer();
                await generatePreviews(pdfData1);

                // 再度新しいArrayBufferを取得
                const pdfData2 = await file.arrayBuffer();
                await convertPDFToTextItems(pdfData2);

                dropzone.innerHTML = `
                    <div class="text-center">
                        <div class="font-semibold text-lg text-green-600">✓ ${file.name}</div>
                        <div class="mt-2 text-sm text-gray-500">プレビュー生成完了（下にスクロール）</div>
                    </div>
                `;
                setBusy(false);
            } catch (error) {
                showError(`プレビュー生成エラー: ${error.message}`);
                setBusy(false);
            }
        }
    });
}

// 初期化
document.addEventListener("DOMContentLoaded", () => {
    console.log("DOMContentLoaded - Initializing...");

    initDragAndDrop();
    setupSelectionButtons();

    const btnExecute = $("btnExecute");
    if (btnExecute) {
        btnExecute.addEventListener("click", handleExecute);
        console.log("Execute button listener attached");
    } else {
        console.error("btnExecute not found!");
    }
});
