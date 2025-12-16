// api/manual-ai.js
import OpenAI from "openai";
const MODEL_MANUAL = process.env.MODEL_MANUAL || "gpt-5.2";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

    const messages = [
      {
        role: "system",
        content: "あなたは日本語マニュアル作成のアシスタントです。必ず日本語のみで回答してください。",
      },
    ];

    const userContent = [{ type: "text", text: prompt }];

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
  model: MODEL_MANUAL,
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
