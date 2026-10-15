// MV Booth test runner. Usage (from tests/):  npm install  then  npm test   (or: node run.mjs [suite…] [--backend])
// Serves the app on its own port so tests never touch your real sessions (IndexedDB is per origin).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const out = join(here, ".out");
const args = process.argv.slice(2);
const withBackend = args.includes("--backend");
const SUITES = ["dsp", "declick", "daw", "punch", "ux", "song", "stems", "fixes", "single", ...(withBackend ? ["studio"] : [])];
const pick = args.filter((a) => !a.startsWith("--"));
const run = pick.length ? SUITES.filter((s) => pick.includes(s)) : SUITES;
const APP_PORT = 5199, SINGLE_PORT = 5198;

mkdirSync(out, { recursive: true });
const node = (script, opts = {}) => spawnSync(process.execPath, [script], { cwd: out, stdio: "inherit", ...opts });
if (!existsSync(join(out, "vocal.wav"))) node(join(here, "fixtures/gen-vocal-beat.mjs"));
if (!existsSync(join(out, "double.wav"))) node(join(here, "fixtures/gen-double.mjs"));
if (!existsSync(join(out, "Drums.wav"))) node(join(here, "fixtures/gen-stems.mjs"));

let failed = 0;
const lint = spawnSync(process.execPath, [join(here, "lint.mjs")], { encoding: "utf8" });
const linted = lint.status === 0;
console.log(linted ? `PASS ${lint.stdout.trim()}` : `FAIL lint\n${lint.stdout || lint.stderr}`);
if (!linted) failed++;

const app = spawn(process.execPath, [join(root, "serve.mjs")], { env: { ...process.env, PORT: APP_PORT, AUTO_EXIT: "0", NO_OPEN: "1" }, stdio: "ignore" });
let single = null;
if (run.includes("single")) {
  spawnSync(process.execPath, [join(root, "build.mjs")], { stdio: "ignore" });
  const html = readFileSync(join(root, "dist/index.html"));
  single = createServer((req, res) => (req.url === "/" ? res.writeHead(200, { "Content-Type": "text/html" }).end(html) : res.writeHead(404).end())).listen(SINGLE_PORT, "127.0.0.1");
}
await new Promise((r) => setTimeout(r, 800));

const env = { ...process.env, BASE_URL: `http://localhost:${APP_PORT}/`, SINGLE_URL: `http://127.0.0.1:${SINGLE_PORT}/` };
for (const s of run) {
  // Async: the single-file page server above lives in this process and must keep answering.
  const r = await new Promise((resolve) => {
    const c = spawn(process.execPath, [join(here, "suites", `${s}.mjs`)], { cwd: out, env });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    const kill = setTimeout(() => c.kill(), 600000);
    c.on("close", (status) => resolve((clearTimeout(kill), { status, stdout, stderr })));
  });
  const lines = `${r.stdout}${r.stderr}`.split("\n").filter(Boolean);
  const pass = lines.filter((l) => l.startsWith("PASS")).length;
  const bad = lines.filter((l) => l.startsWith("FAIL"));
  const ok = r.status === 0 && !bad.length && pass > 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${s}: ${pass} checks passed${bad.length ? `, ${bad.length} failed` : ""}`);
  if (!ok) console.log((bad.length ? bad : lines.slice(-12)).map((l) => `    ${l}`).join("\n"));
}
app.kill();
single?.close();
console.log(failed ? `\n${failed} suite(s) failed` : "\nAll green.");
process.exit(failed ? 1 : 0);
