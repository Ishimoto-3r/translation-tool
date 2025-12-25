// api/kensho-ai.js（全文置き換え）
import OpenAI from "openai";

const MODEL = process.env.MODEL_MANUAL_CHECK || "gpt-5.2";
const REASONING = process.env.MANUAL_CHECK_REASONING || "medium";
const VERBOSITY = process.env.MANUAL_CHECK_VERBOSITY || "low";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "MethodNotAllowed" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { productInfo, selectedLabels, currentRows, images } = body;

    const sys =
      "あなたは品質・検証のプロです。\n" +
      "入力情報（一般名称/特徴/備考/選択ラベル）と画像、既存の検証項目を踏まえ、\n" +
      "Excel末尾に記載する『AIコメント（検証ポイント・仕様観点）』を作成してください。\n" +
      "\n" +
      "【重要】出力は JSON（オブジェクト）1つのみ。余計な文章は禁止。\n" +
      "形式：{\n" +
      '  "commentPoints": ["..."],\n' +
      '  "specCandidates": ["..."],\n' +
      '  "gatingQuestions": ["..."]\n' +
      "}\n" +
      "\n" +
      "【制約】\n" +
      "・各配列要素は1文=80文字以内。80文字を超える場合は、自然な位置で分割して別要素にする。\n" +
      "・commentPoints：その商品に固有の検証観点（なぜ重要か/どこで不具合が出やすいか/具体例）\n" +
      "・specCandidates：一般名称から類似品で一般的に提示される重要スペック（候補）\n" +
      "・gatingQuestions：メーカー回答次第で案件可否に影響しうる確認事項（安全/法規/保証/交換部品など）\n" +
      "・既存の検証項目と重複してもOK\n" +
      "・語尾に「検証する」「…であることを検証する」は付けない（体言止め/確認観点の形で）";

    const content = [
      { type: "text", text: JSON.stringify({ productInfo, selectedLabels, currentRows }, null, 2) },
    ];

    if (Array.isArray(images)) {
      for (const img of images) {
        if (typeof img === "string" && (img.startsWith("data:image/") || img.startsWith("http"))) {
          content.push({ type: "image_url", image_url: { url: img } });
        }
      }
    }

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: sys },
        { role: "user", content },
      ],
      reasoning_effort: REASONING,
      verbosity: VERBOSITY,
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";

    // “JSON以外が混じる” 事故を最小化（先頭の{から最後の}までを抜く）
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    const jsonText = (s >= 0 && e > s) ? raw.slice(s, e + 1) : "{}";

    return res.status(200).json({ text: jsonText });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "OpenAIError", detail: String(err) });
  }
}
