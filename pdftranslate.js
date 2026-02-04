// PDF翻訳ツール - フロントエンド
// pdf.js getTextContent()による正確な座標取得 + 画像フォールバック + ページ選択UI

// グローバル変数
let pdfDoc = null;
let pagesData = []; // 全ページデータ
let selectedPages = new Set(); // 選択されたページ番号（1-indexed）

// 範囲選択モード用
let isCropMode = false;
let cropAreas = []; // { pageNum: number, x, y, width, height, uuid }
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

// モード切替
function switchMode(mode) {
    isCropMode = (mode === 'crop');

    const btnModePage = $("modePage");
    const btnModeCrop = $("modeCrop");
    const pageControls = $("pageSelectionControls");
    const cropInstruction = $("cropInstruction");

    if (isCropMode) {
        // スタイル変更
        btnModePage.classList.remove('bg-white', 'shadow-sm', 'text-blue-600');
        btnModePage.classList.add('text-gray-500', 'hover:text-gray-700');

        btnModeCrop.classList.remove('text-gray-500', 'hover:text-gray-700');
        btnModeCrop.classList.add('bg-white', 'shadow-sm', 'text-blue-600');

        if (pageControls) pageControls.classList.add('hidden');
        if (cropInstruction) cropInstruction.classList.remove('hidden');

        // ページ選択を無効化（視覚的）
        document.querySelectorAll('.page-preview-item checkbox').forEach(cb => cb.disabled = true);
        document.querySelectorAll('.page-preview-item').forEach(item => item.classList.remove('cursor-pointer'));
    } else {
        // スタイル戻す
        btnModeCrop.classList.remove('bg-white', 'shadow-sm', 'text-blue-600');
        btnModeCrop.classList.add('text-gray-500', 'hover:text-gray-700');

        btnModePage.classList.remove('text-gray-500', 'hover:text-gray-700');
        btnModePage.classList.add('bg-white', 'shadow-sm', 'text-blue-600');

        if (pageControls) pageControls.classList.remove('hidden');
        if (cropInstruction) cropInstruction.classList.add('hidden');

        document.querySelectorAll('.page-preview-item checkbox').forEach(cb => cb.disabled = false);
        document.querySelectorAll('.page-preview-item').forEach(item => item.classList.add('cursor-pointer'));
    }

    // 全Canvasを再描画（枠の表示/非表示）
    document.querySelectorAll('canvas.page-preview-canvas').forEach(canvas => {
        const pageNum = parseInt(canvas.dataset.pageNum);
        redrawCanvas(canvas, pageNum);
    });
}

// Canvas再描画（PDF画像 + 選択枠）
function redrawCanvas(canvas, pageNum) {
    const ctx = canvas.getContext('2d');
    const pageData = pagesData[pageNum - 1];

    if (!pageData || !pageData.image) return;

    const img = new Image();
    img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // 元画像を描画（スケーリング考慮）
        // プレビューは viewport scale 0.5 で生成されていると仮定
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        // 範囲選択モードなら枠を描画
        if (isCropMode) {
            const areas = cropAreas.filter(a => a.pageNum === pageNum);
            areas.forEach(area => {
                ctx.strokeStyle = 'red';
                ctx.lineWidth = 2;
                ctx.strokeRect(area.x, area.y, area.width, area.height);

                // 半透明の背景
                ctx.fillStyle = 'rgba(255, 0, 0, 0.2)';
                ctx.fillRect(area.x, area.y, area.width, area.height);

                // 削除ボタン的なもの(簡易的に右下に×)
                ctx.fillStyle = 'red';
                ctx.fillRect(area.x + area.width - 15, area.y + area.height - 15, 15, 15);
                ctx.fillStyle = 'white';
                ctx.font = '12px Arial';
                ctx.fillText('×', area.x + area.width - 12, area.y + area.height - 3);
            });
        }
    };
    img.src = pageData.image; // pageData.image は DataURL
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

            // 範囲選択イベントの設定
            setupCropEvents(canvas, pageNum);

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
    const btnSelectAll = $("btnSelectAll");
    const btnDeselectAll = $("btnDeselectAll");

    if (btnSelectAll) {
        btnSelectAll.addEventListener("click", () => {
            document.querySelectorAll('.page-preview-item').forEach(item => {
                const pageNum = parseInt(item.dataset.pageNum);
                const checkbox = item.querySelector('input[type="checkbox"]');
                if (checkbox) checkbox.checked = true;
                selectedPages.add(pageNum);
                item.classList.add('selected');
            });
            updateSelectionCount();
        });
    }

    if (btnDeselectAll) {
        btnDeselectAll.addEventListener("click", () => {
            document.querySelectorAll('.page-preview-item').forEach(item => {
                const pageNum = parseInt(item.dataset.pageNum);
                const checkbox = item.querySelector('input[type="checkbox"]');
                if (checkbox) checkbox.checked = false;
                selectedPages.delete(pageNum);
                item.classList.remove('selected');
            });
            updateSelectionCount();
        });
    }
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

