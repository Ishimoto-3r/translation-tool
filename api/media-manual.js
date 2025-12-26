<!-- =========================
api/media-manual.js
========================= -->
<script>
// NOTE: この <script> は説明用。実ファイル api/media-manual.js に分離してください。
// Vercel serverless function (Node.js)
import OpenAI from "openai";


const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


export default async function handler(req, res) {
// CORS（必要なら他APIと合わせる）
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type");
if (req.method === "OPTIONS") return res.status(200).end();
if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });


try {
const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
const category = (body.category || "").toString();
const userType = (body.userType || "").toString();
const notes = (body.notes || "").toString();
const images = Array.isArray(body.images) ? body.images : [];


if (!images.length) {
return res.status(400).json({ error: "NoImages" });
}


// 最小構成：モデル固定（後で環境変数へ移行）
const model = "gpt-5.1";


const sys =
"あなたは取扱説明書（家庭用/業務用）の原稿作成のプロです。\n" +
"ユーザーが貼り付けた画像/動画の代表フレームを観察し、取説の原稿案を日本語で作成してください。\n\n" +
"【必須要件】\n" +
"1) 推測で断定しない（見えていない仕様・数値・付属品は『不明』として保留）\n" +
"2) 文章はそのまま貼れる取説調（です・ます）\n" +
"3) まずは『概要→各部名称→基本操作→注意事項→お手入れ/保管→トラブルシュート』の順で出力\n" +
"4) 画像に写るボタン/端子/表示/注意ラベルはできる限り拾う\n" +
"5) 不確かな点は末尾に『要確認リスト』として箇条書きで列挙\n";


const userText =
`カテゴリ: ${category || "(未指定)"}\n` +
`想定ユーザー: ${userType || "(未指定)"}\n` +
(notes ? `補足: ${notes}\n` : "") +
`画像枚数: ${images.length}\n`;


// OpenAI Responses API（マルチモーダル）
const content = [
{ type: "input_text", text: userText }
];


for (const im of images) {
const dataUrl = (im && im.dataUrl) ? String(im.dataUrl) : "";
if (!dataUrl.startsWith("data:image/")) continue;
content.push({
type: "input_image",
image_url: dataUrl
});
}


const resp = await client.responses.create({
model,
// reasoning/verbosity は後で環境変数へ
input: [
{ role: "system", content: sys },
{ role: "user", content }
]
});


const draft = resp.output_text || "";
return res.status(200).json({ draft });
} catch (e) {
console.error(e);
return res.status(500).json({ error: "ServerError", detail: e?.message || String(e) });
}
}
</script>
