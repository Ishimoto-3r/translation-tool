import OpenAI from "openai";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

export default async function handler(req, res) {
    try {
        console.log("[pdftranslate] Probe 3 start");
        const apiKey = process.env.OPENAI_API_KEY;
        
        if (!apiKey) {
            return res.status(200).json({ status: "warning", message: "OPENAI_API_KEY is missing" });
        }

        const client = new OpenAI({ apiKey });
        
        return res.status(200).json({ 
            status: "alive", 
            message: "OpenAI Client Initialized",
            node: process.version 
        });
    } catch (e) {
        return res.status(200).json({ status: "caught", error: e.message, stack: e.stack });
    }
}
