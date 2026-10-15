// Automix timing on a full 3-minute song (lead + double + beat). Usage: node bench.mjs  (from tests/, after npm test once)
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const here = dirname(fileURLToPath(import.meta.url)), out = join(here, ".out"), root = join(here, "..");
// Tile the 12 s fixtures to 180 s.
const tile = (src, dst, times) => {
  if (existsSync(dst)) return;
  const b = readFileSync(src), data = b.subarray(44), body = Buffer.concat(Array(times).fill(data)), h = Buffer.from(b.subarray(0, 44));
  h.writeUInt32LE(36 + body.length, 4); h.writeUInt32LE(body.length, 40); writeFileSync(dst, Buffer.concat([h, body]));
};
for (const f of ["vocal", "double", "beat"]) tile(join(out, `${f}.wav`), join(out, `${f}3m.wav`), 15);
const app = spawn(process.execPath, [join(root, "serve.mjs")], { env: { ...process.env, PORT: 5197, AUTO_EXIT: "0", NO_OPEN: "1" }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const p = await b.newPage({ viewport: { width: 1600, height: 960 } });
await p.goto("http://localhost:5197/"); await p.waitForTimeout(1000);
await p.setInputFiles("#fileBeat", join(out, "beat3m.wav")); await p.waitForFunction(() => window.__booth.session.beats.length === 1);
await p.setInputFiles("#fileVocal", join(out, "vocal3m.wav")); await p.waitForFunction(() => window.__booth.session.tracks.length === 1);
await p.evaluate(() => (window.__booth.ui.selTrack = null));
await p.setInputFiles("#fileVocal", join(out, "double3m.wav")); await p.waitForFunction(() => window.__booth.session.tracks.length === 2);
await p.evaluate(() => { const [l, d] = window.__booth.session.tracks; d.type = "double"; l.dbl = "pair"; });
const mix = async (label) => {
  const t0 = Date.now();
  await p.click("#btnAutomix");
  await p.waitForFunction(() => window.__booth.ui.master && !window.__booth.ui.stale && !document.body.classList.contains("busy"), null, { timeout: 900000 });
  console.log(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s · ${await p.textContent("#status")}`);
};
let cdp = null;
if (process.env.PROFILE) { cdp = await p.context().newCDPSession(p); await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 1000 }); await cdp.send("Profiler.start"); }
await mix("Automix, natural tune, AI doubles");
if (cdp) {
  const { profile } = await cdp.send("Profiler.stop");
  const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas; const counts = new Map();
  profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (dt[i] || 0)));
  for (const [id, us] of counts) { const n = byId.get(id); const k = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) || 0) + us); }
  console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, us]) => `  ${(us / 1e6).toFixed(1)}s ${k}`).join("\n"));
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n);
  const via = new Map();
  for (const [id, us] of counts) { const n = byId.get(id); if (n.callFrame.functionName !== "fft") continue; const pn = parent.get(id); const k = `${pn.callFrame.functionName} ${pn.callFrame.url.split("/").pop()}:${pn.callFrame.lineNumber + 1}`; via.set(k, (via.get(k) || 0) + us); }
  console.log("fft by caller:\n" + [...via].sort((a, b) => b[1] - a[1]).map(([k, us]) => `  ${(us / 1e6).toFixed(1)}s ${k}`).join("\n"));
}
await p.evaluate(() => { const s = window.__booth.session.settings; s.tuneStyle = "off"; s.key = 0; for (const t of window.__booth.session.tracks) t.dbl = "off"; s.stages.align = false; });
await mix("Automix, tuning/align/doubles off");
// UI: time a full redraw and a clip drag frame.
const ui = await p.evaluate(() => {
  const time = (fn) => { fn(); const t0 = performance.now(); for (let i = 0; i < 10; i++) fn(); return (performance.now() - t0) / 10; };
  window.__booth.session.tracks.forEach((t) => (t.showTakes = true));
  return { all: time(window.__booth.renderAll), lanes: time(window.__booth.renderLanesOnly) };
});
console.log(`UI: full re-render ${ui.all.toFixed(1)} ms · timeline redraw (every drag/zoom frame) ${ui.lanes.toFixed(1)} ms`);
await b.close(); app.kill();
