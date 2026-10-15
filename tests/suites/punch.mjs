import { chromium } from "playwright-core";
const S = process.cwd();
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${S}/vocal.wav`, "--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage({ viewport: { width: 1600, height: 960 } });
const errs = []; p.on("console", (m) => m.text().startsWith("DBG") && console.log(m.text())); p.on("pageerror", (e) => errs.push(e.stack)); p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
const B = (fn, a) => p.evaluate(fn, a);
const ok = (n, c, x = "") => console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`);
await p.goto(process.env.BASE_URL); await p.waitForTimeout(1200);
await p.setInputFiles("#fileBeat", `${S}/beat.wav`); await p.waitForFunction(() => window.__booth.session.beats.length);
await p.setInputFiles("#fileVocal", `${S}/vocal.wav`); await p.waitForFunction(() => window.__booth.session.tracks.length === 1);
await p.locator(".lane.vocal .arm").first().click();
// boundaries inside sung notes
const rb = await p.locator("#ruler").boundingBox(); const v = await B(() => window.__booth.ui.view);
const X = (t) => rb.x + (t - v.start) * v.pps;
await p.keyboard.down("Shift"); await p.mouse.move(X(4.5), rb.y + 15); await p.mouse.down(); await p.mouse.move(X(5.4), rb.y + 15, { steps: 8 }); await p.mouse.up(); await p.keyboard.up("Shift");
const punch = await B(() => window.__booth.session.punch);
ok("shift-drag sets punch", punch.on && punch.out > punch.in, JSON.stringify(punch));
await p.click("#btnMic"); await p.waitForTimeout(600);
await p.keyboard.press("r");
await p.waitForTimeout(800);
ok("pre-roll starts 1 bar early", Math.abs((await B(() => window.__booth.ui.recording?.from)) - (punch.in - 60 / 92 * 4)) < 0.01);
await p.waitForFunction(() => !window.__booth.ui.recording, null, { timeout: 20000 });
ok("auto-stopped after post-roll", true, await p.textContent("#status"));
const t = await B(() => { const t = window.__booth.session.tracks[0]; return { takes: t.takes.map((k) => [k.name, +k.duration.toFixed(3), +k.at.toFixed(3)]), clips: t.clips.map((c) => [+c.start.toFixed(4), +c.end.toFixed(4), c.fadeIn, c.fadeOut, t.takes.findIndex((k) => k.id === c.takeId)]) }; });
ok("punch take in lane", t.takes.length === 2 && t.takes[1][0].includes("punch"), JSON.stringify(t.takes));
ok("take length = range + 2×10 ms", Math.abs(t.takes[1][1] - (punch.out - punch.in + 0.02)) < 0.003);
ok("clips: original | punch | original", t.clips.length === 3 && t.clips[1][4] === 1 && t.clips[0][4] === 0 && t.clips[2][4] === 0, JSON.stringify(t.clips));
ok("10 ms overlap crossfades", Math.abs(t.clips[0][1] - t.clips[1][0] - 0.01) < 1e-3 && Math.abs(t.clips[1][1] - t.clips[2][0] - 0.01) < 1e-3 && t.clips[0][3] === 0.01 && t.clips[1][2] === 0.01);
// Click check: rendered comp around each boundary vs the take's normal sample-to-sample movement.
const clickRatio = await B(async ({ in: pin, out: pout }) => {
  const { session, audio } = window.__booth;
  const mod = await import("/js/session.js");
  const r = mod.renderTrack(session.tracks[0], audio, 48000);
  const d = r.data, fs = 48000;
  const maxDiff = (a, b) => { let m = 0; for (let i = Math.max(1, a); i < b; i++) m = Math.max(m, Math.abs(d[i] - d[i - 1])); return m; };
  const typical = (() => { const v = []; for (let i = 1; i < d.length; i += 7) v.push(Math.abs(d[i] - d[i - 1])); v.sort((x, y) => x - y); return v[Math.floor(v.length * 0.999)]; })();
  const at = (t) => Math.round((t - r.offset) * fs);
  const rms = (a, b) => { let e = 0; for (let i = a; i < b; i++) e += d[i] * d[i]; return Math.sqrt(e / (b - a)).toFixed(3); };
  return [maxDiff(at(pin) - 480, at(pin) + 480) / typical, maxDiff(at(pout) - 480, at(pout) + 480) / typical];
}, punch);
ok("no clicks at boundaries", clickRatio.every((x) => x < 1.5), `edge jump vs 99.9th pct sample step: ${clickRatio.map((x) => x.toFixed(2))}`);
await p.keyboard.press("Control+z");
ok("undo punch", (await B(() => window.__booth.session.tracks[0].clips.length)) === 1);
await p.keyboard.press("Control+Shift+z");
await p.screenshot({ path: `${S}/punch.png` });
console.log("errors", errs);
await b.close();
