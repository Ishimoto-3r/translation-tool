// ====== 追加：貼り付け画像を保持する変数（各部名称 / 参考資料） ======
let pastedPartsImage = null; // dataURL
let pastedRefImage = null;   // dataURL

// ====== 追加：共通：貼り付け枠を初期化する関数 ======
function setupPasteBox({ boxId, imgId, noteId, onSet }) {
  const box = document.getElementById(boxId);
  const img = document.getElementById(imgId);
  const note = document.getElementById(noteId);
  if (!box) return;

  box.addEventListener("focus", () => box.classList.add("is-focused"));
  box.addEventListener("blur", () => box.classList.remove("is-focused"));

  box.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          onSet(dataUrl);

          if (img) {
            img.src = dataUrl;
            img.style.display = "block";
          }
          if (note) note.textContent = "貼り付け済み（枠内にCtrl＋Vでも貼り付け可能）";
        };
        reader.readAsDataURL(file);

        e.preventDefault();
        return;
      }
    }
  });

  if (note && !note.textContent) {
    note.textContent = "枠内にCtrl＋Vでも貼り付け可能";
  }
}

// ====== 追加：ページ読み込み後に貼り付け枠を有効化 ======
window.addEventListener("DOMContentLoaded", () => {
  setupPasteBox({
    boxId: "paste-parts",
    imgId: "paste-parts-preview",
    noteId: "paste-parts-note",
    onSet: (dataUrl) => (pastedPartsImage = dataUrl),
  });

  setupPasteBox({
    boxId: "paste-ref",
    imgId: "paste-ref-preview",
    noteId: "paste-ref-note",
    onSet: (dataUrl) => (pastedRefImage = dataUrl),
  });
});

// ====== ここから「実行ボタン」処理 ======
document.getElementById("run").addEventListener("click", async () => {
  const resultBox = document.getElementById("result");
  resultBox.textContent = "読み込み中…";

  try {
    const res = await fetch("/api/manual-test");
    const data = await res.json();

    if (!data.rows) {
      resultBox.textContent = "行データが取得できませんでした。";
      return;
    }

    const rows = data.rows;

    // ✅ 修正：/api/manual-test の rows は label/category/content を想定
    let manualText = "";
    let currentLabel = "";

    rows.forEach((r) => {
      if (r.label && r.label !== currentLabel) {
        currentLabel = r.label;
        manualText += `\n\n【${currentLabel}】\n`;
      }
      manualText += `■ ${r.category || ""}\n${r.content || ""}\n`;
    });

    resultBox.textContent = "AIチェック中…";

    // ✅ 追加：貼り付けた画像（最大2枚）を送る
    const images = [pastedPartsImage, pastedRefImage].filter(Boolean);

    const aiRes = await fetch("/api/manual-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: manualText,
        mode: "check",
        images,
      }),
    });

    const aiData = await aiRes.json();

    if (!aiRes.ok) {
      resultBox.textContent = "AIチェックでエラー: " + (aiData.error || aiRes.status);
      return;
    }

    resultBox.textContent = aiData.text || "";
  } catch (err) {
    console.error(err);
    resultBox.textContent = "エラー: " + err.toString();
  }
});
