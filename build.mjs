// Netlify build: publish only the app itself (no installers, scripts or docs).
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const f of ["index.html", "styles.css", "sw.js", "manifest.webmanifest", "js", "icons"]) cpSync(f, `dist/${f}`, { recursive: true });
// Headers ship inside the folder so drag-and-drop deploys keep them too.
writeFileSync(
  "dist/_headers",
  "/*\n  Permissions-Policy: microphone=(self)\n  X-Robots-Tag: noindex, nofollow\n  X-Content-Type-Options: nosniff\n/sw.js\n  Cache-Control: no-cache\n",
);
console.log("dist ready");
