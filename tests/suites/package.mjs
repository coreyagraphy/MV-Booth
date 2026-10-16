// Session package (.mvbooth): lossless-enough round trip of the whole session, in node and in the app.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const S = process.cwd();
const ok = (n, c, x = "") => console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`);
const P = await import(new URL("../../js/package.js", import.meta.url));

// Node: pack/unpack a hand-made session.
let seed = 4; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const mk = (n, ch = 1) => ({ sampleRate: 48000, channels: Array.from({ length: ch }, () => Float32Array.from({ length: n }, () => 0.8 * rnd())) });
const audio = new Map([["b1", mk(48000, 2)], ["k1", mk(24000)], ["k2", mk(12000)], ["unused", mk(9000)]]);
// Takes can go past full scale inside the app (float): +6 dB of input gain on a loud line.
for (let i = 0; i < 24000; i += 50) audio.get("k1").channels[0][i] *= 2.4;
const session = {
  id: "s1", name: "Test song", settings: { bpm: 92 }, markers: [{ t: 1, name: "Verse" }],
  beats: [{ id: "b1", name: "beat", kind: "full", volumeDb: -3, pan: 0, mute: false, solo: false, offset: 0 }],
  tracks: [{ id: "t1", name: "Lead 1", type: "lead", timingMs: -20, clean: { denoise: 0.7 },
    takes: [{ id: "k1", at: 0.5 }, { id: "k2", at: 2 }, { id: "unused", at: 0 }],
    clips: [{ id: "c1", takeId: "k1", start: 0.5, end: 1, shift: -0.02 }, { id: "c2", takeId: "k2", start: 2, end: 2.25, shift: 0 }] }],
};
const blob = await P.packSession(session, audio);
const back = await P.unpackSession(blob);
let err = 0;
for (const [id, a] of back.audio) a.channels.forEach((c, ci) => c.forEach((v, i) => (err = Math.max(err, Math.abs(v - audio.get(id).channels[ci][i])))));
ok("round trip: every sample within 24-bit precision, nothing clipped above full scale", err < 4e-7, `max error ${err.toExponential(1)} (${(20 * Math.log10(err)).toFixed(0)} dB)`);
ok("round trip: session model intact (clips, shift, timing nudge, clean, markers, beats)",
  JSON.stringify(back.session.tracks[0].clips) === JSON.stringify(session.tracks[0].clips) && back.session.tracks[0].timingMs === -20 &&
  back.session.tracks[0].clean.denoise === 0.7 && back.session.markers[0].name === "Verse" && back.session.beats[0].volumeDb === -3);
ok("takes no clip uses are left out", !back.audio.has("unused") && back.session.tracks[0].takes.length === 2 && back.audio.size === 3);
const raw = (48000 * 2 + 24000 + 12000) * 4;
ok("package is compact", blob.size < raw * 0.8, `${(blob.size / 1024).toFixed(0)} KB vs ${(raw / 1024).toFixed(0)} KB as float`);
let bad = null;
try { await P.unpackSession(new Blob([new Uint8Array([1, 2, 3, 4])])); } catch (e) { bad = e.message; }
ok("a non-package file is refused with a clear message", !!bad, bad);

// App: export from one browser profile, open in a fresh one.
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
const errs = [];
const page = async () => { const c = await b.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 960 } }); const p = await c.newPage(); p.on("pageerror", (e) => errs.push(e.stack)); await p.goto(process.env.BASE_URL); await p.waitForTimeout(1200); return p; };
const p1 = await page();
await p1.setInputFiles("#fileBeat", `${S}/beat.wav`); await p1.waitForFunction(() => window.__booth.session.beats.length === 1);
await p1.setInputFiles("#fileVocal", `${S}/vocal.wav`); await p1.waitForFunction(() => window.__booth.session.tracks.length === 1);
await p1.evaluate(() => { const t = window.__booth.session.tracks[0]; t.clips[0].shift = -0.03; t.timingMs = -30; t.volumeDb = -2; window.__booth.session.name = "Nuclear test"; });
await p1.click("#btnExport"); await p1.waitForTimeout(150);
const [dl] = await Promise.all([p1.waitForEvent("download", { timeout: 60000 }), p1.click('#exportMenu button[data-exp="package"]')]);
const file = `${S}/${dl.suggestedFilename()}`; await dl.saveAs(file);
ok("Export → Session package downloads a .mvbooth", /\.mvbooth$/.test(file) && readFileSync(file).length > 1000, `${dl.suggestedFilename()} · ${(readFileSync(file).length / 1048576).toFixed(1)} MB`);
const orig = await p1.evaluate(() => { const s = window.__booth.session; const t = s.tracks[0]; const a = window.__booth.audio.get(t.clips[0].takeId).getChannelData(0); return { clips: t.clips, timingMs: t.timingMs, vol: t.volumeDb, beat: s.beats[0].name, sum: a.reduce((x, v, i) => x + v * (i % 31), 0), n: a.length }; });
const p2 = await page();
await p2.evaluate(() => (document.querySelector(".tabs button[data-tab=booth]") || {}).click?.());
await p2.setInputFiles("#filePackage", file);
await p2.waitForFunction(() => window.__booth.session.name === "Nuclear test", null, { timeout: 60000 });
const got = await p2.evaluate(() => { const s = window.__booth.session; const t = s.tracks[0]; const a = window.__booth.audio.get(t.clips[0].takeId).getChannelData(0); return { clips: t.clips, timingMs: t.timingMs, vol: t.volumeDb, beat: s.beats[0].name, sum: a.reduce((x, v, i) => x + v * (i % 31), 0), n: a.length }; });
ok("opening it in a fresh browser restores the session", JSON.stringify(got.clips) === JSON.stringify(orig.clips) && got.timingMs === -30 && got.vol === -2 && got.beat === orig.beat, JSON.stringify({ timing: got.timingMs, vol: got.vol }));
ok("…with the same audio (peaks above full scale kept)", got.n === orig.n && Math.abs(got.sum - orig.sum) < 1e-4 * Math.max(1, Math.abs(orig.sum)), `${got.sum.toFixed(3)} vs ${orig.sum.toFixed(3)}`);
await p2.reload(); await p2.waitForTimeout(1500);
ok("…and it persists as its own session", await p2.evaluate(() => window.__booth.session.name === "Nuclear test" && window.__booth.session.tracks[0].takes.length > 0));
ok("no page errors", errs.length === 0, errs.join("\n"));
await b.close();
