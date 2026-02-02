// api/probe.js
import { createRequire } from "module";
const require = createRequire(import.meta.url);

export default function handler(req, res) {
    const results = {};
    const libs = ["openai", "pdf-lib", "@pdf-lib/fontkit", "pdfjs-dist", "pdf-parse"];
    
    for (const lib of libs) {
        try {
            require(lib);
            results[lib] = "OK";
        } catch (e) {
            results[lib] = "FAIL: " + e.message;
        }
    }
    
    res.status(200).json(results);
}
