// kensho.js（全文置き換え）
// 目的：
// - /api/kensho-db の labelMaster を画面表示
// - 画像：D&D/選択で読み込み → 小プレビュー表示 → ×で削除（複数）
// - 「Body has already been consumed」対策（レスポンス本文の二重読み取りを禁止）
// - 量産前テンプレDLのURLを /api/kensho-template?type=mass に統一

const $ = (id) => document.getElementById(id);

const state = {
  dbLoaded: false,
  images: [], // { id, dataUrl }
  labelMaster: [],
  itemList: [],
};

function showOverlay(title, msg) {
  const overlay = $("overlay");
  const t = $("overlay-title");
  const m = $("overlay-msg");
  if (t) t.textContent = title || "処理中…";
  if (m) m.textContent = msg || "しばらくお待ちください";
  if (overlay) {
    overlay.classList.remove("hidden");
    overlay.classList.add("flex");
  }
}

function hideOverlay() {
  const overlay = $("overlay");
  if (overlay) {
    overlay.classList.add("hidden");
    overlay.classList.remove("flex");
  }
}

function setStatus(text) {
  const el = $("status-text");
  if (el) el.textContent = text || "";
}

function disableButtons(disabled) {
  const g = $("btn-generate");
  const m = $("btn-mass");
  if (g) g.disabled = !!disabled;
  if (m) m.disabled = !!disabled;
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
  const text = await res.text(); // ここで確定的に1回読む
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

/** labelMaster を manual風に {genre, items[]} へ整形 */
function buildGenreGroups(labelMaster) {
  const visible = (labelMaster || []).filter((x) => !x.uiHidden);

  // 並び順：ジャンル表示順 → ジャンル名 → ジャンル内表示順 → ラベル名
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

    const head = document.createElement("div");
    head.className = "flex items-center justify-between mb-2";
    head.innerHTML = `<div class="font-semibold text-sm">${escapeHtml(g.genre || "")}</div>`;

    const list = document.createElement("div");
    // 各項目：1行（折り返し前提）＋ 行間を詰める
    list.className = "grid grid-cols-1 gap-1";

    for (const it of (g.items || [])) {
      const label = (it.label || "").toString();
      const id = `lbl_${g.genre}_${label}`.replace(/\s+/g, "_");

      const row = document.createElement("label");
      row.className =
        "flex items-center gap-2 border rounded-lg px-2 py-1 text-sm hover:bg-slate-50 cursor-pointer";

      row.innerHTML = `
        <input type="checkbox" class="h-4 w-4" data-label="1" value="${escapeAttr(label)}" id="${escapeAttr(id)}">
        <span class="leading-5">${escapeHtml(label)}</span>
      `;
      list.appendChild(row);
    }

    card.appendChild(head);
    card.appendChild(list);
    root.appendChild(card);
  }
}

async function fetchDatabaseAndRender() {
  showOverlay("SharePointを読み込み中…", "databaseの取得中です");
  disableButtons(true);

  const res = await fetch("/api/kensho-db");
  if (!res.ok) {
    const msg = await readErrorMessage(res);
    throw new Error(msg);
  }

  // OK時はJSONを読む（ここは1回だけ）
  const data = await res.json();

  state.labelMaster = Array.isArray(data.labelMaster) ? data.labelMaster : [];
  state.itemList = Array.isArray(data.itemList) ? data.itemList : [];

  renderLabelsFromLabelMaster(state.labelMaster);

  state.dbLoaded = true;
  setStatus("準備完了");
  hideOverlay();
  disableButtons(false);
}

function setupImageUploader() {
  // ✅ HTMLのIDに合わせる（drop/img/thumbs）
  const drop = $("drop");
  const file = $("img");
  const thumbs = $("thumbs");
  if (!drop || !file || !thumbs) return;

  // dropクリックでファイル選択
  drop.addEventListener("click", (e) => {
    // ボタン押下で巻き込まれないように（保険）
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
        renderThumbs();
      };
      reader.readAsDataURL(f);
    }
  }

  function renderThumbs() {
    thumbs.innerHTML = "";
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
        renderThumbs();
      });

      wrap.appendChild(im);
      wrap.appendChild(btn);
      thumbs.appendChild(wrap);
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
  const m2 = cd.match(/filename\=\"?([^\";]+)\"?/i);
  if (m2) return m2[1];
  return "";
}

async function onGenerate() {
  if (!state.dbLoaded) {
    alert("SharePointの読み込みが完了していません。");
    return;
  }

  const generalName = ($("general-name")?.value || "").trim();
  const feature = ($("feature")?.value || "").trim();
  const note = ($("note")?.value || "").trim();
  const selectedLabels = getSelectedLabels();

  showOverlay("生成中…", "初回検証ファイルを作成しています");
  disableButtons(true);

  try {
    const res = await fetch("/api/kensho-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productInfo: { name: generalName, feature, note },
        selectedLabels,
        images: state.images.map((x) => x.dataUrl),
      }),
    });

    if (!res.ok) {
      const msg = await readErrorMessage(res);
      throw new Error(msg);
    }

    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") || "";
    const fallback = generalName ? `検証_${generalName}.xlsx` : "検証_無題.xlsx";
    const fileName = decodeFileNameFromContentDisposition(cd) || fallback;

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);

    setStatus("完了");
  } catch (e) {
    console.error(e);
    setStatus("エラー: " + e.toString());
    alert("生成に失敗しました。\n" + e.toString());
  } finally {
    hideOverlay();
    disableButtons(false);
  }
}

async function onDownloadMassTemplate() {
  showOverlay("取得中…", "量産前フォーマットをダウンロードします");
  disableButtons(true);

  try {
    const res = await fetch("/api/kensho-template?type=mass");
    if (!res.ok) {
      const msg = await readErrorMessage(res);
      throw new Error(msg);
    }

    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "量産前検証フォーマット.xlsx";
    a.click();
    URL.revokeObjectURL(a.href);

    setStatus("完了");
  } catch (e) {
    console.error(e);
    setStatus("エラー: " + e.toString());
    alert("ダウンロードに失敗しました。\n" + e.toString());
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

  try {
    await fetchDatabaseAndRender();
  } catch (e) {
    console.error(e);
    hideOverlay();
    disableButtons(false);
    setStatus("SharePoint読み込みエラー: " + e.toString());
    alert("SharePoint読み込みに失敗しました。\n" + e.toString());
  }
});
