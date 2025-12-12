// api/manual-ai.js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- サーバ側で強制したい除外ルール（必要に応じて増やす） ---
const EXCLUDE_SECTION_TITLES = [
  "■ご使用済みの製品の廃棄に関して",
  "■電波に関する注意事項",
  "■技適マーク",
];

function stripPageRefs(text) {
  // P108, p108, （P108）, P108-P109, P108～P109 などを「参照しない」ため削る
  return text
    .replace(/（?\s*[Pp]\s*\d+\s*(?:[-～〜]\s*[Pp]?\s*\d+)?\s*）?/g, "")
    .replace(/[（(]\s*[Pp]\s*\d+[^）)]*[）)]/g, ""); // 念のため
}

function removeExcludedSections(text) {
  // 「■タイトル」以降を次の「■」まで丸ごと落とす（存在すれば）
  let out = text;
  for (const title of EXCLUDE_SECTION_TITLES) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(^|\\n)${escaped}[\\s\\S]*?(?=\\n■|$)`,
      "g"
    );
    out = out.replace(re, "\n");
  }
  return out;
}

function normalizeLineBreaks(text) {
  // Shift+Enter と Enter を区別しない：AIに余計な指摘をさせないため、連続改行を軽く整形
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "MethodNotAllowed" });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { prompt, image } = body;

    if (!prompt) {
      return res.status(400).json({ error: "PromptRequired" });
    }

    // --- ここが重要：フロントが未修正でもサーバ側で強制的に整形/除外 ---
    let cleanedPrompt = prompt;
    cleanedPrompt = removeExcludedSections(cleanedPrompt);
    cleanedPrompt = stripPageRefs(cleanedPrompt);
    cleanedPrompt = normalizeLineBreaks(cleanedPrompt);

    const messages = [
      {
        role: "system",
        content:
          [
            "あなたは日本語マニュアルの校正・表記ゆれチェックのアシスタントです。日本語のみで回答してください。",
            "",
            "【必須ルール】",
            "1) Shift+Enter 由来の改行と通常改行は区別せず、改行方法に関する指摘（可読性の指摘）をしないこと。",
            "2) ページ番号（例：P108 など）やページ参照に関する指摘を一切しないこと。",
            "3) 画像上の単語・短いラベル・番号（例：①②、固定ネジ、凹部 等）は解析対象外。文章（文として成立する説明文）のみを対象にすること。",
            `4) 次のセクションは解析対象外：${EXCLUDE_SECTION_TITLES.join(" / ")}。`,
            "",
            "出力は、修正指摘がある場合のみ簡潔に箇条書きで示すこと。",
          ].join("\n"),
      },
    ];

    const userContent = [{ type: "text", text: cleanedPrompt }];

    if (typeof image === "string") {
      if (image.startsWith("data:image/") || image.startsWith("http")) {
        userContent.push({
          type: "image_url",
          image_url: { url: image },
        });
      }
    }

    messages.push({ role: "user", content: userContent });

    const completion = await client.chat.completions.create({
      model: "gpt-5.1",
      messages,
    });

    const text = completion.choices[0]?.message?.content ?? "";
    res.status(200).json({ text });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "OpenAIError",
      detail: String(err),
    });
  }
}
