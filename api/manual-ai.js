// api/manual-ai.js
import OpenAI from "openai";

const MODEL_MANUAL_CHECK =
  process.env.MODEL_MANUAL_CHECK ||
  process.env.MODEL_MANUAL || // 互換用（今は残す）
  "gpt-5.2";

const MODEL_MANUAL_IMAGE = process.env.MODEL_MANUAL_IMAGE || "gpt-5.1";

const MANUAL_CHECK_REASONING = process.env.MANUAL_CHECK_REASONING || "medium";
const MANUAL_CHECK_VERBOSITY = process.env.MANUAL_CHECK_VERBOSITY || "low";

const MANUAL_IMAGE_REASONING = process.env.MANUAL_IMAGE_REASONING || "none";
const MANUAL_IMAGE_VERBOSITY = process.env.MANUAL_IMAGE_VERBOSITY || "low";

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
    const { prompt, image, mode } = body;

    if (!prompt) {
      return res.status(400).json({ error: "PromptRequired" });
    }

    const messages = [
      {
        role: "system",
        content:
          "あなたは日本語マニュアル作成のアシスタントです。必ず日本語のみで回答してください。",
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

    const isCheck = (mode || "check") === "check";

    const completion = await client.chat.completions.create({
      model: isCheck ? MODEL_MANUAL_CHECK : MODEL_MANUAL_IMAGE,
      messages,
      reasoning_effort: isCheck ? MANUAL_CHECK_REASONING : MANUAL_IMAGE_REASONING,
      verbosity: isCheck ? MANUAL_CHECK_VERBOSITY : MANUAL_IMAGE_VERBOSITY,
    });

    const text = completion.choices[0]?.message?.content ?? "";
    return res.status(200).json({ text });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "OpenAIError",
      detail: String(err),
    });
  }
}
