document.getElementById("run").addEventListener("click", async () => {
    const resultBox = document.getElementById("result");
    resultBox.textContent = "読み込み中…";

    try {
        // API 呼び出し（※ YOUR_DOMAIN は後で置換）
        const res = await fetch("/api/manual-test");
        const data = await res.json();

        if (!data.rows) {
            resultBox.textContent = "行データが取得できませんでした。";
            return;
        }

        // rows = [{ ラベル: "...", 項目名: "...", 内容: "...", ... }]
        const rows = data.rows;

        // マニュアル文生成（最低限の処理：必要に応じて改良可能）
        let manualText = "";
        let currentLabel = "";

        rows.forEach((r) => {
            if (r["ラベル"] && r["ラベル"] !== currentLabel) {
                currentLabel = r["ラベル"];
                manualText += `\n\n【${currentLabel}】\n`;
            }

            manualText += `■ ${r["項目名"]}\n${r["内容"]}\n`;
        });

        resultBox.textContent = manualText;
                // === AIチェック（5.2 / medium / low）を実行 ===
        resultBox.textContent = "AIチェック中…";

        const aiRes = await fetch("/api/manual-ai", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                prompt: manualText,
                mode: "check"
            })
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
