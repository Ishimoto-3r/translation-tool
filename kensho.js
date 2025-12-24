// kensho.js（全体置き換え版）
// 目的：aiCommentLines 未定義エラーを潰す / 生成フローを堅牢化 / ボタン押下で画像inputが開かないようにする

const $ = (id) => document.getElementById(id);

const state = {
  rows: [],
  templates: [],
  termRules: [],
  selectedLabels: new Set(),
  images: [], // { id, dataUrl, file }
};

function logMsg(msg) {
  const el = $("status-text");
  if (el) el.textContent = msg;
}

function setBusy(isBusy, msg = "") {
  const spinner = $("spinner");
  const status = $("status-text");
  if (spinner) spinner.classList.toggle("hidden", !isBusy);
  if (status && msg) status.textContent = msg;

  const btnGen = $("btn-generate");
  const btnMass = $("btn-mass");
  if (btnGen) btnGen.disabled = isBusy;
  if (btnMass) btnMass.disabled = isBusy;
}

async function fetchDatabase() {
  setBusy(true, "SharePointを読み込み中…");
  const res = await fetch("/api/kensho-test"); // ← あなたのAPI名に合わせて（manual-testではなくkensho用）
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "DB読み込み失敗");

  state.rows = Array.isArray(data.rows) ? data.rows : [];
  state.templates = Array.isArray(data.templates) ? data.templates : [];
  state.termRules = Array.isArray(data.termRules) ? data.termRules : [];

  setBusy(false, "準備完了");
  return data;
}

// ===== 画像アップロード（ドラッグ&ドロップ + ファイル選択） =====
function setupImageUploader() {
  const drop = $("image-drop");
  const file = $("image-file");
  const preview = $("image-preview");

  if (!drop || !file || !preview) return;

  // dropをクリックしたらファイル選択（ただしボタンのクリックは伝播させない）
  drop.addEventListener("click", (e) => {
    // drop自身クリックのみで開く
    if (e.target === drop || drop.contains(e.target)) {
      file.click();
    }
  });

  // ボタンなどがdrop内にある場合の誤爆防止（念のため）
  ["btn-generate", "btn-mass"].forEach((id) => {
    const btn = $(id);
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }
  });

  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("ring-2");
  });

  drop.addEventListener("dragleave", () => {
    drop.classList.remove("ring-2");
  });

  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("ring-2");
    const files = Array.from(e.dataTransfer.files || []).filter((f) =>
      f.type.startsWith("image/")
    );
    addFiles(files);
  });

  file.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []).filter((f) =>
      f.type.startsWith("image/")
    );
    addFiles(files);
    file.value = "";
  });

  function addFiles(files) {
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const id = crypto.randomUUID();
        state.images.push({ id, dataUrl: reader.result, file: f });
        renderPreviews();
      };
      reader.readAsDataURL(f);
    }
  }

  function renderPreviews() {
    preview.innerHTML = "";
    state.images.forEach((img) => {
      const wrap = document.createElement("div");
      wrap.className = "relative inline-block mr-2 mb-2";

      const im = document.createElement("img");
      im.src = img.dataUrl;
      im.className = "w-16 h-16 object-cover rounded border";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "×";
      btn.className =
        "absolute -top-2 -right-2 w-6 h-6 rounded-full bg-gray-800 text-white text-sm flex items-center justify-center";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.images = state.images.filter((x) => x.id !== img.id);
        renderPreviews();
      });

      wrap.appendChild(im);
      wrap.appendChild(btn);
      preview.appendChild(wrap);
    });
  }
}

// ===== ラベル選択の収集（チェックボックス） =====
function getSelectedLabels() {
  const checked = document.querySelectorAll('input[type="checkbox"][data-label="1"]:checked');
  const arr = Array.from(checked).map((c) => c.value).filter(Boolean);
  return arr;
}

// ===== 生成ボタン処理 =====
async function onGenerate() {
  try {
    setBusy(true, "生成準備…");

    // 入力
    const generalName = ($("general-name")?.value || "").trim();
    const feature = ($("feature")?.value || "").trim();
    const note = ($("note")?.value || "").trim();

    const selected = getSelectedLabels();

    // ★ ここで落ちないように、常に配列で持つ
    const images = state.images.map((x) => x.dataUrl).filter(Boolean);

    // 生成API
    setBusy(true, "初回検証ファイルを生成中…");
    const res = await fetch("/api/kensho-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generalName,
        feature,
        note,
        selectedLabels: selected,
        images,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(JSON.stringify(data));
    }

    // ★ここが今回のエラー原因：aiCommentLines未定義を回避する
    // APIが commentLines を返さない場合でも落ちないようにする
    const aiCommentLines = Array.isArray(data.commentLines)
      ? data.commentLines
      : [];

    // ダウンロード（APIがファイルを返す設計ならbase64などに合わせる）
    // ここでは data.fileBase64 / data.fileName を想定（あなたの実装に合わせて要調整）
    if (data.fileBase64) {
      const bin = atob(data.fileBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = data.fileName || "検証_無題.xlsx";
      a.click();
      URL.revokeObjectURL(a.href);
    }

    // ステータス表示（必要なら）
    setBusy(false, "完了");
    const status = $("result");
    if (status) {
      status.textContent =
        "完了\n" +
        (aiCommentLines.length ? `AIコメント行数: ${aiCommentLines.length}` : "");
    }
  } catch (e) {
    console.error(e);
    setBusy(false, "エラー");
    const status = $("result");
    if (status) status.textContent = "エラー: " + e.toString();
  }
}

async function onDownloadMassTemplate() {
  try {
    setBusy(true, "量産前フォーマットを取得中…");
    const res = await fetch("/api/kensho-mass-template");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "量産前フォーマット.xlsx";
    a.click();
    URL.revokeObjectURL(a.href);
    setBusy(false, "完了");
  } catch (e) {
    console.error(e);
    setBusy(false, "エラー");
  }
}

// ===== 初期化 =====
window.addEventListener("DOMContentLoaded", async () => {
  try {
    setupImageUploader();

    // DBロード（必要なら）
    await fetchDatabase();

    const btnGen = $("btn-generate");
    const btnMass = $("btn-mass");

    if (btnGen) {
      btnGen.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation(); // 画像inputが勝手に開くのを防止
        onGenerate();
      });
    }

    if (btnMass) {
      btnMass.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onDownloadMassTemplate();
      });
    }
  } catch (e) {
    console.error(e);
    const status = $("result");
    if (status) status.textContent = "初期化エラー: " + e.toString();
  }
});
