import OpenAI from "openai";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as pdfjsLib from "pdfjs-dist";

export const config = {
    api: { bodyParser: false },
};

export default async function handler(req, res) {
    try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) throw new Error("Missing API Key");
        const client = new OpenAI({ apiKey });

        const version = pdfjsLib.version;

        return res.status(200).json({ 
            status: "alive", 
            message: "All major libraries loaded",
            pdfjsVersion: version
        });
    } catch (e) {
        return res.status(500).json({ status: "caught", error: e.message, stack: e.stack });
    }
}
