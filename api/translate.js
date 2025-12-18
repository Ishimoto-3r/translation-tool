// api/translate.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { systemPrompt, userPrompt, sourceLang, targetLang } = body;

    if (!userPrompt) {
      return res.status(400).json({ error: "userPrompt is required" });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    }

    // --- targetLang を確定（フロントから渡されるのが理想。無い場合は systemPrompt から推定） ---
    const guessedTarget =
      targetLang ||
      (() => {
        const sp = String(systemPrompt || "");
        // 例: "日本語を中国語に翻訳してください" / "任意の言語を日本語に翻訳してください"
        const m = sp.match(/を\s*([^に]+)\s*に\s*翻訳/);
        return m ? m[1].trim() : "日本語"; // 最悪のフォールバック
      })();

    const isJapaneseTarget = guessedTarget === "日本語";

    // --- 翻訳の自然さ（意訳寄り）を強制 ---
    const styleRules = `
- 直訳ではなく、${guessedTarget}として自然な文章に意訳してください（ビジネス文脈は丁寧に）。
- 不自然な逐語訳は禁止です。
- 型番・数値・記号（USB-C, ODM, 3.7V 等）は可能な限り保持してください。
- 余計な解説は禁止。翻訳文のみ返してください。
`.trim();

    // --- 日本語ターゲット時のみ：挨拶の正規化ルール ---
    const jpGreetingRules = isJapaneseTarget
      ? `
- 挨拶・定型表現は日本語の自然な定型に正規化してください。
  例：下午好=こんにちは / 早上好=おはようございます / 晚上好=こんばんは
- 「午後好」のような不自然な直訳は禁止です。
`.trim()
      : "";

    const baseSystem = `
あなたはプロの翻訳者です。
${styleRules}
${jpGreetingRules}
`.trim();

    const model = process.env.MODEL_TRANSLATE || "gpt-5.1";
    const reasoning_effort = process.env.TRANSLATE_REASONING || "low";
    const verbosity = process.env.TRANSLATE_VERBOSITY || "low";

    // JSON固定（フロント側は data.translatedText を受けるだけにする）
    async function callOnce(extraHint = "") {
      const apiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: baseSystem },
            {
              role: "user",
              content:
                `【翻訳方向】${sourceLang || "任意"} → ${guessedTarget}\n` +
                `【原文】\n${userPrompt}\n\n` +
                (systemPrompt ? `【追加条件】\n${systemPrompt}\n\n` : "") +
                (extraHint ? `【追加指示】\n${extraHint}\n` : "")
            },
          ],
          response_format: { type: "json_object" },
          reasoning_effort,
          verbosity,
        }),
      });

      const data = await apiResponse.json();
      if (!apiResponse.ok) {
        const msg = data?.error?.message || `OpenAI API error: ${apiResponse.status}`;
        throw new Error(msg);
      }

      // { translatedText: "..." } を期待（無ければ拾える形も救済）
      let obj;
      try {
        obj = JSON.parse(data.choices?.[0]?.message?.content || "{}");
      } catch {
        obj = {};
      }
      const out =
        (typeof obj.translatedText === "string" && obj.translatedText.trim()) ? obj.translatedText.trim() :
        (typeof obj.text === "string" && obj.text.trim()) ? obj.text.trim() :
        (typeof obj.ja === "string" && obj.ja.trim()) ? obj.ja.trim() :
        "";

      return out;
    }

    // 1回目
    let translatedText = await callOnce("");

    // --- 全方向の根本治療：同文返し（未翻訳）を検知して1回だけ再試行 ---
    // ※「こんにちは」→「你好」などの短文で起きやすい事故を潰す
    const inText = String(userPrompt).trim();
    const outText = String(translatedText).trim();

    const shouldRetry = inText && outText && (inText === outText);

    if (shouldRetry) {
      translatedText = await callOnce(
        `原文のコピーは禁止です。必ず${guessedTarget}に翻訳してください。短文でも翻訳してください。`
      );
    }

    // --- 日本語ターゲット時のみ：最低限の日本語らしさチェック（かな無し＝未翻訳疑い） ---
    if (isJapaneseTarget) {
      const hasKana = /[\u3040-\u309F\u30A0-\u30FF]/.test(translatedText || "");
      if (!hasKana) {
        // もう1回だけ強制（最大2回目）
        translatedText = await callOnce(
          `出力は必ず自然な日本語。ひらがな/カタカナを含めてください。挨拶は定型に正規化してください。`
        );
      }
    }

    if (!translatedText) {
      return res.status(502).json({ error: "TranslationFailed", detail: "翻訳結果が空でした" });
    }

    return res.status(200).json({ translatedText });

  } catch (e) {
    return res.status(500).json({ error: "Internal Server Error", detail: String(e) });
  }
}
