// /api/manual-test.js
import xlsx from "xlsx";

/**
 * SharePoint 上の「マニュアル用DB.xlsx」を読み込み、
 * ・原本シート  … rows[]
 * ・定型文シート… templates[]
 * を JSON で返す API
 *
 * 期待環境変数:
 * - MANUAL_TENANT_ID
 * - MANUAL_CLIENT_ID
 * - MANUAL_CLIENT_SECRET
 * - MANUAL_SHAREPOINT_FILE_URL  (Graph で直接ダウンロードできる URL)
 */

export default async function handler(req, res) {
  try {
    // 1) Azure AD でアクセストークン取得
    const tenantId    = process.env.MANUAL_TENANT_ID;
    const clientId    = process.env.MANUAL_CLIENT_ID;
    const clientSecret= process.env.MANUAL_CLIENT_SECRET;
    const fileUrl     = process.env.MANUAL_SHAREPOINT_FILE_URL;

    if (!tenantId || !clientId || !clientSecret || !fileUrl) {
      return res.status(500).json({
        error: "ConfigError",
        detail: "MANUAL_* 系の環境変数が不足しています。",
      });
    }

    // Microsoft Graph 用スコープ
    const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.append("client_id", clientId);
    params.append("client_secret", clientSecret);
    params.append("grant_type", "client_credentials");
    params.append("scope", "https://graph.microsoft.com/.default");

    const tokenRes = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      return res.status(500).json({
        error: "TokenError",
        detail: `Azure AD トークン取得に失敗しました: ${txt}`,
      });
    }

    const tokenJson = await tokenRes.json();
    const accessToken = tokenJson.access_token;
    if (!accessToken) {
      return res.status(500).json({
        error: "TokenError",
        detail: "access_token がレスポンスに含まれていません。",
      });
    }

    // 2) Graph 経由で Excel ファイルをダウンロード
    const fileRes = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!fileRes.ok) {
      const txt = await fileRes.text();
      return res.status(500).json({
        error: "DownloadError",
        detail: `SharePoint ファイルのダウンロードに失敗しました: ${txt}`,
      });
    }

    const ab = await fileRes.arrayBuffer();
    const buf = Buffer.from(ab);

    // 3) xlsx でブックを読む
    const wb = xlsx.read(buf, { type: "buffer" });

    if (!wb.SheetNames || wb.SheetNames.length === 0) {
      return res.status(500).json({
        error: "XlsxError",
        detail: "Excel ブックにシートがありません。",
      });
    }

    // --------------------------------------------------
    // 3-1) 「原本」シート → rows[]
    // --------------------------------------------------
    const sheetRaw = wb.Sheets["原本"];
    if (!sheetRaw) {
      return res.status(500).json({
        error: "XlsxError",
        detail: "Excel に『原本』シートが見つかりません。",
      });
    }

    const rawData = xlsx.utils.sheet_to_json(sheetRaw, { header: 1 });
    let lastLabel = "";

    const rows = (rawData || [])
      .slice(1) // 1行目はヘッダ
      .map((row, idx) => {
        if (!row || (row[1] == null && row[2] == null)) return null;

        let label = (row[0] || "").toString().trim();
        if (label === "") {
          label = lastLabel;
        } else {
          lastLabel = label;
        }

        const category = (row[1] || "").toString().trim();
        const content  = (row[2] || "").toString().trim();

        return { id: idx, label, category, content };
      })
      .filter(
        (r) =>
          r !== null &&
          r.label &&
          r.content &&
          r.label !== "項目名"
      );

    // --------------------------------------------------
    // 3-2) 「定型文」シート → templates[]
    //   A:Group, B:Key, C:Order, D:Text
    // --------------------------------------------------
    const sheetTpl = wb.Sheets["定型文"];
    let templates = [];

    if (sheetTpl) {
      const tplData = xlsx.utils.sheet_to_json(sheetTpl, { header: 1 }) || [];

      templates = tplData
        .slice(1) // ヘッダ行を除く
        .filter((r) => r && r[0] && r[3]) // Group と Text がある行だけ
        .map((r) => ({
          group: String(r[0]).trim(),
          key:   String(r[1] || "").trim(),
          order: Number(r[2] || 0),
          text:  String(r[3]).trim(),
        }))
        // Group + Order でソートしておくと扱いやすい
        .sort((a, b) => {
          if (a.group === b.group) return a.order - b.order;
          return a.group < b.group ? -1 : 1;
        });
    }

    // 4) レスポンス
    return res.status(200).json({
      ok: true,
      sheetNames: wb.SheetNames,
      rows,
      templates,
    });
  } catch (e) {
    console.error("[manual-test] unexpected error:", e);
    return res.status(500).json({
      error: "UnexpectedError",
      detail: e.message || String(e),
    });
  }
}
