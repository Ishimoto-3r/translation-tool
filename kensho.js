// kensho.js（全文置き換え）
// 改善：/api/kensho-test がHTMLを返しても落ちない / 画像アップロード復旧 / プレビュー＆×削除
//      ボタン押下でfile pickerが開く事故を防止

const $ = (id) => document.getElementById(id);

const state = {
  dbLoaded: false,
  images: [], // { id, dataUrl }
};

function showOverlay(title, msg) {
  const overlay = $("overlay");
  const t = $("overlay-title");
  const m = $("overlay-msg");
  if (t) t.textContent = title || "処理中…";
  if (m) m.textContent = msg || "しばらくお待ちください";
  if (overlay) overlay.classList.remove("hidden"), overlay.classList.add("flex");
}

function hideOverlay() {
  const overlay = $("overlay");
  if (overlay) overlay.classList.add("hidden"), overlay.classList.remove("flex");
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

async function safeJson(res) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) return await res.json();
  const txt = await res.text();
  throw new Error(`JSON以外が返りました（${res.status}）:\n${txt.slice(0, 500)}`);
}

async function fetchDatabaseAndRender() {
  showOverlay("SharePointを読み込み中…", "databaseの取得中です");
  disableButtons(true);

  const res = await fetch("/api/kensho-db");
  const data = await safeJson(res);

  if (!res.ok) {
    throw new Error(data?.error ? JSON.stringify(data) : "DB読み込み失敗");
  }

  // ここでは data.labels を想定（後述の api/kensho-test.js を入れると動きます）
  renderLabels(Array.isArray(data.labels) ? data.labels : []);

  state.dbLoaded = true;
  setStatus("準備完了");
  hideOverlay();
  disableButtons(false);
}

function renderLabels(labels) {
  // labels: [{ genre:"重要項目", items:[{label:"PSE対象"} ...] }, ...]
  const root = $("labels");
  if (!root) return;
  root.innerHTML = "";

  for (const g of labels) {
    const card = document.createElement("div");
    card.className = "border rounded-xl p-3";

    const head = document.createElement("div");
    head.className = "flex items-center justify-between mb-2";
    head.innerHTML = `<div class="font-semibold text-sm">${escapeHtml(g.genre || "")}</div>`;

    const list = document.createElement("div");
    // ★ “各項目で1行” ＋ 行間詰め（見やすさ優先）
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

// ===== 画像アップロード（ドラッグ&ドロップ + ファイル選択） =====
function setupImageUploader() {
  const drop = $("image-drop");
  const file = $("image-file");
  const preview = $("image-preview");
  if (!drop || !file || !preview) return;

  // dropクリックでファイル選択
  drop.addEventListener("click", (e) => {
    // ボタンからの伝播はここに来ないようにしているが念のため
    if (e.target && (e.target.closest("#btn-generate") || e.target.closest("#btn-mass"))) return;
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
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith("image/"));
    addFiles(files);
  });

  file.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
    addFiles(files);
    file.value = "";
  });

  function addFiles(files) {
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = () => {
        state.images.push({ id: crypto.randomUUID(), dataUrl: reader.result });
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

// ===== 初回検証ファイル生成（Excelはblobで返す想定） =====
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
      // 失敗時はJSONかテキストを表示
      try {
        const data = await safeJson(res);
        throw new Error(JSON.stringify(data));
      } catch {
        const txt = await res.text();
        throw new Error(txt);
      }
    }

    // 成功：Excelをそのままダウンロード
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

function decodeFileNameFromContentDisposition(cd) {
  // filename*=UTF-8''xxx を優先
  const m1 = cd.match(/filename\*\=UTF-8''([^;]+)/i);
  if (m1) return decodeURIComponent(m1[1]);
  const m2 = cd.match(/filename\=\"?([^\";]+)\"?/i);
  if (m2) return m2[1];
  return "";
}

// ===== 量産前テンプレDL（blob） =====
async function onDownloadMassTemplate() {
  showOverlay("取得中…", "量産前フォーマットをダウンロードします");
  disableButtons(true);
  try {
    const res = await fetch("/api/kensho-mass-template");
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt);
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "量産前フォーマット.xlsx";
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("完了");
  } catch (e) {
    console.error(e);
    setStatus("エラー: " + e.toString());
  } finally {
    hideOverlay();
    disableButtons(false);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  // 画像UI
  setupImageUploader();

  // ボタン：dropクリックに巻き込まれないように stopPropagation
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

  // SharePoint読み込み
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
