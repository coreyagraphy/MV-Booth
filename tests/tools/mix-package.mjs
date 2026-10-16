// Mix a session package (.mvbooth) all the way through in the real app, headless.
//   node tools/mix-package.mjs <song.mvbooth> <out-dir> [--preset "Rap · Upfront"] [--fix-timing]
// Writes: master WAV + MP3, stems, the engine report, a timing analysis, and a .mvbooth with the
// mix settings so it can be opened (and heard) in MV Booth.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const [pkgPath, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const preset = arg("--preset");
const fixTiming = process.argv.includes("--fix-timing");
if (!pkgPath || !outDir) throw new Error("usage: mix-package.mjs <song.mvbooth> <out-dir> [--preset name] [--fix-timing]");
mkdirSync(outDir, { recursive: true });
const { unpackSession } = await import(join(root, "js/package.js"));
const { estimateBpm } = await import(join(root, "js/dsp.js"));

// ---- 1. Read the package and measure vocal timing against the beat (node side).
const { session, audio } = await unpackSession(new Blob([readFileSync(pkgPath)]));
const fs0 = [...audio.values()][0]?.sampleRate || 48000;
/** Onset strength (half-wave rectified rise of high-passed log energy) on a 5 ms grid. */
function onsets(x, fs) {
  const hop = Math.round(fs * 0.005), n = Math.floor(x.length / hop), e = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * hop + 1; i < (f + 1) * hop; i++) { const d = x[i] - x[i - 1]; s += d * d; }
    e[f] = Math.log10(s + 1e-9);
  }
  const o = new Float32Array(n);
  for (let f = 1; f < n; f++) o[f] = Math.max(0, e[f] - e[f - 1]);
  return o;
}
/** Place a track's clips on the timeline as one mono signal (same rules as session.renderTrack). */
function renderTrack(t, fs, len) {
  const out = new Float32Array(len);
  for (const c of t.clips) {
    const k = t.takes.find((x) => x.id === c.takeId), a = audio.get(c.takeId);
    if (!k || !a) continue;
    const src = a.channels[0];
    for (let i = Math.max(0, Math.round(c.start * fs)); i < Math.min(len, Math.round(c.end * fs)); i++) {
      const si = Math.round((i / fs - (c.shift || 0) - k.at) * a.sampleRate);
      if (si >= 0 && si < src.length) out[i] += src[si];
    }
  }
  return out;
}
const beatLen = Math.max(...session.beats.map((b) => Math.round(((b.offset || 0) * fs0)) + audio.get(b.id).channels[0].length), 0);
const beatMix = new Float32Array(beatLen);
for (const b of session.beats.filter((x) => !x.mute)) {
  const a = audio.get(b.id), o = Math.round((b.offset || 0) * fs0);
  for (let i = 0; i < a.channels[0].length; i++) beatMix[i + o] += a.channels.reduce((s, ch) => s + ch[i], 0) / a.channels.length;
}
const timing = [];
const bpm = session.settings?.bpm || estimateBpm(beatMix, fs0);
const halfSixteenth = bpm ? (60 / bpm / 4 / 2) : 0.06;
const bo = onsets(beatMix, fs0);
for (const t of session.tracks.filter((x) => x.clips.length)) {
  const vo = onsets(renderTrack(t, fs0, beatLen), fs0);
  const maxLag = Math.max(2, Math.floor(halfSixteenth / 0.005)); // within half a 16th: no grid ambiguity
  const corr = [];
  for (let L = -maxLag; L <= maxLag; L++) {
    let s = 0;
    for (let f = Math.max(0, L); f < Math.min(vo.length, bo.length + L); f++) s += vo[f] * bo[f - L];
    corr.push([L * 5, s]);
  }
  const best = corr.reduce((a, b) => (b[1] > a[1] ? b : a));
  const mean = corr.reduce((a, b) => a + b[1], 0) / corr.length;
  timing.push({ track: t.name, id: t.id, lateMs: best[0], strength: +(best[1] / Math.max(1e-9, mean)).toFixed(2), nudgedMs: t.timingMs || 0 });
}

// ---- 2. Mix in the real app (own port, never touches real sessions).
const port = 5195;
const app = spawn(process.execPath, [join(root, "serve.mjs")], { env: { ...process.env, PORT: port, AUTO_EXIT: "0", NO_OPEN: "1" }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 900));
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 960 } });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push(e.message));
try {
  await p.goto(`http://localhost:${port}/`); await p.waitForTimeout(1200);
  await p.setInputFiles("#filePackage", pkgPath);
  await p.waitForFunction((n) => window.__booth.session.name === n && window.__booth.session.tracks.length > 0, session.name, { timeout: 120000 });
  if (fixTiming) {
    for (const t of timing.filter((x) => Math.abs(x.lateMs) >= 10 && x.strength >= 1.3)) {
      await p.evaluate(({ id, ms }) => { const tr = window.__booth.session.tracks.find((x) => x.id === id); for (const c of tr.clips) c.shift = (c.shift || 0) - ms / 1000; tr.timingMs = (tr.timingMs || 0) - ms; }, { id: t.id, ms: t.lateMs });
      t.applied = -t.lateMs;
    }
  }
  if (preset) await p.evaluate((name) => [...document.querySelectorAll("#mixPresets button")].find((x) => x.textContent.includes(name))?.click(), preset);
  const t0 = Date.now();
  await p.click("#btnAutomix");
  await p.waitForFunction(() => window.__booth.ui.master && !window.__booth.ui.stale && !document.body.classList.contains("busy"), null, { timeout: 1800000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const status = await p.textContent("#status");
  const report = await p.innerText("#report");
  const files = [];
  const saves = [];
  p.on("download", (d) => { const f = join(outDir, d.suggestedFilename()); files.push(basename(f)); saves.push(d.saveAs(f)); });
  for (const kind of ["wav", "mp3", "stems", "package"]) {
    const before = files.length;
    await p.evaluate((k) => window.__booth.exportAs(k), kind);
    for (let i = 0; i < 600 && files.length === before; i++) await p.waitForTimeout(100);
    await p.waitForTimeout(kind === "stems" ? 2500 : 300);
  }
  await Promise.all(saves);
  await p.screenshot({ path: join(outDir, "session.png") });
  const md = [
    `# Mix report · ${session.name}`, "",
    `Automix: ${secs} s · ${status}`, "",
    "## Timing (vocal onsets vs the beat's hits, within half a 16th)", "",
    "| Track | Vocal vs beat | Confidence | Already nudged | Applied here |", "|---|---|---|---|---|",
    ...timing.map((t) => `| ${t.track} | ${t.lateMs > 0 ? `${t.lateMs} ms late` : t.lateMs < 0 ? `${-t.lateMs} ms early` : "on it"} | ${t.strength}× | ${t.nudgedMs} ms | ${t.applied ? `${t.applied} ms` : "-"} |`),
    "", "Confidence = how much the best alignment stands out (1.0 = no clear answer; ≥1.3 is a clear rhythmic match). Rap often sits slightly behind the beat on purpose, so small values are style, not error.",
    "", "## Engine report", "", "```", report.trim(), "```", "", "## Files", "", ...files.map((f) => `- ${f}`),
    ...(errs.length ? ["", "## Page errors", "", ...errs.map((e) => `- ${e}`)] : []),
  ].join("\n");
  writeFileSync(join(outDir, "REPORT.md"), md);
  console.log(md);
} finally {
  await b.close();
  app.kill();
}
