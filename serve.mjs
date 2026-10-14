// Zero-dependency local server for MV Booth. Microphones need a secure
// origin and http://localhost counts as one. Started by the desktop
// shortcut, it opens the booth as an app window and exits on its own a
// couple of minutes after the window closes.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, spawn } from "node:child_process";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT) || 5177;
const url = `http://localhost:${port}/`;
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".ico": "image/x-icon",
};
let lastPing = 0;
const started = Date.now();

function openWindow() {
  if (process.env.NO_OPEN) return;
  const appArgs = [`--app=${url}`, "--window-size=1560,960"];
  if (process.platform === "win32") {
    const candidates = [
      `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    const exe = candidates.find((p) => p && existsSync(p));
    if (exe) spawn(exe, appArgs, { detached: true, stdio: "ignore" }).unref();
    else exec(`start "" "${url}"`);
  } else if (process.platform === "darwin") {
    exec(`open -na "Google Chrome" --args ${appArgs.join(" ")}`, (err) => err && exec(`open ${url}`));
  } else {
    exec(`xdg-open ${url}`);
  }
}

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  if (path === "__alive") {
    lastPing = Date.now();
    return res.writeHead(204, { "Cache-Control": "no-store" }).end();
  }
  if (path.startsWith("..")) return res.writeHead(403).end();
  const file = path || "index.html";
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.on("error", async (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  // Already running (another window is open): just open a new window.
  try {
    const r = await fetch(`${url}__alive`);
    if (r.ok) {
      openWindow();
      process.exit(0);
    }
  } catch {
    /* fall through */
  }
  console.error(`Port ${port} is taken by another program. Set PORT=5178 and try again.`);
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MV Booth running at ${url}  (close this window or press Ctrl+C to stop)`);
  openWindow();
});

// Auto-exit once the booth has been closed for 2 minutes (or never opened in 5).
if (process.env.AUTO_EXIT !== "0") {
  setInterval(() => {
    const now = Date.now();
    if ((lastPing && now - lastPing > 120000) || (!lastPing && now - started > 300000)) process.exit(0);
  }, 10000).unref?.();
}