// 範囲選択イベント設定
function setupCropEvents(canvas, pageNum) {
    let isDragging = false;

    canvas.addEventListener('mousedown', (e) => {
        if (!isCropMode) return;
        const rect = canvas.getBoundingClientRect();
        startX = e.clientX - rect.left;
        startY = e.clientY - rect.top;
        isDragging = true;
        currentCropPage = pageNum;
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!isCropMode || !isDragging) return;
        const rect = canvas.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;

        // ラバーバンド描画（再描画してから描く）
        redrawCanvas(canvas, pageNum);

        const ctx = canvas.getContext('2d');
        ctx.strokeStyle = 'blue';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(startX, startY, currentX - startX, currentY - startY);
        ctx.setLineDash([]);
    });

    canvas.addEventListener('mouseup', (e) => {
        if (!isCropMode || !isDragging) return;
        isDragging = false;

        const rect = canvas.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;

        let width = endX - startX;
        let height = endY - startY;
        let x = startX;
        let y = startY;

        // 負のサイズ対応
        if (width < 0) { x = endX; width = Math.abs(width); }
        if (height < 0) { y = endY; height = Math.abs(height); }

        // 極小サイズは無視（誤クリック防止）
        if (width > 10 && height > 10) {
            // 新しいエリアを追加
            cropAreas.push({
                pageNum: pageNum,
                x: x,
                y: y,
                width: width,
                height: height,
                uuid: crypto.randomUUID()
            });
            console.log("Added crop area:", cropAreas[cropAreas.length - 1]);
        } else {
            // クリックとみなして削除判定
            const clickX = x;
            const clickY = y;
            // 逆順（手前のものから）判定
            for (let i = cropAreas.length - 1; i >= 0; i--) {
                const area = cropAreas[i];
                if (area.pageNum === pageNum &&
                    clickX >= area.x && clickX <= area.x + area.width &&
                    clickY >= area.y && clickY <= area.y + area.height) {

                    cropAreas.splice(i, 1); // 削除
                    console.log("Removed crop area");
                    break;
                }
            }
        }

        redrawCanvas(canvas, pageNum);
        updateSelectionCount(); // 選択数を更新（エリア数などを表示してもよい）
    });

    // マウスが外れた場合も終了
    canvas.addEventListener('mouseleave', () => {
        if (isDragging) {
            isDragging = false;
            redrawCanvas(canvas, pageNum);
        }
    });
}

