// Zero-dependency local server. Microphones need a secure origin, and
// http://localhost counts as one, so this is all the booth needs.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT) || 5177;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
  if (path.startsWith("..")) return res.writeHead(403).end();
  try {
    const file = path || "index.html";
    const body = await readFile(join(root, file));
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  const url = `http://localhost:${port}`;
  console.log(`MV Booth running at ${url}  (Ctrl+C to stop)`);
  if (!process.env.NO_OPEN) {
    const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open ${url}` : `xdg-open ${url}`;
    exec(cmd, () => {});
  }
});
