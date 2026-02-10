(function () {
  // inspection.js（全文置き換え）
  let pdfFile = null;
  let pdfFileSize = 0;
  const MAX_DD_BYTES = 4 * 1024 * 1024; // 4MB（D&D推奨上限）
  const MAX_SELECTION_ITEMS = 50;
  const MAX_AI_ITEMS = 50;

  let selectionItems = []; // SharePointの「選択リスト」C列（表示用）
  let extracted = {
    model: "",
    productName: "",
    specs: [],     // string[]
    ops: [],       // { title: string, items: string[] }[]
    accs: []       // string[]
  };

  const $ = (id) => document.getElementById(id);

  function showError(msg) {
    if (window.showToast) {
      window.showToast(msg, true);
    } else {
      console.error(msg);
      alert(msg);
    }
  }

  function showDndNotice(msg) {
    const urlInput = $("pdfUrlInput");
    if (!urlInput) return;
    let note = $("dndNotice");
    if (!note) {
      note = document.createElement("div");
      note.id = "dndNotice";
      note.className = "mt-2 text-sm text-red-600";
      urlInput.parentElement?.insertBefore(note, urlInput);
    }
    note.textContent = msg;
  }

  function clearError() {
    // Toast automatically clears, no operation needed for static box
  }

  function setBusy(on, title = "処理中", step = "", msg = "処理しています。画面は操作できません。", hint = "") {
    const ov = $("overlay");
    $("overlayTitle").textContent = title;
    $("overlayStep").textContent = step || "";
    $("overlayMsg").textContent = msg || "";
    $("overlayHint").textContent = hint || "";
    ov.classList.toggle("show", !!on);

    // 入力をまとめて無効化（二重押し防止）
    const disableIds = [
      "pdfInput", "dropzone", "pdfUrlInput", "btnExtract", "btnGenerate",
      "lblLiion", "lblLegal", "modelInput", "productInput"
    ];
    for (const id of disableIds) {
      const el = $(id);
      if (!el) continue;
      if (id === "dropzone") {
        el.style.pointerEvents = on ? "none" : "auto";
        el.style.opacity = on ? "0.7" : "1";
      } else {
        el.disabled = !!on;
      }
    }

    // 選択リストも無効化
    document.querySelectorAll('input[data-select-item="1"]').forEach((cb) => {
      cb.disabled = !!on;
    });
    // 抽出リストも無効化
    document.querySelectorAll('input[data-extract="1"]').forEach((cb) => {
      cb.disabled = !!on;
    });
  }

  function normalizeText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    // [object Object] 対策：絶対にオブジェクトをそのまま表示しない
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  function analyzeTextQuality(text) {
    const raw = text || "";
    const compact = raw.replace(/\s/g, "");
    const total = compact.length || 1;
    const jpMatches = compact.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || [];
    const tofuMatches = compact.match(/[□■]/g) || [];
    const uniqueRatio = new Set(compact).size / total;

    return {
      total,
      jpRatio: jpMatches.length / total,
      tofuRatio: tofuMatches.length / total,
      uniqueRatio
    };
  }

  function capList(list, max = MAX_AI_ITEMS) {
    return Array.isArray(list) ? list.slice(0, max) : [];
  }

  function setPdfStatus() {
    const url = ($("pdfUrlInput") && $("pdfUrlInput").value ? $("pdfUrlInput").value.trim() : "");

    if (pdfFile) {
      $("pdfStatus").textContent = `選択中: ${pdfFile.name} (${Math.round(pdfFile.size / 1024)} KB)`;
      $("pdfNameHint").textContent = pdfFile.name;
      return;
    }

    if (url) {
      $("pdfStatus").textContent = `URL指定: ${url}`;
      $("pdfNameHint").textContent = "※URLのPDFをAI抽出に使用します";
      return;
    }

    $("pdfStatus").textContent = "未選択";
    $("pdfNameHint").textContent = "※PDFをAI抽出に使用します";
  }

  function renderCheckboxList(containerId, items, { defaultChecked = false, dataAttr = {} } = {}) {
    const wrap = $(containerId);
    wrap.innerHTML = "";

    if (!items || items.length === 0) {
      wrap.textContent = "（抽出なし）";
      return;
    }

    const frag = document.createDocumentFragment();

    for (let i = 0; i < items.length; i++) {
      const txt = normalizeText(items[i]).trim();
      if (!txt) continue;

      const label = document.createElement("label");
      label.className = "flex items-start gap-2";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "h-4 w-4 mt-0.5";
      cb.checked = !!defaultChecked;

      // data attributes
      for (const [k, v] of Object.entries(dataAttr)) {
        cb.dataset[k] = v;
      }
      cb.dataset.value = txt;
      cb.dataset.extract = "1";

      const span = document.createElement("span");
      span.textContent = txt;

      label.appendChild(cb);
      label.appendChild(span);
      frag.appendChild(label);
    }

    wrap.appendChild(frag);
  }

  function renderOpGroups(containerId, groups) {
    const wrap = $(containerId);
    wrap.innerHTML = "";

    if (!groups || groups.length === 0) {
      wrap.textContent = "（抽出なし）";
      return;
    }

    const frag = document.createDocumentFragment();

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi] || {};
      const title = normalizeText(g.title).trim();
      const items = Array.isArray(g.items) ? g.items : [];

      // title（チェックあり・太字・下線） ※Excel投入時は太字/下線しない（API側で解除）
      if (title) {
        const titleRow = document.createElement("label");
        titleRow.className = "flex items-start gap-2 mt-2";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "h-4 w-4 mt-0.5";
        cb.checked = false; // 初期は未チェック
        cb.dataset.extract = "1";
        cb.dataset.kind = "opTitle";
        cb.dataset.group = String(gi);
        cb.dataset.value = title;

        const span = document.createElement("span");
        span.innerHTML = `<span style="font-weight:700;text-decoration:underline;">${escapeHtml(title)}</span>`;

        titleRow.appendChild(cb);
        titleRow.appendChild(span);
        frag.appendChild(titleRow);
      }

      // items
      for (let ii = 0; ii < items.length; ii++) {
        const it = normalizeText(items[ii]).trim();
        if (!it) continue;

        const row = document.createElement("label");
        row.className = "flex items-start gap-2 ml-5";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "h-4 w-4 mt-0.5";
        cb.checked = false; // 初期は未チェック
        cb.dataset.extract = "1";
        cb.dataset.kind = "opItem";
        cb.dataset.group = String(gi);
        cb.dataset.value = it;

        const span = document.createElement("span");
        span.textContent = it;

        row.appendChild(cb);
        row.appendChild(span);
        frag.appendChild(row);
      }
    }

    wrap.appendChild(frag);
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function api(op, payload) {
    const res = await fetch(`/api/inspection?op=${encodeURIComponent(op)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${txt}`);
    }
    return res.json();
  }

  function getSelectedLabels() {
    const labels = [];
    if ($("lblLiion").checked) labels.push("リチウムイオン電池");
    if ($("lblLegal").checked) labels.push("法的対象(PSE/無線)");
    return labels;
  }

  function renderSelectionList() {
    const wrap = $("selectList");
    wrap.innerHTML = "";

    if (!selectionItems || selectionItems.length === 0) {
      wrap.textContent = "（選択リストなし）";
      return;
    }

    const frag = document.createDocumentFragment();
    for (const txt0 of selectionItems) {
      const txt = normalizeText(txt0).trim();
      if (!txt) continue;

      const label = document.createElement("label");
      label.className = "flex items-start gap-2";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "h-4 w-4 mt-0.5";
      cb.checked = true; // 選択リストは「不要なものだけ外す」運用
      cb.dataset.selectItem = "1";
      cb.dataset.value = txt;

      const span = document.createElement("span");
      span.textContent = txt;

      label.appendChild(cb);
      label.appendChild(span);
      frag.appendChild(label);
    }
    wrap.appendChild(frag);
  }

  function getSelectedSelectionItems() {
    return Array.from(document.querySelectorAll('input[data-select-item="1"]'))
      .filter(cb => cb.checked)
      .map(cb => cb.dataset.value)
      .filter(Boolean);
  }

  function getCheckedExtracted() {
    const spec = [];
    const acc = [];
    const opTitles = [];
    const opItems = [];

    document.querySelectorAll('input[data-extract="1"]').forEach((cb) => {
      if (!cb.checked) return;
      const kind = cb.dataset.kind || "";
      const v = (cb.dataset.value || "").trim();
      if (!v) return;

      if (kind === "opTitle") opTitles.push(v);
      else if (kind === "opItem") opItems.push(v);
      else {
        // specs/accs は containerごとに区別したいので、親のIDで判定
        const parent = cb.closest("#specList, #accList");
        if (parent && parent.id === "specList") spec.push(v);
        else if (parent && parent.id === "accList") acc.push(v);
        else {
          // 保険：入らないなら spec に寄せる
          spec.push(v);
        }
      }
    });

    return { spec, opTitles, opItems, acc };
  }

  async function loadMeta() {
    clearError();
    try {
      const r = await api("meta", {});
      selectionItems = Array.isArray(r.selectionItems) ? r.selectionItems : [];
      renderSelectionList();
    } catch (e) {
      showError("初期化に失敗しました: " + e.message);
      $("selectList").textContent = "読み込み失敗";
    }
  }


  // ===== Client-Side PDF Extraction =====
  async function extractPdfData(arrayBuffer) {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      disableWorker: false // Worker is loaded in HTML
    });

    const pdf = await loadingTask.promise;
    let fullText = "";

    // 1. Text Extraction
    // Read up to 50 pages to cover most manuals (Specs often at end)
    const maxTextPages = Math.min(pdf.numPages, 50);
    for (let i = 1; i <= maxTextPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const strings = content.items.map(item => item.str);
      fullText += strings.join(" ") + "\\n";
    }

    // 2. Vision Fallback (if text is sparse)
    // Threshold: less than 100 characters of meaningful text or garbage-like text
    const cleanText = fullText.replace(/\s/g, "");
    const quality = analyzeTextQuality(fullText);
    const images = [];

    const isSparse = cleanText.length < 100;
    const isGarbage = quality.jpRatio < 0.05 || quality.tofuRatio > 0.1 || quality.uniqueRatio < 0.15;

    if (isSparse || isGarbage) {
      // Render pages to images for Vision API
      // Intelligent selection:
      // - If <= 20 pages, render all pages.
      // - Otherwise, First 5 pages (Intro/Contents/Accs) + Last 5 pages (Specs/Warranty)
      const totalPages = pdf.numPages;
      const pagesToRender = new Set();

      if (totalPages <= 20) {
        for (let i = 1; i <= totalPages; i++) pagesToRender.add(i);
      } else {
        // First 5 pages
        for (let i = 1; i <= Math.min(totalPages, 5); i++) pagesToRender.add(i);

        // Last 5 pages (if not already added)
        for (let i = Math.max(1, totalPages - 4); i <= totalPages; i++) pagesToRender.add(i);
      }

      // Render selected pages
      for (const pageNum of Array.from(pagesToRender).sort((a, b) => a - b)) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.5 }); // 1.5x scale for better readability

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({
          canvasContext: context,
          viewport: viewport
        }).promise;

        // Convert to JPEG base64 (smaller than PNG)
        const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
        images.push(dataUrl);
      }
    }

    return { text: fullText, images };
  }

  async function runExtract() {
    clearError();

    const url = ($("pdfUrlInput") && $("pdfUrlInput").value ? $("pdfUrlInput").value.trim() : "");

    // 容量が大きいPDFはD&Dでは処理しない（選択していても止めてURL案内）
    if (pdfFile && pdfFile.size > MAX_DD_BYTES) {
      const mb = (pdfFile.size / (1024 * 1024)).toFixed(2);
      pdfFile = null;
      $("pdfInput").value = "";
      setPdfStatus(`容量超過（${mb}MB）`);
      showError("容量が大きいため、ドラッグ＆ドロップでは処理できません。下のURL欄にマニュアルのリンクを貼り付けてください。");
      if ($("pdfUrlInput")) $("pdfUrlInput").focus();
      return;
    }

    if (!pdfFile && !url) {
      showError("PDFが未選択です。（4MB超のPDFはURL欄に貼り付けてください）");
      return;
    }

    try {
      setBusy(true, "PDF解析中", "解析", "PDFからテキストと画像を解析しています...", "解析はブラウザで行っています。");
      $("overlayBar").style.width = "20%";

      const modelHint = $("modelInput").value.trim();
      const productHint = $("productInput").value.trim();

      let pdfBuffer;
      let fileName = "manual.pdf";

      // 1. Get PDF Buffer
      if (pdfFile) {
        fileName = pdfFile.name;
        pdfBuffer = await pdfFile.arrayBuffer();
      } else {
        // Fetch via proxy
        fileName = (url.split("?")[0].split("#")[0].split("/").pop() || "from_url.pdf");
        const res = await fetch(`/api/inspection?op=fetch&url=${encodeURIComponent(url)}`);
        if (!res.ok) {
          throw new Error(`PDFダウンロード失敗: ${res.status} ${res.statusText}`);
        }
        pdfBuffer = await res.arrayBuffer();
      }

      $("overlayBar").style.width = "40%";
      $("overlayStep").textContent = "データ抽出";

      // 2. Client-Side Extraction
      const { text, images } = await extractPdfData(pdfBuffer);

      if (images.length > 0) {
        setBusy(true, "AI抽出中(画像)", "送信", "画像データからAI解析を行っています...", "画像マニュアルのため時間がかかります。");
      } else {
        setBusy(true, "AI抽出中(テキスト)", "送信", "テキストデータからAI解析を行っています...", "サーバーへ送信中。");
      }
      $("overlayBar").style.width = "60%";

      // 3. Send to API
      const payload = {
        text,
        images,
        fileName,
        modelHint,
        productHint
      };

      const r = await api("extract", payload);

      $("overlayBar").style.width = "90%";

      // 4. Handle Response
      if (r && r.ok) {
        extracted = r;
        // 画面反映
        renderOpGroups("specList", [{ title: "", items: r.specs }]);
        renderOpGroups("opList", r.ops);
        renderCheckboxList("accList", r.accs, { defaultChecked: true });

        $("modelInput").value = r.model || "";
        $("productInput").value = r.productName || "";

        setBusy(false);
        if (r.notice) showError(r.notice);
      } else {
        if (r && r.notice) showError(r.notice);
        else throw new Error("API Error or Unknown format");
      }

    } catch (e) {
      console.error(e);
      showError("抽出に失敗しました: " + e.message);
      setBusy(false);
    }
  }

  async function runGenerate() {
    clearError();

    const model = $("modelInput").value.trim();
    const productName = $("productInput").value.trim();

    if (!model || !productName) {
      showError("型番と製品名を入力してください（未入力なら先に「PDFをAIに読み取らせる」を実行してください）。");
      return;
    }

    const selectedLabels = getSelectedLabels();
    const selectedSelectionItems = getSelectedSelectionItems().slice(0, MAX_SELECTION_ITEMS);
    const checked = getCheckedExtracted();

    try {
      setBusy(true, "Excel生成中", "準備", "テンプレートに差し込み、Excelを生成しています。", "SharePointテンプレ取得→差し込み→書式調整→DL");
      $("overlayBar").style.width = "25%";

      const r = await api("generate", {
        model,
        productName,
        selectedLabels,
        selectedSelectionItems,
        specText: capList(checked.spec),
        opTitles: capList(checked.opTitles),
        opItems: capList(checked.opItems),
        accText: capList(checked.acc)
      });

      $("overlayBar").style.width = "90%";

      if (!r || !r.fileBase64) {
        throw new Error("生成結果が不正です。");
      }

      const bin = Uint8Array.from(atob(r.fileBase64), c => c.charCodeAt(0));
      const blob = new Blob([bin], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = r.fileName || `検品リスト_${model}_${productName}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);

      $("overlayBar").style.width = "100%";
    } catch (e) {
      showError("Excel生成に失敗しました: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  function initPdfDrop() {
    const dz = $("dropzone");
    const input = $("pdfInput");
    const urlInput = $("pdfUrlInput");

    const blockOversizeDnd = (file) => {
      if (!file) return false;
      if (file.size <= MAX_DD_BYTES) return false;
      const mb = (file.size / (1024 * 1024)).toFixed(2);
      pdfFile = null;
      pdfFileSize = 0;
      input.value = "";
      setPdfStatus(`容量超過（${mb}MB）`);
      const msg = "このPDFは容量が大きいため、ドラッグ＆ドロップでは処理できません。下のURL欄にPDFのリンクを貼り付けてください。";
      showError(msg);
      showDndNotice(msg);
      console.log("[DND] blocked size=", file.size);
      const u = $("pdfUrlInput");
      if (u) {
        u.focus();
        u.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setBusy(false);
      return true;
    };

    if (urlInput) {
      urlInput.addEventListener("input", () => {
        const v = urlInput.value.trim();
        if (v) {
          // URLが入ったらファイル選択は解除
          pdfFile = null;
          input.value = "";
        }
        setPdfStatus();
      });
      urlInput.addEventListener("click", (e) => e.stopPropagation());
      urlInput.addEventListener("mousedown", (e) => e.stopPropagation());
    }

    dz.addEventListener("click", () => input.click());

    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("border-blue-400");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("border-blue-400"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("border-blue-400");
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && f.type === "application/pdf") {
        if (blockOversizeDnd(f)) return;
        pdfFile = f;
        pdfFileSize = f.size;
        // PDF選択時はURLをクリア（混在防止）
        const u = $("pdfUrlInput");
        if (u) u.value = "";
        setPdfStatus();
      } else {
        showError("ファイルを指定してください。");
      }
    });

    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (f && f.type === "application/pdf") {
        if (blockOversizeDnd(f)) return;
        pdfFile = f;
        pdfFileSize = f.size;
        const u = $("pdfUrlInput");
        if (u) u.value = "";
        setPdfStatus();
      } else if (f) {
        showError("ファイルを指定してください。");
      }
    });

    // ラベルはデフォルトOFF（要件：両方ONになってしまう不具合対策）
    $("lblLiion").checked = false;
    $("lblLegal").checked = false;
  }

  window.addEventListener("DOMContentLoaded", async () => {
    initPdfDrop();
    setPdfStatus();

    $("btnExtract").addEventListener("click", runExtract);
    $("btnGenerate").addEventListener("click", runGenerate);

    await loadMeta();
  });
})();
