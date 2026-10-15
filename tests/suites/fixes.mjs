// Regression checks for the 2.5.1 audit fixes.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
const S = process.cwd();
const ok = (n, c, x = "") => console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`);

// A 0.3 s "yeah!" ad-lib: too short for gated BS.1770 loudness.
const fs = 48000, n = Math.round(0.3 * fs), hdr = Buffer.alloc(44), pcm = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(0.25 * Math.sin((2 * Math.PI * 180 * i) / fs) * Math.sin((Math.PI * i) / n) * 32767), i * 2);
hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVEfmt ", 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
hdr.writeUInt32LE(fs, 24); hdr.writeUInt32LE(fs * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write("data", 36); hdr.writeUInt32LE(pcm.length, 40);
writeFileSync(`${S}/adlib.wav`, Buffer.concat([hdr, pcm]));

const { loudnessOf } = await import(new URL("../../js/dsp.js", import.meta.url));
const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;
const lo = typeof loudnessOf === "function" ? loudnessOf([x, x], fs) : NaN;
ok("loudness of a 0.3 s clip is measurable", Number.isFinite(lo), String(lo));
ok("silence stays −∞ (no gain applied)", typeof loudnessOf === "function" && loudnessOf([new Float32Array(fs)], fs) === -Infinity);

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${S}/vocal.wav`, "--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 960 } });
const p = await ctx.newPage();
p.on("dialog", (d) => d.accept());
const errs = []; p.on("pageerror", (e) => errs.push(e.stack)); p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
const B = (fn, a) => p.evaluate(fn, a);
const mixed = () => p.waitForFunction(() => window.__booth.ui.master && !window.__booth.ui.stale && !document.body.classList.contains("busy"), null, { timeout: 180000 });
await p.goto(process.env.BASE_URL); await p.waitForTimeout(1200);
await p.setInputFiles("#fileBeat", `${S}/beat.wav`); await p.waitForFunction(() => window.__booth.session.beats.length === 1);
await p.setInputFiles("#fileVocal", `${S}/vocal.wav`); await p.waitForFunction(() => window.__booth.session.tracks.length === 1);
// Ad-lib on its own track, placed at 0:00 with a clip that starts a hair before zero (punch at 0:00).
await B(() => (window.__booth.ui.selTrack = null));
await p.setInputFiles("#fileVocal", `${S}/adlib.wav`); await p.waitForFunction(() => window.__booth.session.tracks.length === 2);
await B(() => { const t = window.__booth.session.tracks[1]; t.type = "adlib"; t.clips[0].start = -0.005; });
await p.click("#btnAutomix"); await mixed();
const st = await p.textContent("#status");
ok("Automix survives a clip starting before 0:00", /-1[34]\.\d LUFS/.test(st), st);
const files = [], saves = [];
p.on("download", (d) => { const path = `${S}/fix_${files.length}_${d.suggestedFilename()}`; files.push(path); saves.push(d.saveAs(path)); });
await B(() => window.__booth.exportAs("stems"));
for (let i = 0; i < 40 && files.length < 3; i++) await p.waitForTimeout(250);
await Promise.all(saves);
const ad = files.find((f) => /adlib/i.test(f));
if (ad) {
  const w = readFileSync(ad); let pk = 0;
  for (let o = 44; o + 3 <= w.length; o += 3) pk = Math.max(pk, Math.abs(w.readIntLE(o, 3)) / 8388608);
  ok("0.3 s ad-lib is not boosted 30 dB", pk < 0.9, `stem peak ${(20 * Math.log10(pk)).toFixed(1)} dBFS`);
} else ok("ad-lib stem exported", false, files.join());
// Undo while recording is refused and the recording keeps going.
await p.locator(".lane.vocal .arm").first().click();
await p.click('.tabs button[data-tab="booth"]'); await p.click("#btnMic"); await p.waitForTimeout(500);
await p.selectOption("#countIn", "0");
const before = await B(() => window.__booth.session.tracks.length);
await p.keyboard.press("r"); await p.waitForTimeout(700);
await p.keyboard.press("Control+z"); await p.waitForTimeout(200);
ok("undo refused while recording", (await B(() => !!window.__booth.ui.recording)) && /Wait for the recording/.test(await p.textContent("#toast")), await p.textContent("#toast"));
await p.keyboard.press("r"); await p.waitForFunction(() => !window.__booth.ui.recording, null, { timeout: 15000 });
ok("recording still lands as a take", await B(() => window.__booth.session.tracks.some((t) => t.takes.length > 1)) && (await B(() => window.__booth.session.tracks.length)) === before);
// Edits are flushed when the window goes away.
await p.click("#btnSnap");
const want = await B(() => window.__booth.session.settings.snap);
await B(() => dispatchEvent(new Event("pagehide")));
await p.waitForTimeout(150);
const saved = await B(async () => { const st = await import("./js/store.js"); return (await st.get(`session:${window.__booth.session.id}`)).settings.snap; });
ok("pending save flushed on pagehide", saved === want);
// Duplicate, trash the original long ago, purge: the copy keeps its audio.
const shared = await B(async () => {
  const S2 = await import("./js/session.js"); const st = await import("./js/store.js");
  const orig = window.__booth.session; await S2.saveSession(orig);
  const copy = S2.duplicateSession(orig); await S2.saveSession(copy);
  const idx = (await st.get("sessions")) || []; if (!idx.find((r) => r.id === copy.id)) idx.push({ id: copy.id, name: copy.name });
  const row = idx.find((r) => r.id === orig.id); row.deletedAt = Date.now() - 31 * 864e5; await st.set("sessions", idx);
  await S2.listSessions(); // purges the original
  const ids = copy.tracks.flatMap((t) => t.takes.map((k) => k.id));
  const found = await Promise.all(ids.map((id) => st.get(`audio:${id}`)));
  return { n: ids.length, alive: found.filter(Boolean).length, origGone: !(await st.get(`session:${orig.id}`)) };
});
ok("purging the original keeps the duplicate's audio", shared.origGone && shared.n > 0 && shared.alive === shared.n, JSON.stringify(shared));
ok("no page errors", errs.length === 0, errs.join("\n"));
await b.close();
