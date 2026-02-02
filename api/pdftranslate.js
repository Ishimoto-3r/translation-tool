import OpenAI from "openai";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function loadFontData(lang) {
    const isZh = lang.includes("zh");
    const urls = isZh 
        ? ["https://github.com/asfadmin/noto-sans-sc-subset/raw/master/fonts/NotoSansSC-Regular.ttf"]
        : ["https://github.com/mizdra/noto-sans-jp-subset-for-vercel/raw/main/public/NotoSansJP-Regular.ttf"];
    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (res.ok) return await res.arrayBuffer();
        } catch (e) {}
    }
    return null;
}

async function createPdf(text, lang) {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const fontData = await loadFontData(lang);
    let font = fontData ? await pdfDoc.embedFont(fontData) : await pdfDoc.embedFont(StandardFonts.Helvetica);

    const page = pdfDoc.addPage();
    page.drawText(text.slice(0, 500), { x: 50, y: 700, size: 10, font });
    return Buffer.from(await pdfDoc.save());
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");

    try {
        if (req.url.includes("mock=true")) {
            const mockTranslated = "これはテスト翻訳です。This is a test translation. 这是测试翻译。";
            const finalPdf = await createPdf(mockTranslated, "ja-zh");
            res.setHeader("Content-Type", "application/pdf");
            return res.status(200).send(finalPdf);
        }

        return res.status(200).json({ status: "alive", mode: "mock-ready" });
    } catch (e) {
        return res.status(500).json({ error: e.message, stack: e.stack });
    }
}
