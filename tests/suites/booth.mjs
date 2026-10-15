// Booth fixes: Enter/Space never re-press a clicked button, headphone monitoring, sync test maths,
// track timing nudge, timeline scroll bar and back-to-start.
import { chromium } from "playwright-core";
const S = process.cwd();
const ok = (n, c, x = "") => console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`);

// Sync test analysis on synthetic claps 180 ms behind each click (±8 ms human jitter).
const { measureSync } = await import(new URL("../../js/metro.js", import.meta.url));
const fs = 48000, gap = 0.6, lead = 4, n = 12;
const make = (lat, jitter, skip = new Set()) => {
  const x = new Float32Array(Math.round((lead + n + 1) * gap * fs));
  let seed = 3; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
  for (let i = 0; i < x.length; i++) x[i] = 0.002 * rnd();
  for (let k = 0; k < lead + n; k++) {
    if (skip.has(k)) continue;
    const at = Math.round((k * gap + lat + jitter * rnd() * 2) * fs);
    for (let i = 0; i < 2400 && at + i < x.length; i++) x[at + i] += 0.6 * rnd() * Math.exp(-i / 300);
  }
  return x;
};
const r1 = measureSync(make(0.18, 0.008), fs, { gap, lead, n });
ok("sync test measures a 180 ms headset delay", !r1.error && Math.abs(r1.latency - 0.18) < 0.012, r1.error || `${Math.round(r1.latency * 1000)} ms, spread ±${Math.round(r1.spread * 500)} ms, ${r1.heard}/12 claps`);
const r2 = measureSync(make(0.32, 0.005), fs, { gap, lead, n });
ok("sync test handles Bluetooth-size delay (320 ms)", !r2.error && Math.abs(r2.latency - 0.32) < 0.012, r2.error || `${Math.round(r2.latency * 1000)} ms`);
const r3 = measureSync(make(0.18, 0.12), fs, { gap, lead, n });
ok("sync test rejects uneven claps", !!r3.error, r3.error || "accepted");
const r4 = measureSync(make(0.18, 0.005, new Set([5, 6, 7, 8, 9, 10, 11, 12])), fs, { gap, lead, n });
ok("sync test asks again when too few claps are heard", !!r4.error && r4.heard < 6, r4.error);

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${S}/vocal.wav`, "--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage({ viewport: { width: 1600, height: 960 } });
const errs = []; p.on("pageerror", (e) => errs.push(e.stack)); p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
const B = (fn, a) => p.evaluate(fn, a);
await p.goto(process.env.BASE_URL); await p.waitForTimeout(1200);
await p.setInputFiles("#fileBeat", `${S}/beat.wav`); await p.waitForFunction(() => window.__booth.session.beats.length === 1);
await p.setInputFiles("#fileVocal", `${S}/vocal.wav`); await p.waitForFunction(() => window.__booth.session.tracks.length === 1);

// Markers: one click, then Stop (Enter) three times.
await p.click("#btnMarker");
for (let i = 0; i < 3; i++) await p.keyboard.press("Enter");
ok("Enter after clicking + Marker doesn't add more markers", (await B(() => window.__booth.session.markers.length)) === 1, String(await B(() => window.__booth.session.markers.length)));
const snap0 = await B(() => window.__booth.session.settings.snap);
await p.click("#btnSnap"); await p.keyboard.press("Enter"); await p.keyboard.press("Space"); await p.waitForTimeout(150); await p.keyboard.press("Space");
ok("Enter/Space after clicking Snap don't toggle it again", (await B(() => window.__booth.session.settings.snap)) === !snap0);

// Monitoring.
await p.click("#btnMonitor"); await p.waitForTimeout(400);
const mon = await B(() => ({ chip: document.querySelector("#btnMonitor").classList.contains("on"), box: document.querySelector("#monitor").checked, live: !!window.__booth.mic.node, gain: window.__booth.mic.monitor.gain.value }));
ok("🎧 Monitor turns the mic on and routes it to the headphones", mon.chip && mon.box && mon.live && mon.gain > 0.9, JSON.stringify(mon));
await p.reload(); await p.waitForTimeout(1200);
await p.click("#btnMic"); await p.waitForTimeout(400);
ok("monitoring comes back on with the mic next time", await B(() => document.querySelector("#btnMonitor").classList.contains("on") && window.__booth.mic.monitor.gain.value > 0.9));
await p.click("#btnMonitor"); await p.waitForTimeout(200);
ok("…and switches off", await B(() => !document.querySelector("#btnMonitor").classList.contains("on") && window.__booth.mic.monitor.gain.value < 0.1));

// Track timing nudge.
const lane = await p.locator(".lane.vocal canvas").first().boundingBox();
await p.mouse.click(lane.x + 60, lane.y + lane.height / 2);
await p.waitForSelector("#clipInsp:not([hidden])");
const sh0 = await B(() => window.__booth.session.tracks[0].clips.map((c) => c.shift || 0));
await p.click("#nudgeEarly"); await p.click("#nudgeEarly"); await p.click("#nudgeEarly");
const sh1 = await B(() => window.__booth.session.tracks[0].clips.map((c) => c.shift || 0));
ok("Timing ◀ slides the track 30 ms earlier", sh1.every((v, i) => Math.abs(v - sh0[i] + 0.03) < 1e-9) && (await p.textContent("#trackTimingOut")) === "-30 ms", await p.textContent("#trackTimingOut"));
await p.keyboard.press("Control+z");
ok("one undo reverts the whole nudge", (await B(() => window.__booth.session.tracks[0].clips.map((c) => c.shift || 0))).every((v, i) => Math.abs(v - sh0[i]) < 1e-9));

// Scrolling.
await B(() => { window.__booth.ui.view.pps = 200; window.__booth.renderLanesOnly(); window.__booth.seek(10); });
const v1 = await B(() => window.__booth.ui.view.start);
ok("seeking off screen brings the playhead into view", v1 > 5, v1.toFixed(2));
await p.click("#btnToStart");
ok("⇤ Start returns to the beginning", await B(() => window.__booth.ui.view.start === 0 && window.__booth.ui.playhead === 0));
const th = await p.locator("#hthumb").boundingBox();
await p.mouse.move(th.x + th.width / 2, th.y + th.height / 2); await p.mouse.down(); await p.mouse.move(th.x + th.width / 2 + 300, th.y + th.height / 2, { steps: 5 }); await p.mouse.up();
const v2 = await B(() => window.__booth.ui.view.start);
ok("dragging the scroll bar scrolls the song", v2 > 1, v2.toFixed(2));
await p.screenshot({ path: `${S}/booth.png` });
ok("no page errors", errs.length === 0, errs.join("\n"));
await b.close();
