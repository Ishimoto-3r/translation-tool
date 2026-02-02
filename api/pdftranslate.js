import OpenAI from "openai";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

export default function handler(req, res) {
    res.status(200).json({ status: "alive", type: "standard-imports", timestamp: Date.now() });
}
