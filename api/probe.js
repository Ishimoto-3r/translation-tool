// api/probe.js
import fs from "fs";
import path from "path";

function findFile(startPath, filter) {
    let results = [];
    if (!fs.existsSync(startPath)) return results;
    
    const files = fs.readdirSync(startPath);
    for (let i = 0; i < files.length; i++) {
        const filename = path.join(startPath, files[i]);
        const stat = fs.lstatSync(filename);
        if (stat.isDirectory()) {
            if (filename.includes("node_modules")) continue; 
            results = results.concat(findFile(filename, filter));
        } else if (filename.indexOf(filter) >= 0) {
            results.push(filename);
        }
    }
    return results;
}

export default function handler(req, res) {
    try {
        const root = process.cwd();
        const fonts = findFile(root, ".ttf");
        
        res.status(200).json({
            root,
            fonts,
            filesInApi: fs.existsSync(path.join(root, "api")) ? fs.readdirSync(path.join(root, "api")) : "api not found",
            filesInApiFonts: fs.existsSync(path.join(root, "api", "fonts")) ? fs.readdirSync(path.join(root, "api", "fonts")) : "api/fonts not found"
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}
