// Vocal tone guard: on thin, dark, bright and boomy voices the automatic EQ never boosts the
// low-mids (boxy, "in a barrel") and never cuts the air on a rap vocal (dull, "in a tunnel"),
// and a clean close-mic take is not run through de-noise.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
const S = process.cwd();
const ok = (n, c, x = "") => console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`);
const D = await import(new URL("../../js/dsp.js", import.meta.url));
const b0 = readFileSync(`${S}/vocal.wav`); const fs = 48000, n = (b0.length - 44) / 2;
const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = b0.readInt16LE(44 + i * 2) / 32768;
const save = (name, y) => { const out = Buffer.from(b0); let pk = 0; for (const v of y) pk = Math.max(pk, Math.abs(v)); const g = pk > 0.95 ? 0.95 / pk : 1; for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(y[i] * g * 32767), 44 + i * 2); writeFileSync(`${S}/${name}.wav`, out); };
const voices = {
  thin: D.filter(x, D.biquad("highpass", 350, fs, 0.7)),
  dark: D.filter(x, D.biquad("lowpass", 2500, fs, 0.7)),
  bright: D.filter(D.filter(x, D.biquad("peaking", 5000, fs, 0.5, 9)), D.biquad("peaking", 10000, fs, 0.7, 9)),
  // The fixture starts thin in the low-mids, so "boomy" needs a big lift to land above a real voice.
  boomy: D.filter(D.filter(x, D.biquad("peaking", 220, fs, 0.7, 18)), D.biquad("peaking", 480, fs, 0.9, 12)),
};
for (const [k, y] of Object.entries(voices)) save(`voice-${k}`, y);
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
const errs = [];
for (const k of Object.keys(voices)) {
  const p = await (await b.newContext({ viewport: { width: 1600, height: 960 } })).newPage();
  p.on("pageerror", (e) => errs.push(e.stack));
  await p.goto(process.env.BASE_URL); await p.waitForTimeout(1000);
  await p.setInputFiles("#fileVocal", `${S}/voice-${k}.wav`); await p.waitForFunction(() => window.__booth.session.tracks.length === 1);
  await p.click("#btnAutomix");
  await p.waitForFunction(() => window.__booth.ui.master && !window.__booth.ui.stale && !document.body.classList.contains("busy"), null, { timeout: 300000 });
  const rep = await p.innerText("#report");
  const eq = rep.split("\n").find((l) => /^Tone EQ/.test(l)) || "";
  const nr = rep.split("\n").find((l) => /^Noise reduction/.test(l)) || "";
  const val = (re) => +(eq.match(re)?.[1] ?? NaN);
  const mud = val(/250 Hz ([+-]?[\d.]+) dB/), box = val(/500 Hz ([+-]?[\d.]+) dB/), air = val(/air ([+-]?[\d.]+) dB/);
  ok(`${k} voice: no low-mid boost, no air cut`, mud <= 0 && box <= 0 && air >= 0, eq);
  if (k === "boomy") ok("boomy voice: its low-mids get cut", mud < 0 || box < 0, eq);
  if (k === "thin" || k === "bright") ok(`${k} voice: clean take skips de-noise`, /skipped/.test(nr), nr);
}
ok("no page errors", errs.length === 0, errs.join("\n"));
await b.close();