// 翻訳実行処理
async function handleExecute() {
    try {
        clearError();

        // モードによる分岐
        let pagesToSend = [];

        if (isCropMode) {
            if (cropAreas.length === 0) {
                showError("翻訳する範囲を選択してください。プレビュー画像をドラッグして範囲を指定できます。");
                return;
            }

            setBusy(true);
            updateStatus("画像切り出し中", "処理開始", "選択範囲を切り出しています...");

            // 切り出し処理
            for (let i = 0; i < cropAreas.length; i++) {
                const area = cropAreas[i];
                const pageData = pagesData[area.pageNum - 1];

                // 元画像を読み込み
                const img = new Image();
                img.src = pageData.image;
                await new Promise(resolve => img.onload = resolve);

                // 切り出し用Canvas
                const cropCanvas = document.createElement('canvas');
                cropCanvas.width = area.width;
                cropCanvas.height = area.height;
                const ctx = cropCanvas.getContext('2d');

                // 描画（スケーリングに注意：プレビューは0.5倍、canvasサイズも0.5倍されている状態）
                // pagesData.imageは元画像（プレビュー描画用）だが、これはconvertPDFToTextItemsで作ったもので、viewport scale依存。
                // convertPDFToTextItemsでは scale: 2.0 で作成されていたが、
                // generatePreviewsでは viewprot scale: 0.5 で作成したcanvasに描画している。
                // pagesData.imageは？ -> convertPDFToTextItemsで作られた(scale 2.0)ものが入っているか、
                // いや、pdftranslate.jsでは initDragAndDropで convertPDFToTextItems が呼ばれ pagesData が更新される。
                // convertPDFToTextItems内では scale:2.0 で作った画像を toDataURL している。

                // しかし、generatePreviewsで作られた canvas.width/height は scale:0.5。
                // つまりプレビュー上の 1px は、pagesData.image (scale 2.0) 上では 4px に相当する。
                // 比率計算が必要。

                // area.x, area.width は「プレビューCanvas(scale 0.5)」上の座標。
                // image は scale 2.0 の画像。
                // 比率は 2.0 / 0.5 = 4倍。

                const scaleRatio = 4.0;
                // ただし、もしgeneratePreviewsだけ呼んで textItems生成がまだの場合、pagesDataが無い可能性があるが、
                // initDragAndDropで両方呼んでいるので大丈夫。

                //念のため比率を計算
                const previewWidth = pagesData[area.pageNum - 1].width; // これは scale 2.0 の幅？
                // pagesData[].width は convertPDFToTextItems で viewport.width (scale 2.0) が入っている。

                // プレビューのCanvasサイズ（DOMから取得したほうが確実かも）
                const previewCanvas = document.querySelector(`canvas[data-page-num="${area.pageNum}"]`) ||
                    document.querySelectorAll('canvas.page-preview-canvas')[area.pageNum - 1];

                let actualRatio = 1;
                if (previewCanvas) {
                    actualRatio = img.width / previewCanvas.width;
                }

                ctx.drawImage(img,
                    area.x * actualRatio, area.y * actualRatio, area.width * actualRatio, area.height * actualRatio,
                    0, 0, area.width, area.height); // 出力サイズはプレビュー見た目サイズのままか、高解像度にするか？
                // プレビュー見た目サイズ(area.width)だと小さいので、高解像度で切り出すべき。
                // 出力canvasサイズを大きくする。

                cropCanvas.width = area.width * actualRatio;
                cropCanvas.height = area.height * actualRatio;
                // コンテキスト再取得が必要（サイズ変更したためリセットされる）
                const ctx2 = cropCanvas.getContext('2d');
                ctx2.drawImage(img,
                    area.x * actualRatio, area.y * actualRatio, area.width * actualRatio, area.height * actualRatio,
                    0, 0, cropCanvas.width, cropCanvas.height);

                const croppedDataUrl = cropCanvas.toDataURL('image/jpeg', 0.95);

                pagesToSend.push({
                    page: i + 1, // 連番
                    width: cropCanvas.width,
                    height: cropCanvas.height,
                    textItems: [], // テキストなし（Vision API強制）
                    image: croppedDataUrl
                });
            }

        } else {
            // ページ選択モード（既存ロジック）
            if (pagesData.length > 0 && selectedPages.size === 0) {
                showError("翻訳するページを少なくとも1つ選択してください。");
                return;
            }
            const selectedPagesArray = Array.from(selectedPages).sort((a, b) => a - b);
            pagesToSend = selectedPagesArray.map(pageNum => pagesData[pageNum - 1]);
        }

        // ここから共通処理
        if (pagesToSend.length > 0) {
            setBusy(true); // 念のため

            updateStatus("翻訳中", `0/${pagesToSend.length}`,
                isCropMode ? "選択された範囲を翻訳しています..." : "選択されたページを翻訳しています...");


            const direction = $("directionSelect").value;

            // API呼び出し
            const response = await fetch("/api/pdftranslate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    pages: pagesToSend,
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
