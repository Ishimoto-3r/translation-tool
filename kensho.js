// kensho.js（全文置き換え）
// 追加対応：
// - 検証ラベル：検索ボックス / 選択数表示 / 全解除
// - 生成中：工程ログ + 経過秒
// - 生成完了：完了メッセージのみ表示

const $ = (id) => document.getElementById(id);

const state = {
  dbLoaded: false,
  images: [], // { id, dataUrl }
  labelMaster: [],
  itemList: [],
};

// ===== Overlay（工程ログ + 経過秒） =====
let overlayTick = null;
let overlayStartedAt = null;
let overlayLog = [];
let overlayBaseMsg = "";

function renderOverlayMsg() {
  const m = $("overlay-msg");
  if (!m) return;

  const sec = overlayStartedAt ? Math.floor((Date.now() - overlayStartedAt) / 1000) : 0;

  const lines = [];
  if (overlayBaseMsg) lines.push(escapeHtml(overlayBaseMsg));

  if (overlayLog.length) {
    // 直近が分かるように最後だけ強調
    const lastIndex = overlayLog.length - 1;
    for (let i = 0; i < overlayLog.length; i++) {
      const prefix = i === lastIndex ? "▶" : "・";
      lines.push(`${prefix} ${escapeHtml(overlayLog[i])}`);
    }
  }

  lines.push(`<span class="text-slate-500">（${sec}s）</span>`);
  m.innerHTML = lines.join("<br>");
}

function showOverlay(title, msg) {
  const overlay = $("overlay");
  const t = $("overlay-title");
  if (t) t.textContent = title || "処理中…";

  overlayStartedAt = Date.now();
  overlayLog = [];
  overlayBaseMsg = msg || "しばらくお待ちください";
  renderOverlayMsg();

  if (overlayTick) clearInterval(overlayTick);
  overlayTick = setInterval(renderOverlayMsg, 500);

  if (overlay) {
    overlay.classList.remove("hidden");
    overlay.classList.add("flex");
  }
}

function logStep(step) {
  overlayLog.push(step);
  renderOverlayMsg();
}

function hideOverlay() {
  const overlay = $("overlay");
  if (overlay) {
    overlay.classList.add("hidden");
    overlay.classList.remove("flex");
  }
  if (overlayTick) {
    clearInterval(overlayTick);
    overlayTick = null;
  }
  overlayStartedAt = null;
  overlayLog = [];
  overlayBaseMsg = "";
}

// ===== UI =====
function setStatus(text) {
  const el = $("status-text");
  if (el) el.textContent = text || "";
}

function disableButtons(disabled) {
  const g = $("btn-generate");
  const m = $("btn-mass");
  const c = $("btn-clear-labels");
  const s = $("label-search");
  if (g) g.disabled = !!disabled;
  if (m) m.disabled = !!disabled;
  if (c) c.disabled = !!disabled;
  if (s) s.disabled = !!disabled;

  // ラベルチェックも操作不可にする（生成中の事故防止）
  document
    .querySelectorAll('input[type="checkbox"][data-label="1"]')
    .forEach((x) => (x.disabled = !!disabled));
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("\n", " ");
}

// レスポンス本文は「1回だけ」読む（body consumed 対策）
async function readBodyOnce(res) {
  const text = await res.text();
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return { text, ct };
}

async function readErrorMessage(res) {
  const { text, ct } = await readBodyOnce(res);
  if (ct.includes("application/json")) {
    try {
      const obj = JSON.parse(text);
      return obj?.detail
        ? `${obj.error || "Error"}: ${obj.detail}`
        : JSON.stringify(obj);
    } catch {
      return text;
    }
  }
  return text || `HTTP ${res.status}`;
}

/** labelMaster を {genre, items[]} へ整形 */
function buildGenreGroups(labelMaster) {
  const visible = (labelMaster || []).filter((x) => !x.uiHidden);

  visible.sort((a, b) => {
    const ag = a.uiGenreOrder ?? 999999;
    const bg = b.uiGenreOrder ?? 999999;
    if (ag !== bg) return ag - bg;

    const g1 = (a.uiGenre || "").localeCompare(b.uiGenre || "", "ja");
    if (g1 !== 0) return g1;

    const ai = a.uiItemOrder ?? 999999;
    const bi = b.uiItemOrder ?? 999999;
    if (ai !== bi) return ai - bi;

    return (a.label || "").localeCompare(b.label || "", "ja");
  });

  const map = new Map();
  for (const row of visible) {
    const genre = row.uiGenre || "その他";
    if (!map.has(genre)) map.set(genre, []);
    map.get(genre).push({ label: row.label });
  }

  return Array.from(map.entries()).map(([genre, items]) => ({ genre, items }));
}

