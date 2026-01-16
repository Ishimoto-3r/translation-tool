import OpenAI from "openai";

const MODEL_MANUAL_CHECK =
  process.env.MODEL_MANUAL_CHECK ||
  process.env.MODEL_MANUAL ||
  "gpt-5.2";

const MANUAL_CHECK_REASONING =
  process.env.MANUAL_CHECK_REASONING || "medium";
const MANUAL_CHECK_VERBOSITY =
  process.env.MANUAL_CHECK_VERBOSITY || "low";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const mode = String(body.mode || "");

    if (mode !== "media-manual") {
      return res.status(400).json({ error: "UnsupportedMode" });
    }

    const notes = String(body.notes || "");
    const granularity = String(body.granularity || "standard");

    const sys =
      "あなたは日本語の取扱説明書向け原稿の作成者です。\n" +
      "入力（動画フレームの内容）を観察し、作業手順の原稿を作成してください。\n" +
      "文体は「です・ます」で統一します。\n\n" +
      "【絶対条件】\n" +
      "- 画像から断定できない仕様・数値・機能は推測で書かない（不明は不明として扱う）\n" +
      "- 過剰な注意・禁止・免責は書かない\n" +
      "- 余計な前置きや結論は不要。原稿として使える文章だけを出力する\n\n" +
      "【粒度】\n" +
      "- simple: 手順数を絞り、要点のみ\n" +
      "- standard: 通常の取説レベル\n" +
      "- detailed: 迷いが出やすい箇所は補足して丁寧に（ただし推測は禁止）\n\n" +
      "【出力形式（必須）】\n" +
      "1) 1行目にタイトルを必ず出す：\n" +
      "   例）■ 電池の交換 / ■ 組み立て / ■ 操作方法\n" +
      "   ※備考に作業内容があれば、それを優先して具体的なタイトルにする\n" +
      "2) 2行目以降は番号付きで手順を列挙：\n" +
      "   1. 〜\n" +
      "   2. 〜\n" +
      "3) 最後に「確認事項：」を必要な場合のみ1〜3点\n";

    const userText =
      (notes ? `備考: ${notes}\n` : "") +
      `粒度: ${granularity}\n`;

    const r = await client.responses.create({
      model: MODEL_MANUAL_CHECK,
      reasoning: { effort: MANUAL_CHECK_REASONING },
      text: { verbosity: MANUAL_CHECK_VERBOSITY },
      input: [
        { role: "system", content: sys },
        { role: "user", content: userText },
      ],
      max_output_tokens: 900,
    });

    res.status(200).json({ text: r.output_text || "" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "ServerError" });
  }
}
