// Phase 1 guards: (1) Automix must not turn up room sound (the "hollow chamber" mix): on a take with
// room reflections, the level right after each phrase may rise no more than 3 dB over the raw take;
// (2) the mic check gives the right verdict on quiet / hot / noisy / roomy / silent recordings;
// (3) the booth records at 48 kHz and the Mic check button works without touching the session.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
const S = process.cwd();
let fails = 0;
const ok = (n, c, x = "") => { if (!c) fails++; console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`); };
const { analyseMicCheck } = await import(new URL("../../js/miccheck.js", import.meta.url));
const fs = 48000;
let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

/** Small untreated room: RT60 0.45 s, reverberant energy `drrDb` under the direct sound. */
function room(x, drrDb) {
  let sd = 99; const r = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const L = Math.round(0.6 * fs), ir = new Float32Array(L);
  let e = 0, lp = 0;
  for (let i = Math.round(0.004 * fs); i < L; i++) { lp += (r() - lp) * 0.5; ir[i] = lp * Math.exp((-6.9 * (i / fs)) / 0.45); e += ir[i] * ir[i]; }
  const g = Math.pow(10, -drrDb / 20) / Math.sqrt(e), y = Float32Array.from(x);
  for (let k = 0; k < L; k += 3) { const c = ir[k] * g * Math.sqrt(3); if (c) for (let i = 0; i + k < x.length; i++) y[i + k] += x[i] * c; }
  return y;
}

// ---- 1. mic check verdicts (pure)
function line(amp) {
  // 3 s silence, then a voiced "line" twice with a clean stop between.
  const x = new Float32Array(fs * 10);
  for (const a of [3.3, 6.2]) {
    let ph = 0;
    for (let i = Math.round(a * fs); i < (a + 1.6) * fs; i++) {
      const t = i / fs, u = (t - a) / 1.6;
      ph += (2 * Math.PI * (125 + 15 * Math.sin(2 * Math.PI * 1.1 * t))) / fs;
      let s = 0;
      for (let h = 1; h < 24; h++) s += Math.sin(ph * h) / h;
      x[i] = amp * 0.42 * s * Math.min(1, u * 40, (1 - u) * 160) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 4 * t) ** 2);
    }
  }
  return x;
}
const withNoise = (x, n) => x.map((v) => v + n * rnd());
const state = (r, key) => r.checks.find((c) => c.key === key)?.state;
const good = analyseMicCheck(withNoise(line(0.35), 0.0003), fs);
ok("mic check: good take → level, noise and room all good", state(good, "level") === "good" && state(good, "noise") === "good" && state(good, "room") === "good", JSON.stringify(good.checks.map((c) => c.title)));
const quiet = analyseMicCheck(withNoise(line(0.02), 0.00003), fs);
ok("mic check: quiet take → says turn the gain up", state(quiet, "level") === "bad" && /gain up/.test(quiet.checks[0].text), quiet.checks[0].title);
const hot = analyseMicCheck(withNoise(line(2.2), 0.0003).map((v) => Math.max(-1, Math.min(1, v))), fs);
ok("mic check: clipped take → says clipping, gain down", state(hot, "level") === "bad" && hot.clipped && /down/.test(hot.checks[0].text), hot.checks[0].title);
const noisy = analyseMicCheck(withNoise(line(0.35), 0.02), fs);
ok("mic check: noisy room → noise flagged", state(noisy, "noise") === "bad", noisy.checks.find((c) => c.key === "noise")?.title);
const roomy = analyseMicCheck(room(withNoise(line(0.35), 0.0003), 8), fs);
ok("mic check: roomy take → room flagged with what to do", state(roomy, "room") === "bad" && /closer|within/.test(roomy.checks.find((c) => c.key === "room").text), `room ${roomy.roomDb.toFixed(1)} dB`);
const mild = analyseMicCheck(room(withNoise(line(0.35), 0.0003), 14), fs);
ok("mic check: mild room reads between dry and roomy", mild.roomDb < roomy.roomDb && mild.roomDb > good.roomDb && state(mild, "room") !== "good", `dry ${good.roomDb.toFixed(1)} · mild ${mild.roomDb.toFixed(1)} · roomy ${roomy.roomDb.toFixed(1)}`);
const silent = analyseMicCheck(withNoise(new Float32Array(fs * 10), 0.0003), fs);
ok("mic check: nothing said → says so, no fake numbers", !silent.heard && silent.checks.length === 1 && state(silent, "level") === "bad", silent.checks[0].title);

// ---- 2. room sound through Automix (browser)
const b0 = readFileSync(`${S}/vocal.wav`); const n = (b0.length - 44) / 2;
const dry = new Float32Array(n); for (let i = 0; i < n; i++) dry[i] = b0.readInt16LE(44 + i * 2) / 32768;
const voices = { dry, mild: room(dry, 14), roomy: room(dry, 8) };
for (const [k, y] of Object.entries(voices)) { const out = Buffer.from(b0); let pk = 0; for (const v of y) pk = Math.max(pk, Math.abs(v)); const g = pk > 0.95 ? 0.95 / pk : 1; for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(y[i] * g * 32767), 44 + i * 2); writeFileSync(`${S}/room-${k}.wav`, out); }
const starts = [0.3, 2.2, 4.0, 6.5, 8.3], ends = [1.6, 3.4, 5.8, 7.6, 10.5];
const lvl = (x, a, z, r) => { let s = 0; const i0 = Math.round(a * r), i1 = Math.min(x.length, Math.round(z * r)); for (let i = i0; i < i1; i++) s += x[i] * x[i]; return 10 * Math.log10(s / Math.max(1, i1 - i0) + 1e-14); };
// Level 30–180 ms after each phrase stops, relative to that phrase. Higher = roomier.
const tail = (x, r) => ends.reduce((a, e, i) => a + lvl(x, e + 0.03, e + 0.18, r) - lvl(x, starts[i], e, r), 0) / ends.length;
// How far the quiet moments inside a phrase sit under its typical level (bigger = choppier).
const dips = (x, r) => { const v = []; for (const [i, a] of starts.entries()) for (let t = a + 0.15; t < ends[i] - 0.15; t += 0.02) v.push(lvl(x, t, t + 0.02, r)); v.sort((p, q) => p - q); return v[Math.floor(v.length * 0.5)] - v[Math.floor(v.length * 0.1)]; };

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${S}/vocal.wav`, "--autoplay-policy=no-user-gesture-required"] });
const errs = [];
const res = {};
for (const k of Object.keys(voices)) {
  const p = await (await b.newContext({ viewport: { width: 1600, height: 960 } })).newPage();
  p.on("pageerror", (e) => errs.push(e.stack));
  await p.goto(process.env.BASE_URL); await p.waitForTimeout(1000);
  await p.setInputFiles("#fileVocal", `${S}/room-${k}.wav`); await p.waitForFunction(() => window.__booth.session.tracks.length === 1);
  await p.evaluate(() => { window.__booth.session.settings.tuneStyle = "off"; window.__booth.session.tracks[0].dbl = "off"; });
  await p.click("#btnAutomix");
  await p.waitForFunction(() => window.__booth.ui.master && !window.__booth.ui.stale && !document.body.classList.contains("busy"), null, { timeout: 300000 });
  const rate = await p.evaluate(() => window.__booth.ui.master.sampleRate);
  const mix = Float32Array.from(await p.evaluate(() => Array.from(window.__booth.ui.master.getChannelData(0))));
  const raw = voices[k];
  res[k] = { rate, raw: tail(raw, fs), mix: tail(mix, rate), rawDips: dips(raw, fs), mixDips: dips(mix, rate), line: (await p.innerText("#report")).split("\n").find((l) => /^Room control/.test(l)) || "" };
  await p.context().close();
}
for (const k of ["mild", "roomy"]) {
  const r = res[k];
  ok(`${k} room: sound after phrases not raised more than 3 dB`, r.mix - r.raw <= 3, `raw ${r.raw.toFixed(1)} → mix ${r.mix.toFixed(1)} dB (${(r.mix - r.raw >= 0 ? "+" : "")}${(r.mix - r.raw).toFixed(1)})`);
  ok(`${k} room: the voice itself is not chopped`, r.mixDips <= r.rawDips + 3, `dips inside phrases: raw ${r.rawDips.toFixed(1)} dB, mix ${r.mixDips.toFixed(1)} dB`);
}
ok("dry take: tail stays 27 dB or more under the voice", res.dry.mix <= -27, `raw ${res.dry.raw.toFixed(1)} → mix ${res.dry.mix.toFixed(1)} dB`);
ok("report names the room and what was done", /dry/.test(res.dry.line) && /roomy/.test(res.roomy.line) && /held down/.test(res.roomy.line), res.roomy.line);
ok("booth runs at 48 kHz", res.dry.rate === 48000, `${res.dry.rate} Hz`);

// ---- 3. Mic check button
{
  const p = await (await b.newContext({ viewport: { width: 1600, height: 960 }, permissions: ["microphone"] })).newPage();
  p.on("pageerror", (e) => errs.push(e.stack));
  await p.goto(process.env.BASE_URL); await p.waitForTimeout(1000);
  await p.evaluate(() => window.__booth.micCheck());
  const items = await p.$$eval("#micCheckOut ul.mc li", (els) => els.map((e) => `${e.className}: ${e.querySelector("b").textContent}`));
  ok("Mic check button: verdicts shown with the sample rate", items.length >= 2 && items.some((t) => /Sample rate/.test(t)), items.join(" | "));
  ok("Mic check: recording rate shown in the Booth tab", /Recording at 48 kHz/.test(await p.textContent("#rateOut")), await p.textContent("#rateOut"));
  ok("Mic check: nothing added to the session", await p.evaluate(() => window.__booth.session.tracks.every((t) => t.takes.length === 0)));
}
ok("no page errors", errs.length === 0, errs.join("\n"));
await b.close();
process.exit(fails ? 1 : 0);