function renderLabelsFromLabelMaster(labelMaster) {
  const root = $("labels");
  if (!root) return;

  const groups = buildGenreGroups(labelMaster);
  root.innerHTML = "";

  for (const g of groups) {
    const card = document.createElement("div");
    card.className = "border rounded-xl p-3 bg-white";
    card.dataset.genreCard = "1";
    card.dataset.genre = (g.genre || "").toString();

    const head = document.createElement("div");
    head.className = "flex items-center justify-between mb-2";
    head.innerHTML = `<div class="font-semibold text-sm">${escapeHtml(g.genre || "")}</div>`;

    const list = document.createElement("div");
    list.className = "grid grid-cols-1 gap-1";

    for (const it of (g.items || [])) {
      const label = (it.label || "").toString();
      const id = `lbl_${g.genre}_${label}`.replace(/\s+/g, "_");

      const row = document.createElement("label");
      row.className =
        "flex items-center gap-2 border rounded-lg px-2 py-1 text-sm hover:bg-slate-50 cursor-pointer";
      row.dataset.labelRow = "1";
      row.dataset.search = `${(g.genre || "").toString()} ${label}`.toLowerCase();

      row.innerHTML = `
        <input type="checkbox" class="h-4 w-4" data-label="1" value="${escapeAttr(label)}" id="${escapeAttr(id)}">
        <span class="leading-5" data-label-text="1" data-text="${escapeAttr(label)}">${escapeHtml(label)}</span>
      `;
      list.appendChild(row);
    }

    card.appendChild(head);
    card.appendChild(list);
    root.appendChild(card);
  }

  // 描画後のUI初期化（検索/選択数）
  initLabelUX();
  updateSelectedCount();
}

// ===== ラベルUX（検索 / 選択数 / 全解除） =====
function updateSelectedCount() {
  const n = document.querySelectorAll('input[type="checkbox"][data-label="1"]:checked').length;
  const el = $("label-count");
  if (el) el.textContent = `選択：${n}`;

  renderSelectedChips();
}

function renderSelectedChips() {
  const box = $("selected-chips");
  if (!box) return;

  const selected = Array.from(
    document.querySelectorAll('input[type="checkbox"][data-label="1"]:checked')
  )
    .map((c) => (c.value || "").toString())
    .filter(Boolean);

  if (!selected.length) {
    box.innerHTML = "";
    return;
  }

  box.innerHTML = selected
    .slice(0, 200)
    .map(
      (label) => `
      <button type="button" class="text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 rounded-full px-3 py-1 hover:bg-slate-200" data-chip="1" data-label="${escapeAttr(
        label
      )}">
        ${escapeHtml(label)} <span class="ml-1 text-slate-500">×</span>
      </button>`
    )
    .join(" ");
}

function clearAllLabels() {
  document
    .querySelectorAll('input[type="checkbox"][data-label="1"]:checked')
    .forEach((c) => (c.checked = false));
  updateSelectedCount();
}

function applyLabelFilter(q) {
  const query = (q || "").toString().trim().toLowerCase();
  const rows = Array.from(document.querySelectorAll('[data-label-row="1"]'));
  const cards = Array.from(document.querySelectorAll('[data-genre-card="1"]'));
  const no = $("label-no-results");
  const listRoot = $("labels");

  if (!query) {
    rows.forEach((r) => (r.style.display = ""));
    cards.forEach((c) => (c.style.display = ""));

    // ハイライト解除
    document.querySelectorAll('[data-label-text="1"]').forEach((sp) => {
      const raw = sp.dataset.text || "";
      sp.innerHTML = escapeHtml(raw);
    });

    if (no) no.classList.add("hidden");
    if (listRoot) listRoot.style.display = "";
    return;
  }

  // 行の表示/非表示
  rows.forEach((r) => {
    const hay = (r.dataset.search || "");
    r.style.display = hay.includes(query) ? "" : "none";
  });

  // カード単位：表示行が1つもなければ非表示
  cards.forEach((c) => {
    const visibleRow = c.querySelector('[data-label-row="1"][style=""]');
    // ↑ style="" 判定は環境差があるので、実判定はgetComputedStyleでやる
    const anyVisible = Array.from(c.querySelectorAll('[data-label-row="1"]')).some(
      (r) => window.getComputedStyle(r).display !== "none"
    );
    c.style.display = anyVisible ? "" : "none";
  });

  // 一致文字ハイライト（ラベル名のみ）
  document.querySelectorAll('[data-label-text="1"]').forEach((sp) => {
    const raw = (sp.dataset.text || "").toString();
    if (!raw) return;

    const lower = raw.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx < 0) {
      sp.innerHTML = escapeHtml(raw);
      return;
    }

    const before = raw.slice(0, idx);
    const hit = raw.slice(idx, idx + query.length);
    const after = raw.slice(idx + query.length);
    sp.innerHTML = `${escapeHtml(before)}<mark class="bg-yellow-200/70 rounded px-0.5">${escapeHtml(
      hit
    )}</mark>${escapeHtml(after)}`;
  });

  // 該当なし表示
  const anyRowVisible = rows.some((r) => window.getComputedStyle(r).display !== "none");
  if (no) {
    if (anyRowVisible) no.classList.add("hidden");
    else no.classList.remove("hidden");
  }
  if (listRoot) listRoot.style.display = anyRowVisible ? "" : "none";
}

