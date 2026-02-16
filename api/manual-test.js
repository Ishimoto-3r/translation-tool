// api/manual-test.js
const xlsx = require("xlsx");
const logger = require("../lib/logger");
const { handleCorsPreFlight, setCorsHeaders, getAccessToken } = require("../lib/api-helpers");

async function handler(req, res) {
  // CORS preflight処理（他APIと統一）
  if (handleCorsPreFlight(req, res)) return;
  setCorsHeaders(res);

  try {
    // 1) Azure AD でアクセストークン取得（共通ヘルパー利用）
    const fileUrl = process.env.MANUAL_SHAREPOINT_FILE_URL;
    if (!fileUrl) {
      return res.status(500).json({
        error: "ConfigError",
        detail: "MANUAL_SHAREPOINT_FILE_URL が設定されていません。",
      });
    }

    const accessToken = await getAccessToken();

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
        const label = row["ラベル"] ?? "";
        const category = row["項目名"] ?? "";
        const content = row["内容"] ?? "";

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

    // --- 表記ルールシートの読み込み（新規） ---
    // シート名：「表記ルール」
    // 1列目：元の表記（例：バッテリー）
    // 2列目：統一表記（例：バッテリ）
    const ruleSheet = wb.Sheets["表記ルール"];
    let termRules = [];

    if (ruleSheet) {
      const raw = xlsx.utils.sheet_to_json(ruleSheet, {
        header: 1,
        defval: "",
      });
      termRules = raw
        .slice(1)
        .map((row) => {
          const from = (row[0] || "").toString().trim();
          const to = (row[1] || "").toString().trim();
          if (!from || !to) return null;
          return { from, to };
        })
        .filter((x) => x);
    }

    logger.info("manual-test", `parsed: rows=${rows.length}, templates=${templates.length}, termRules=${termRules.length}`);

    return res.status(200).json({
      message: "Excel parsed successfully",
      sheetNames: wb.SheetNames,
      firstSheetName,
      rows,
      templates,
      termRules,   // ★ 追加
    });

  } catch (err) {
    logger.error("manual-test", "Unexpected error", { error: err.toString() });
    return res.status(500).json({
      error: "UnexpectedError",
      detail: err.toString(),
    });
  }
}

module.exports = handler;
