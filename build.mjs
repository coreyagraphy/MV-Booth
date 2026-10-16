// Netlify build: publish only the app (no installers, scripts or docs).
// index.html is fully self-contained (CSS + every JS module inlined), so the
// app works even if only that one file gets uploaded. The extra files
// (service worker, manifest, icons) add offline mode and "Install app".
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const ORDER = ["dsp", "store", "wav", "session", "metro", "mp3", "package", "tune", "automix", "doubles", "engine", "app"];

function bundle() {
  // MP3 encoder (LGPL lamejs) travels as a string; mp3.js spins it up in a Worker.
  let out = `globalThis.__LAME_SRC = ${JSON.stringify(readFileSync("js/vendor/lame.min.js", "utf8"))};\nconst __m = {};\n`;
  for (const name of ORDER) {
    let src = readFileSync(`js/${name}.js`, "utf8");
    const exported = [];
    // import { a, b as c } from "./x.js";  →  const { a, b: c } = __m["./x.js"];
    src = src.replace(/^import \{([^}]+)\} from "(\.\/[\w-]+\.js)";/gm, (_, names, from) =>
      `const {${names.replace(/\s+as\s+/g, ": ")}} = __m["${from}"];`,
    );
    src = src.replace(/^import \* as (\w+) from "(\.\/[\w-]+\.js)";/gm, (_, id, from) => `const ${id} = __m["${from}"];`);
    // export { a, b };  (re-exports of names already in scope)
    src = src.replace(/^export \{([^}]+)\};?/gm, (_, names) => {
      exported.push(...names.split(",").map((s) => s.trim()).filter(Boolean));
      return "";
    });
    src = src.replace(/^export (async function\*?|function\*?|const|let|class) (\w+)/gm, (_, kind, id) => {
      exported.push(id);
      return `${kind} ${id}`;
    });
    if (/^\s*(import|export)\s/m.test(src)) throw new Error(`unbundled import/export left in js/${name}.js`);
    if (name === "app") out += `(async () => {\n${src}\n})().catch((e) => { console.error(e); document.getElementById("status").textContent = "Failed to start: " + e.message; });\n`;
    else out += `__m["./${name}.js"] = (() => {\n${src}\nreturn { ${exported.join(", ")} };\n})();\n`;
  }
  return out.replace(/<\/script/gi, "<\\/script");
}

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const f of ["manifest.webmanifest", "icons"]) cpSync(f, `dist/${f}`, { recursive: true });
// The service worker only needs to cache what the single-file build serves.
const sw = readFileSync("sw.js", "utf8").replace(
  /const SHELL = \[[\s\S]*?\];/,
  'const SHELL = ["./", "index.html", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"];',
);
if (!sw.includes('"icons/icon-512.png"];')) throw new Error("sw shell rewrite failed");
// Every build gets its own fingerprint in sw.js: the app's update notice compares it, and the
// cache name changes with it, so a release can never look identical to the one before.
const fp = createHash("sha256");
for (const f of ["index.html", "styles.css", "sw.js", "manifest.webmanifest", ...readdirSync("js").filter((n) => n.endsWith(".js")).map((n) => `js/${n}`)]) fp.update(readFileSync(f));
const build = fp.digest("hex").slice(0, 10);
const swBuilt = sw.replace(/const CACHE = "([^"]+)";/, `const CACHE = "$1-${build}";`);
if (swBuilt === sw) throw new Error("sw cache fingerprint failed");
writeFileSync("dist/sw.js", swBuilt);

const css = readFileSync("styles.css", "utf8");
const svg = readFileSync("icons/icon.svg", "utf8");
let html = readFileSync("index.html", "utf8")
  .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${css}\n</style>`)
  .replace('<link rel="icon" href="icons/icon.svg" type="image/svg+xml" />', () => `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}" />`)
  .replace('<script type="module" src="js/app.js"></script>', () => `<script type="module">\n${bundle()}</script>`);
if (html.includes('src="js/app.js"') || html.includes('href="styles.css"')) throw new Error("inlining failed");
writeFileSync("dist/index.html", html);

// Headers ship inside the folder so drag-and-drop deploys keep them too.
writeFileSync(
  "dist/_headers",
  "/*\n  Permissions-Policy: microphone=(self)\n  X-Robots-Tag: noindex, nofollow\n  X-Content-Type-Options: nosniff\n/sw.js\n  Cache-Control: no-cache\n",
);
console.log(`dist ready · index.html ${(html.length / 1024).toFixed(0)} KB (self-contained)`);
