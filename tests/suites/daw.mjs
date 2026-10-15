import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const S = process.cwd();
const URL_ = process.argv[2] || process.env.BASE_URL;
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${S}/vocal.wav`, "--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 960 } });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push("pageerror " + e.stack));
p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push("console " + m.text()));
const B = (fn, arg) => p.evaluate(fn, arg);
const ok = (name, cond, extra = "") => console.log(`${cond ? "PASS" : "FAIL"} ${name} ${extra}`);
await p.goto(URL_); await p.waitForTimeout(1200);
ok("boot", await B(() => !!window.__booth), await p.textContent("#status"));
await p.setInputFiles("#fileBeat", `${S}/beat.wav`);
await p.waitForFunction(() => window.__booth.session.beats.length);
ok("beat + bpm", (await B(() => window.__booth.session.settings.bpm)) === 92);
// add Lead track, arm
await p.click("#btnAddTrack"); await p.click('#addMenu button[data-type="lead"]');
await p.locator(".lane.vocal .arm").first().click();
ok("arm", await B(() => window.__booth.session.tracks[0].armed));
// loop region via ruler drag: 0 → ~bar 3 (2 bars @92 = 5.22s)
const rb = await p.locator("#ruler").boundingBox();
const pps = await B(() => window.__booth.ui.view.pps);
await p.mouse.move(rb.x + 2, rb.y + 15); await p.mouse.down(); await p.mouse.move(rb.x + 5.3 * pps, rb.y + 15, { steps: 8 }); await p.mouse.up();
const loop = await B(() => window.__booth.session.loop);
ok("loop drag", loop.on && Math.abs(loop.end - 5.217) < 0.05, JSON.stringify(loop));
await p.selectOption("#countIn", "1");
await p.click("#btnMic"); await p.waitForTimeout(700);
await p.keyboard.press("c"); // click on
await p.keyboard.press("r");
await p.waitForTimeout(2900); // count-in 1 bar = 2.6s
ok("count-in shows negative/bar", true, await p.textContent("#clockSub"));
await p.waitForTimeout(11500); // ~2.2 passes
await p.keyboard.press("r");
await p.waitForTimeout(400);
const tk = await B(() => window.__booth.session.tracks[0].takes.map((k) => [k.name, k.duration.toFixed(2), k.at]));
ok("loop record → takes", tk.length >= 2, JSON.stringify(tk));
ok("one active clip", (await B(() => window.__booth.session.tracks[0].clips.length)) === 1);
// undo / redo
await p.keyboard.press("Control+z");
ok("undo record", (await B(() => window.__booth.session.tracks[0].takes.length)) === 0);
await p.keyboard.press("Control+Shift+z");
ok("redo record", (await B(() => window.__booth.session.tracks[0].takes.length)) === tk.length);
// loop off, play / pause / stop
await p.keyboard.press("l"); await p.keyboard.press("c");
await B(() => window.__booth.seek(1));
await p.keyboard.press("Space"); await p.waitForTimeout(1500); await p.keyboard.press("Space");
const ph = await B(() => window.__booth.ui.playhead);
ok("pause keeps position", ph > 2.2 && ph < 3.2, ph.toFixed(2));
await p.keyboard.press("Space"); await p.waitForTimeout(600); await p.keyboard.press("Enter");
ok("stop returns to start point", Math.abs((await B(() => window.__booth.ui.playhead)) - ph) < 0.05);
// split at 2.5 s, comp take 1 into right clip
await B(() => window.__booth.seek(2.5));
await p.locator(".lane.vocal .lane-head").first().click({ position: { x: 200, y: 100 } });
await p.keyboard.press("x");
const clips = await B(() => window.__booth.session.tracks[0].clips.map((c) => [c.start.toFixed(2), c.end.toFixed(2), c.takeId]));
ok("split", clips.length === 2, JSON.stringify(clips));
if (!(await B(() => window.__booth.session.tracks[0].showTakes))) await p.locator('.lane.vocal button[title^="Show take lanes"]').click();
const t1 = await B(() => window.__booth.session.tracks[0].takes[0].id);
await B(() => (window.__booth.ui.selClip = window.__booth.session.tracks[0].clips[1].id));
await p.locator(".lane.take").first().locator('button:has-text("Comp")').click();
ok("comp take 1 into clip 2", (await B(() => window.__booth.session.tracks[0].clips[1].takeId)) === t1);
// drag clip 2 right by ~1 beat with snap
const lane = await p.locator(".lane.vocal canvas").first().boundingBox();
const c2 = await B(() => window.__booth.session.tracks[0].clips[1]);
const pps2 = await B(() => window.__booth.ui.view.pps), vs = await B(() => window.__booth.ui.view.start);
const cx = lane.x + ((c2.start + c2.end) / 2 - vs) * pps2;
await p.mouse.move(cx, lane.y + 64); await p.mouse.down(); await p.mouse.move(cx + 0.66 * pps2, lane.y + 64, { steps: 6 }); await p.mouse.up();
const c2b = await B(() => window.__booth.session.tracks[0].clips.find((c) => c.takeId === window.__booth.session.tracks[0].takes[0].id));
ok("drag clip (snapped)", c2b && c2b.start > c2.start + 0.3, `${c2.start.toFixed(3)} → ${c2b?.start.toFixed(3)}`);
// mixer fader
await p.click('.tabs button[data-tab="mixer"]');
const fader = p.locator(".strip").first().locator("input.fader");
await fader.evaluate((el) => { el.value = -6; el.dispatchEvent(new Event("input")); });
ok("mixer fader", (await B(() => window.__booth.session.tracks[0].volumeDb)) === -6);
// lyrics with bar sync
await p.click('.tabs button[data-tab="lyrics"]');
await p.fill("#lyrics", "[bar 1] first line\n[bar 2] second line\n[bar 3] third line");
await B(() => window.__booth.seek(2.7)); // bar 2
await p.click("#btnPrompter"); await p.waitForTimeout(400);
ok("prompter bar sync", (await p.locator("#prompterText .pl.on").textContent()).includes("second"));
await p.keyboard.press("Escape");
// automix with Space stage off then on
await p.locator('.node[data-stage="space"]').click();
await p.click("#btnAutomix");
await p.waitForFunction(() => window.__booth.ui.master && !window.__booth.ui.stale && !document.body.classList.contains("busy"), null, { timeout: 180000 });
const notes1 = await p.innerText("#report");
ok("space stage off honoured", notes1.includes("Space stage off"));
await p.locator('.node[data-stage="space"]').click();
await p.click("#btnAutomix");
await p.waitForFunction(() => !window.__booth.ui.stale && !document.body.classList.contains("busy"), null, { timeout: 180000 });
const st = await p.textContent("#status");
const tp = parseFloat(st.match(/true peak (-?[\d.]+)/)?.[1]);
ok("automix master", /-1[34]\.\d LUFS/.test(st) && tp <= -1.0, st);
ok("stage states", (await p.locator(".node.done").count()) >= 6, String(await p.locator(".node.done").count()));
await p.screenshot({ path: `${S}/daw-mix.png` });
// exports
const dl = async (kind) => { const [d] = await Promise.all([p.waitForEvent("download", { timeout: 60000 }), B((k) => window.__booth.exportAs(k), kind)]); const path = `${S}/out_${kind}_${d.suggestedFilename()}`; await d.saveAs(path); return path; };
const wav = await dl("wav"); const w = readFileSync(wav);
ok("WAV 48k/24", w.readUInt32LE(24) === 48000 && w.readUInt16LE(34) === 24, `${(w.length / 1e6).toFixed(1)} MB`);
const mp3 = await dl("mp3"); const m = readFileSync(mp3);
ok("MP3", m.length > 50000 && m[0] === 0xff && (m[1] & 0xe0) === 0xe0, `${(m.length / 1e3).toFixed(0)} KB`);
// sessions
await p.click("#btnSession");
p.once("dialog", (d) => d.accept("Session B"));
await p.locator('#sessionMenu button:has-text("New session")').click();
await p.waitForTimeout(700);
ok("new session empty", (await B(() => window.__booth.session.tracks.length)) === 0 && (await p.textContent("#sessionName")) === "Session B");
await p.click("#btnSession"); await p.waitForTimeout(300);
await p.locator('#sessionMenu button:has-text("Session 1")').click(); await p.waitForTimeout(1000);
ok("switch back", (await B(() => window.__booth.session.tracks[0]?.takes.length)) === tk.length);
await p.reload(); await p.waitForTimeout(2000);
ok("persist after reload", (await B(() => [window.__booth.session.name, window.__booth.session.tracks[0]?.clips.length, window.__booth.session.markers.length, window.__booth.session.lyrics.length])).join() !== "", JSON.stringify(await B(() => [window.__booth.session.name, window.__booth.session.tracks[0]?.clips.length, window.__booth.session.tracks[0]?.volumeDb])));
await p.screenshot({ path: `${S}/daw-reload.png` });
console.log("errors", errs);
await b.close();
