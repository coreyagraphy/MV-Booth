import { chromium } from "playwright-core";
const S = process.cwd();
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${S}/vocal.wav`, "--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage({ viewport: { width: 1600, height: 960 } });
const errs = []; p.on("pageerror", (e) => errs.push(e.stack)); p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
const B = (fn, a) => p.evaluate(fn, a);
const ok = (n, c, x = "") => console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`);
await p.goto(process.env.BASE_URL); await p.waitForTimeout(1200);
await p.setInputFiles("#fileBeat", `${S}/beat.wav`); await p.waitForFunction(() => window.__booth.session.beats.length);
await p.setInputFiles("#fileVocal", `${S}/vocal.wav`); await p.waitForFunction(() => window.__booth.session.tracks.length === 1);
// Space after clicking a toolbar button and after touching a slider
await p.click("#btnSnap"); await p.click("#btnSnap");
await p.keyboard.press("Space"); await p.waitForTimeout(500);
ok("Space plays after clicking a button", await B(() => !!window.__booth.ui.playing));
ok("…and didn't re-press the button", await B(() => window.__booth.session.settings.snap === true));
await p.keyboard.press("Space"); await p.waitForTimeout(200);
const paused = await B(() => window.__booth.ui.playhead);
await p.click('.tabs button[data-tab="mixer"]');
await p.locator("#balance").focus();
await p.keyboard.press("Space"); await p.waitForTimeout(400);
ok("Space picks up from pause (even with a slider focused)", await B(() => !!window.__booth.ui.playing) && Math.abs((await B(() => window.__booth.ui.playing.from)) - paused) < 0.01, paused.toFixed(2));
await p.keyboard.press("Space");
// Tools
const lane = await p.locator(".lane.vocal canvas").first().boundingBox();
const X = async (t) => { const v = await B(() => window.__booth.ui.view); return lane.x + (t - v.start) * v.pps; };
const y = lane.y + lane.height / 2;
await p.keyboard.press("3"); ok("key 3 = cut tool", (await p.getAttribute('#toolSeg button[data-tool="cut"]', "class")) === "on", await p.textContent("#hint"));
await p.mouse.click(await X(6.0), y);
const cl = await B(() => window.__booth.session.tracks[0].clips.map((c) => [+c.start.toFixed(3), +c.end.toFixed(3)]));
ok("cut tool splits where clicked (snapped)", cl.length === 2 && Math.abs(cl[0][1] - 6.0) < 0.1, JSON.stringify(cl));
await p.keyboard.press("2");
const end0 = cl[1][1];
await p.mouse.move(await X(11.5), y); await p.mouse.down(); await p.mouse.move(await X(10.0), y, { steps: 6 }); await p.mouse.up();
const end1 = await B(() => window.__booth.session.tracks[0].clips[1].end);
ok("trim tool shortens the end", end1 < end0 - 1, `${end0} → ${end1.toFixed(2)}`);
await p.keyboard.press("4");
await p.mouse.move(await X(0.2), y); await p.mouse.down(); await p.mouse.move(await X(1.0), y, { steps: 6 }); await p.mouse.up();
const fi = await B(() => window.__booth.session.tracks[0].clips[0].fadeIn);
ok("fade tool sets fade-in by dragging", fi > 0.6 && fi < 1.2, fi.toFixed(2));
await p.keyboard.press("1");
await p.keyboard.press("Control+z"); await p.keyboard.press("Control+z"); await p.keyboard.press("Control+z");
ok("undo all three edits", (await B(() => window.__booth.session.tracks[0].clips.length)) === 1);
// Hint line on hover
await p.hover('.strip input.fader >> nth=0'); await p.waitForTimeout(100);
ok("hint explains hovered control", (await p.textContent("#hint")).includes("volume"), await p.textContent("#hint"));
// Presets
await p.locator("#mixPresets button", { hasText: "Spacey" }).click();
ok("preset applies", await B(() => window.__booth.session.settings.reverb === "hall" && window.__booth.session.settings.delayDiv === "1/4"));
// Guide
await p.keyboard.press("?"); ok("guide opens", await p.isVisible("#guide"));
await p.screenshot({ path: `${S}/guide.png` });
await p.keyboard.press("Escape"); ok("guide closes", !(await p.isVisible("#guide")));
// Recording visibility
await p.locator(".lane.vocal .arm").first().click();
await p.click('.tabs button[data-tab="booth"]'); await p.click("#btnMic"); await p.waitForTimeout(500);
await p.selectOption("#countIn", "1");
await B(() => window.__booth.seek(13));
await p.keyboard.press("r"); await p.waitForTimeout(900);
ok("count-in banner", (await p.isVisible("#recBanner")) && (await p.textContent("#recText")) === "COUNT-IN", await p.textContent("#recSub"));
await p.waitForTimeout(4500);
ok("RECORDING banner while recording", (await p.textContent("#recText")).includes("RECORDING"), await p.textContent("#recSub"));
ok("live waveform data growing", (await B(() => document.querySelector("#recLvl").style.width)) !== "" );
await p.screenshot({ path: `${S}/recording.png` });
await p.keyboard.press("Space"); await p.waitForTimeout(600);
ok("Space stops recording, banner gone", !(await p.isVisible("#recBanner")) && (await B(() => window.__booth.session.tracks[0].takes.length)) === 2);
console.log("errors", errs);
await b.close();