function initLabelUX() {
  const root = $("labels");
  if (!root) return;

  // チェック変更は委譲で拾う
  if (!root.dataset.bound) {
    root.addEventListener("change", (e) => {
      if (e.target && e.target.matches('input[type="checkbox"][data-label="1"]')) {
        updateSelectedCount();
      }
    });
    root.dataset.bound = "1";
  }

  // 検索
  const search = $("label-search");
  if (search && !search.dataset.bound) {
    search.addEventListener("input", () => applyLabelFilter(search.value));
    search.dataset.bound = "1";
  }

  // 全解除
  const btn = $("btn-clear-labels");
  if (btn && !btn.dataset.bound) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      clearAllLabels();
    });
    btn.dataset.bound = "1";
  }

  // チップ解除
  const chips = $("selected-chips");
  if (chips && !chips.dataset.bound) {
    chips.addEventListener("click", (e) => {
      // 生成中は操作させない（事故防止）
      if ($("btn-generate")?.disabled) return;
      const t = e.target?.closest?.('[data-chip="1"]');
      if (!t) return;
      e.preventDefault();
      const label = (t.dataset.label || "").toString();
      if (!label) return;

      const cb = Array.from(
        document.querySelectorAll('input[type="checkbox"][data-label="1"]')
      ).find((x) => (x.value || "").toString() === label);

      if (cb) cb.checked = false;
      updateSelectedCount();
    });
    chips.dataset.bound = "1";
  }
}

function toUserErrorMessage(err) {
  const msg = (err?.message || err?.toString?.() || "").toString();
  const lower = msg.toLowerCase();

  // 代表的なエラーを人間向けに
  if (lower.includes("selectedlabelsrequired")) return "検証ラベルが未選択です。";
  if (lower.includes("methodnotallowed")) return "不正な呼び出しです（MethodNotAllowed）。";
  if (lower.includes("unauthorized") || lower.includes("forbidden")) return "権限エラーです。";
  if (lower.includes("timeout")) return "処理がタイムアウトしました。";

  // JSON文字列がそのまま来るケース
  if (msg.startsWith("{") && msg.includes("error")) return "エラーが発生しました。";

  return "エラーが発生しました。";
}

// ===== DB fetch =====
async function fetchDatabaseAndRender() {
  showOverlay("SharePointを読み込み中…", "databaseの取得中です");
  logStep("DB取得");
  disableButtons(true);

  const res = await fetch("/api/kensho?op=db");

  if (!res.ok) {
    const msg = await readErrorMessage(res);
    throw new Error(msg);
  }

  // OK時はJSONを読む（ここは1回だけ）
  const data = await res.json();

  logStep("ラベル展開");
  state.labelMaster = Array.isArray(data.labelMaster) ? data.labelMaster : [];
  state.itemList = Array.isArray(data.itemList) ? data.itemList : [];

  renderLabelsFromLabelMaster(state.labelMaster);

  state.dbLoaded = true;
  setStatus("準備完了");
  hideOverlay();
  disableButtons(false);
}

