// Netlify build: publish only the app itself (no installers, scripts or docs).
import { cpSync, mkdirSync, rmSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const f of ["index.html", "styles.css", "sw.js", "manifest.webmanifest", "js", "icons"]) cpSync(f, `dist/${f}`, { recursive: true });
console.log("dist ready");
