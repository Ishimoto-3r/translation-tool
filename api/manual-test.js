// api/manual-test.js
import * as XLSX from "xlsx";

export default async function handler(req, res) {
  try {
    // STEP1: アクセストークン取得 ---------------------------------
    const tenantId = process.env.MANUAL_TENANT_ID;
    const clientId = process.env.MANUAL_CLIENT_ID;
    const clientSecret = process.env.MANUAL_CLIENT_SECRET;

    if (!tenantId || !clientId || !clientSecret) {
      return res.status(500).json({
        error: "EnvError",
        detail: "MANUAL_TENANT_ID / MANUAL_CLIENT_ID / MANUAL_CLIENT_SECRET が設定されていません。",
      });
    }

    const tokenResponse = await fetch(
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

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      return res.status(500).json({
        error: "TokenError",
        detail: tokenData,
      });
    }

    const accessToken = tokenData.access_token;

    // STEP2: SharePoint からファイル本体を取得 ------------------------
    const fileUrl = process.env.MANUAL_SHAREPOINT_FILE_URL;
    if (!fileUrl) {
      return res.status(500).json({
        error: "EnvError",
        detail: "MANUAL_SHAREPOINT_FILE_URL が設定されていません。",
      });
    }

    // Graph の "shares/u!<base64url>" 形式に変換
    const base64 = Buffer.from(fileUrl).toString("base64").replace(/=+$/, "");
    const graphUrl = `https://graph.microsoft.com/v1.0/shares/u!${base64}/driveItem/content`;

    const graphResponse = await fetch(graphUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!graphResponse.ok) {
      const errorDetail = await graphResponse.text();
      return res.status(graphResponse.status).json({
        error: "GraphError",
        status: graphResponse.status,
        detail: errorDetail,
      });
    }

    const arrayBuffer = await graphResponse.arrayBuffer();
    const excelBuffer = Buffer.from(arrayBuffer);
    const contentType =
      graphResponse.headers.get("content-type") ||
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    // STEP3: xlsx で Excel を読み込む -------------------------------
    const workbook = XLSX.read(excelBuffer, { type: "buffer" });
    const sheets = workbook.SheetNames;

    if (sheets.length === 0) {
      return res.status(400).json({
        error: "NoSheets",
        detail: "ブック内にシートがありません。",
      });
    }

    const firstSheetName = sheets[0]; // とりあえず先頭シートを採用（例：「原本」）
    const firstSheet = workbook.Sheets[firstSheetName];

    // ★ここが「プレビュー10行」-------------------------------
    const previewFirst10Rows = XLSX.utils
      .sheet_to_json(firstSheet, { defval: "" })
      .slice(0, 10);

    // ★ここが今回追加した「全行」-------------------------------
    const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
    const rowCount = rows.length;

    // STEP4: レスポンス ------------------------------------------
    return res.status(200).json({
      message: "Excel parsed successfully",
      byteLength: excelBuffer.byteLength,
      contentType,
      sheets,              // 全シート名一覧
      firstSheetName,      // 実際に使ったシート名（例：「原本」）
      previewFirst10Rows,  // デバッグ用プレビュー
      rowCount,            // 行数
      rows,                // ★マニュアル生成で本当に使う全行データ
    });
  } catch (err) {
    return res.status(500).json({
      error: "UnexpectedError",
      detail: err.toString(),
    });
  }
}