// ===== Image uploader =====
function setupImageUploader() {
  const drop = $("image-drop");
  const file = $("image-file");
  const preview = $("image-preview");
  if (!drop || !file || !preview) return;

  drop.addEventListener("click", (e) => {
    if (e.target?.closest("#btn-generate") || e.target?.closest("#btn-mass")) return;
    file.click();
  });

  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("ring-2", "ring-slate-500");
  });

  drop.addEventListener("dragleave", () => {
    drop.classList.remove("ring-2", "ring-slate-500");
  });

  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("ring-2", "ring-slate-500");
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
    addFiles(files);
  });

  file.addEventListener("change", (e) => {
    const files = Array.from(e.target?.files || []).filter((f) => f.type.startsWith("image/"));
    addFiles(files);
    file.value = "";
  });

  function addFiles(files) {
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const id = (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
        state.images.push({ id, dataUrl: reader.result });
        renderPreviews();
      };
      reader.readAsDataURL(f);
    }
  }

  function renderPreviews() {
    preview.innerHTML = "";
    for (const img of state.images) {
      const wrap = document.createElement("div");
      wrap.className = "relative w-16 h-16";

      const im = document.createElement("img");
      im.src = img.dataUrl;
      im.className = "w-16 h-16 object-cover rounded border bg-white";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "×";
      btn.className =
        "absolute -top-2 -right-2 w-6 h-6 rounded-full bg-slate-800 text-white text-sm flex items-center justify-center";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.images = state.images.filter((x) => x.id !== img.id);
        renderPreviews();
      });

      wrap.appendChild(im);
      wrap.appendChild(btn);
      preview.appendChild(wrap);
    }
  }
}

function getSelectedLabels() {
  return Array.from(document.querySelectorAll('input[type="checkbox"][data-label="1"]:checked'))
    .map((c) => c.value)
    .filter(Boolean);
}

function decodeFileNameFromContentDisposition(cd) {
  const m1 = cd.match(/filename\*\=UTF-8''([^;]+)/i);
  if (m1) return decodeURIComponent(m1[1]);
  const m2 = cd.match(/filename\="?([^\";]+)\"?/i);
  if (m2) return m2[1];
  return "";
}

async function onGenerate() {
  if (!state.dbLoaded) {
    alert("SharePointの読み込みが完了していません。");
    return;
  }

  const generalName = ($("general-name")?.value || "").trim();
  const note = ($("note")?.value || "").trim();
  const feature = ($("feature")?.value || "").trim(); // 画面に残っていても壊れないよう保険
  const selectedLabels = getSelectedLabels();

  // featureが残っている場合だけnoteに吸収（非表示化済みなら無視）
  const mergedNote = [note, feature ? `特筆：${feature}` : ""].filter(Boolean).join("\n");

  showOverlay("生成中…", "初回検証ファイルを作成しています");
  logStep("入力整理");
  disableButtons(true);

  try {
    logStep("生成リクエスト送信");
    const res = await fetch("/api/kensho?op=generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productInfo: { name: generalName, note: mergedNote },
        selectedLabels, // 未選択でもOK（バックエンド側で許可済み）
        images: state.images.map((x) => x.dataUrl),
      }),
    });

    if (!res.ok) {
      const msg = await readErrorMessage(res);
      throw new Error(msg);
    }

    logStep("ファイル受信");
    const blob = await res.blob();

    logStep("ダウンロード準備");
    const cd = res.headers.get("content-disposition") || "";
    const fallback = generalName ? `検証_${generalName}.xlsx` : "検証_無題.xlsx";
    const fileName = decodeFileNameFromContentDisposition(cd) || fallback;

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);

    // 要望：完了した旨のみ
    setStatus("完了しました");
  } catch (e) {
    console.error(e);
    const msg = toUserErrorMessage(e);
    setStatus("エラーが発生しました");
    alert("生成に失敗しました。\n" + msg);
  } finally {
    hideOverlay();
    disableButtons(false);
  }
}

async function onDownloadMassTemplate() {
  showOverlay("取得中…", "量産前フォーマットをダウンロードします");
  logStep("テンプレ取得");
  disableButtons(true);

  try {
    const res = await fetch("/api/kensho?op=template&type=mass");

    if (!res.ok) {
      const msg = await readErrorMessage(res);
      throw new Error(msg);
    }

    logStep("ファイル受信");
    const blob = await res.blob();

    logStep("ダウンロード準備");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "量産前検証フォーマット.xlsx";
    a.click();
    URL.revokeObjectURL(a.href);

    setStatus("完了しました");
  } catch (e) {
    console.error(e);
    const msg = toUserErrorMessage(e);
    setStatus("エラーが発生しました");
    alert("ダウンロードに失敗しました。\n" + msg);
  } finally {
    hideOverlay();
    disableButtons(false);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  setupImageUploader();

  $("btn-generate")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onGenerate();
  });

  $("btn-mass")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onDownloadMassTemplate();
  });

  // ラベルUX（DB読み込み前でもイベントだけ貼る）
  initLabelUX();

  try {
    await fetchDatabaseAndRender();
  } catch (e) {
    console.error(e);
    hideOverlay();
    disableButtons(false);
    const msg = toUserErrorMessage(e);
    setStatus("SharePoint読み込みに失敗しました");
    alert("SharePoint読み込みに失敗しました。\n" + msg);
  }
});
