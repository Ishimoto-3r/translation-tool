// api/probe.js
export default async function handler(req, res) {
    const results = { alive: true };
    const libs = ["openai", "pdf-lib", "@pdf-lib/fontkit", "pdfjs-dist", "pdf-parse"];
    
    for (const lib of libs) {
        try {
            await import(lib);
            results[lib] = "OK";
        } catch (e) {
            results[lib] = "FAIL: " + e.message;
        }
    }
    
    res.status(200).json(results);
}
