// api/manual-test.js
import xlsx from "xlsx";

export default async function handler(req, res) {
  try {
    // 1) Azure AD でアクセストークン取得
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

    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      }
    );

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(500).json({
        error: "TokenError",
        detail: tokenData,
      });
    }

    const accessToken = tokenData.access_token;

    // 2) SharePoint の Excel を取得
    const shareId = Buffer.from(fileUrl).toString("base64").replace(/=+$/, "");
    const graphRes = await fetch(
      `https://graph.microsoft.com/v1.0/shares/u!${shareId}/driveItem/content`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!graphRes.ok) {
      const txt = await graphRes.text();
      return res.status(graphRes.status).json({
        error: "GraphError",
        status: graphRes.status,
        detail: txt,
      });
    }

    const arrayBuffer = await graphRes.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    // 3) xlsx でパース
    const wb = xlsx.read(buf, { type: "buffer" });

    // --- メインシート（安全・注意など） ---
    const firstSheetName = wb.SheetNames[0];
    const mainSheet = wb.Sheets["原本"] || wb.Sheets[firstSheetName];
    if (!mainSheet) {
      return res.status(500).json({
        error: "SheetError",
        detail: "原本シート（または先頭シート）が見つかりません。",
      });
    }

    const mainJson = xlsx.utils.sheet_to_json(mainSheet); // 見出し行をヘッダに

    // 期待する列名: 「ラベル」「項目名」「内容」
    // 追加列: 「ジャンル名」「ジャンル表示順」「ジャンル内表示順」「ジャンル表示対象外」
    const rows = mainJson
      .map((row, idx) => {
        const label    = row["ラベル"] ?? "";
        const category = row["項目名"] ?? "";
        const content  = row["内容"] ?? "";

        // ★ UI 用のジャンル情報
        const uiGenre = row["ジャンル名"] ?? "";

        let uiGenreOrder = Number(row["ジャンル表示順"]);
        if (Number.isNaN(uiGenreOrder)) uiGenreOrder = null;

        let uiItemOrder = Number(row["ジャンル内表示順"]);
        if (Number.isNaN(uiItemOrder)) uiItemOrder = null;

        const hiddenRaw = (row["ジャンル表示対象外"] ?? "").toString().trim();
        const uiHidden = hiddenRaw !== "" && hiddenRaw !== "0";

        return {
          id: idx,
          label,
          category,
          content,
          uiGenre,
          uiGenreOrder,
          uiItemOrder,
          uiHidden,
        };
      })
      .filter((r) => r.label || r.category || r.content);

    // --- 定型文シートの読み込み ---
    const tmplSheet = wb.Sheets["定型文"];
    let templates = [];

    if (tmplSheet) {
      const tmplRaw = xlsx.utils.sheet_to_json(tmplSheet, {
        header: 1,
        defval: "",
      });
      // 1行目: Group / Key / Order / Text を想定
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
      sheetNames: wb.SheetNames,
      firstSheetName,
      rows,
      templates, // ★ 追加
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "UnexpectedError",
      detail: err.toString(),
    });
  }
}
