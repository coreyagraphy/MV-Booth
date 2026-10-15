import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const S = process.cwd();
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 960 } });
const p = await ctx.newPage();
p.on("dialog", (d) => d.accept());
const errs = []; p.on("pageerror", (e) => errs.push(e.stack)); p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errs.push(m.text()));
const B = (fn, a) => p.evaluate(fn, a);
const ok = (n, c, x = "") => console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`);
await p.goto(process.env.BASE_URL); await p.waitForTimeout(1200);
await p.setInputFiles("#fileBeat", [`${S}/Drums.wav`, `${S}/808.wav`, `${S}/Keys.wav`]);
await p.waitForFunction(() => window.__booth.session.beats.length === 3);
const beats = await B(() => window.__booth.session.beats.map((x) => `${x.name}:${x.kind}`));
ok("3 stems imported with roles guessed", beats.join() === "Drums:drums,808:bass,Keys:melody", beats.join());
ok("BPM detected from drums", Math.abs((await B(() => window.__booth.session.settings.bpm)) - 92) <= 1, String(await B(() => window.__booth.session.settings.bpm)));
ok("3 stem lanes", (await p.locator(".lane.beat.stem").count()) === 3);
await p.locator(".lane.beat >> nth=2").locator("select.kind").selectOption("fx");
ok("role change stored", await B(() => window.__booth.session.beats[2].kind) === "fx");
await p.keyboard.press("Control+z");
ok("role change undoable", await B(() => window.__booth.session.beats[2].kind) === "melody");
await p.setInputFiles("#fileVocal", `${S}/vocal.wav`); await p.waitForFunction(() => window.__booth.session.tracks.length === 1);
// mute 808 → excluded
await p.locator(".lane.beat >> nth=1").locator(".tog.m").click();
ok("mute dims the lane", (await p.locator(".lane.beat.muted").count()) === 1);
await p.click("#btnAutomix");
await p.waitForFunction(() => window.__booth.ui.master && !window.__booth.ui.stale && !document.body.classList.contains("busy"), null, { timeout: 180000 });
let rep = await p.innerText("#report");
ok("muted 808 left out of the mix", /Beat bus \(2 stems\)/.test(rep) && !/808\/Bass/.test(rep), rep.split("\n").filter((l) => /Beat|Drums|808|Melody/.test(l)).join(" | "));
await p.locator(".lane.beat >> nth=1").locator(".tog.m").click();
await p.click("#btnAutomix");
await p.waitForFunction(() => window.__booth.ui.master && !window.__booth.ui.stale && !document.body.classList.contains("busy"), null, { timeout: 180000 });
rep = await p.innerText("#report");
const lines = rep.split("\n").filter((l) => /Beat|Drums|808|Melody/.test(l));
ok("report treats each stem by role", /Beat bus \(3 stems\)/.test(rep) && /Drums "Drums": light carve, never ducked/.test(rep) && /808\/Bass "808": mono/.test(rep) && /Melody "Keys": carved \+ ducked/.test(rep), lines.join(" | "));
const st = await p.textContent("#status");
const tp = parseFloat(st.match(/true peak (-?[\d.]+)/)?.[1]);
ok("master on target", /-1[34]\.\d LUFS/.test(st) && tp <= -1.0, st);
// stem export
const files = [];
const saves = [];
p.on("download", (d) => { const path = `${S}/stem_${files.length}_${d.suggestedFilename()}`; files.push(path); saves.push(d.saveAs(path)); });
await B(() => window.__booth.exportAs("stems"));
for (let i = 0; i < 40 && files.length < 4; i++) await p.waitForTimeout(250);
await Promise.all(saves);
ok("stems export: vocal + 3 beat stems", files.length === 4, files.map((f) => f.split("_stem_")[1]).join(", "));
const f808 = files.find((f) => /808/.test(f));
ok("808 stem file present", !!f808);
if (f808) {
  const buf = readFileSync(f808); const n = (buf.length - 44) / 6; let d = 0, s = 0;
  // 24-bit stereo
  for (let i = 0; i < n; i += 7) { const L = buf.readIntLE(44 + i * 6, 3), R = buf.readIntLE(47 + i * 6, 3); d += (L - R) ** 2; s += (L + R) ** 2; }
  ok("808 stem folded to mono", d / s < 1e-4, `side/mid ${(d / s).toExponential(1)}`);
}
// solo drums
await p.locator(".lane.beat >> nth=0").locator(".tog.s").click();
const sol = await B(() => { const s = window.__booth.session; return s.beats.filter((x) => !x.mute && (x.solo)).length; });
ok("solo flag set", sol === 1);
await p.screenshot({ path: `${S}/stems.png` });
await p.locator(".lane.beat >> nth=0").locator(".tog.s").click();
// mixer strips
await p.click('.tabs button[data-tab="mixer"]');
const strips = await p.locator(".strip").count();
ok("mixer: strip per stem (vocal + 3 + master)", strips === 5, String(strips));
await p.screenshot({ path: `${S}/stems-mixer.png` });
// remove + undo
await p.locator(".lane.beat >> nth=2").locator(".tog.x").click();
ok("remove stem", await B(() => window.__booth.session.beats.length) === 2);
await p.keyboard.press("Control+z");
ok("undo restores it", await B(() => window.__booth.session.beats.length) === 3);
// persistence after reload
await p.waitForTimeout(800);
await p.reload(); await p.waitForTimeout(1500);
ok("stems persist after reload", await B(() => window.__booth.session.beats.map((x) => x.kind).join()) === "drums,bass,melody" && (await p.locator(".lane.beat.stem").count()) === 3);
ok("no page errors", errs.length === 0, errs.join("\n"));
await b.close();
