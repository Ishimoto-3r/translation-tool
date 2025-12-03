// api/manual-test.js
import xlsx from "xlsx";

export default async function handler(req, res) {
  try {
    const tenantId = process.env.MANUAL_TENANT_ID;
    const clientId = process.env.MANUAL_CLIENT_ID;
    const clientSecret = process.env.MANUAL_CLIENT_SECRET;
    const fileUrl = process.env.MANUAL_SHAREPOINT_FILE_URL;

    if (!tenantId || !clientId || !clientSecret || !fileUrl) {
      return res.status(500).json({
        error: "ConfigError",
        detail: "MANUAL_* 系の環境変数が不足しています。",
      });
    }

    // =========================
    // 1) AAD トークン取得（SharePoint v1 エンドポイント）
    // =========================
    const spOrigin = new URL(fileUrl).origin; // 例: https://xxxx.sharepoint.com

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
          resource: spOrigin, // ← Graph ではなく SharePoint 用リソース
        }).toString(),
      }
    );

    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => "");
      console.error("[manual-test] token error:", tokenRes.status, text);
      return res.status(500).json({
        error: "TokenError",
        detail: `トークン取得に失敗しました: ${tokenRes.status}`,
      });
    }

    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      console.error("[manual-test] no access_token:", tokenJson);
      return res.status(500).json({
        error: "TokenError",
        detail: "トークンレスポンスに access_token が含まれていません。",
      });
    }

    // =========================
    // 2) SharePoint から Excel ダウンロード
    // =========================
    const fileRes = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!fileRes.ok) {
      const text = await fileRes.text().catch(() => "");
      console.error("[manual-test] download error:", fileRes.status, text);
      return res.status(500).json({
        error: "DownloadError",
        detail: `SharePoint ファイルのダウンロードに失敗しました: ${fileRes.status} ${fileRes.statusText}`,
      });
    }

    const ab = await fileRes.arrayBuffer();

    // =========================
    // 3) Excel パース
    // =========================
    const wb = xlsx.read(ab, { type: "array" });

    // --- メインシート（安全・注意など） ---
    const mainSheet =
      wb.Sheets["原本"] || wb.Sheets[wb.SheetNames[0]]; // 念のためフォールバック
    if (!mainSheet) {
      return res.status(500).json({
        error: "SheetError",
        detail: "原本シート（または先頭シート）が見つかりません。",
      });
    }

    const mainRaw = xlsx.utils.sheet_to_json(mainSheet, {
      header: 1,
      defval: "",
    });

    // 1 行目はヘッダ想定
    let lastLabel = "";
    const rows = mainRaw
      .slice(1)
      .map((row, idx) => {
        if (!row || (row[1] == null && row[2] == null)) return null;

        let label = (row[0] || "").toString().trim();
        if (label === "") label = lastLabel;
        else lastLabel = label;

        const category = (row[1] || "").toString().trim();
        const content = (row[2] || "").toString().trim();

        return {
          id: idx,
          label,
          category,
          content,
        };
      })
      .filter(
        (r) =>
          r !== null &&
          r.label &&
          r.content &&
          r.label !== "項目名" // 念のためヘッダ行を除外
      );

    // --- 定型文シート ---
    const tmplSheet = wb.Sheets["定型文"];
    let templates = [];
    if (tmplSheet) {
      const tmplRaw = xlsx.utils.sheet_to_json(tmplSheet, {
        header: 1,
        defval: "",
      });
      // 1 行目ヘッダ: Group / Key / Order / Text
      templates = tmplRaw
        .slice(1)
        .map((row) => {
          const group = (row[0] || "").toString().trim();
          const key = (row[1] || "").toString().trim();
          const order = Number(row[2]) || 0;
          const text = (row[3] || "").toString();
          if (!group || !key || !text) return null;
          return { group, key, order, text };
        })
        .filter((x) => x);
    }

    console.log(
      "[manual-test] parsed:",
      "rows=",
      rows.length,
      "templates=",
      templates.length
    );

    return res.status(200).json({
      message: "Excel parsed successfully",
      rows,
      templates,
    });
  } catch (err) {
    console.error("[manual-test] Unexpected error:", err);
    return res.status(500).json({
      error: "UnexpectedError",
      detail: err.message || String(err),
    });
  }
}
