import { CLEAN_DEFAULTS, FX, MODES, ROLES, DELAYS, REVERBS, estimateBpm, makeImpulse, renderVocal } from "./automix.js";
import { STAGES, renderStem, runEngine } from "./engine.js";
import { Metronome, TapTempo, barBeat, barSeconds, measureSync, snapTime } from "./metro.js";
import { encodeMp3 } from "./mp3.js";
import { packSession, unpackSession, usedAudioIds } from "./package.js";
import * as S from "./session.js";
import * as store from "./store.js";
import { NOTE_NAMES, SCALES, keyLabel } from "./tune.js";
import { download, encodeWav } from "./wav.js";

const $ = (id) => document.getElementById(id);
const ctx = new AudioContext({ latencyHint: "interactive" });
const FS = ctx.sampleRate;
const dbToLin = (db) => Math.pow(10, db / 20);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let session = S.newSession();
const audio = new Map(); // takeId / beatId → AudioBuffer (immutable)
const peaksCache = new Map();
const history = new S.History();
const metro = new Metronome(ctx);
const tapper = new TapTempo();

const ui = {
  ab: "A", selTrack: null, selClip: null, playhead: 0, playStart: 0,
  playing: null, recording: null, busy: false, job: null, run: null, stale: false,
  key: null, profile: null, view: { start: 0, pps: 30, fit: true }, lyricLine: 0, cancel: null,
  stageState: {},
};
const S_ = () => session.settings;

// ---------------------------------------------------------------- output graph
const masterGain = ctx.createGain();
const limiter = ctx.createDynamicsCompressor();
limiter.threshold.value = -1;
limiter.knee.value = 0;
limiter.ratio.value = 20;
limiter.attack.value = 0.001;
limiter.release.value = 0.1;
const out = ctx.createGain();
const rawBus = ctx.createGain();
const mixBus = ctx.createGain();
rawBus.connect(masterGain);
mixBus.connect(masterGain);
masterGain.connect(limiter).connect(out).connect(ctx.destination);
const analyser = ctx.createAnalyser();
analyser.fftSize = 4096;
analyser.smoothingTimeConstant = 0.78;
out.connect(analyser);
const split = ctx.createChannelSplitter(2);
const anL = ctx.createAnalyser();
const anR = ctx.createAnalyser();
anL.fftSize = anR.fftSize = 1024;
out.connect(split);
split.connect(anL, 0);
split.connect(anR, 1);
// Short-term loudness (approx): K-weighting-ish filters → analyser.
const kShelf = ctx.createBiquadFilter();
kShelf.type = "highshelf";
kShelf.frequency.value = 1500;
kShelf.gain.value = 4;
const kHp = ctx.createBiquadFilter();
kHp.type = "highpass";
kHp.frequency.value = 60;
const kAn = ctx.createAnalyser();
kAn.fftSize = 2048;
out.connect(kShelf).connect(kHp).connect(kAn);

// ---------------------------------------------------------------- helpers
const fmtTime = (s) => {
  const neg = s < 0;
  s = Math.abs(s);
  const m = Math.floor(s / 60);
  return `${neg ? "-" : ""}${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const safe = (s) => s.replace(/[^\w-]+/g, "_");
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3400);
}
const status = (msg) => ($("status").textContent = msg);
const bpm = () => S_().bpm || 0;
const trackById = (id) => session.tracks.find((t) => t.id === id);
const takeOf = (track, id) => track.takes.find((k) => k.id === id);
const anySolo = () => session.tracks.some((t) => t.solo) || session.beats.some((b) => b.solo);
const audible = (t) => !t.mute && (!anySolo() || t.solo);
function projectEnd() {
  const ends = session.tracks.map(S.trackEnd);
  for (const b of session.beats) if (audio.get(b.id)) ends.push((b.offset || 0) + audio.get(b.id).duration);
  if (ui.master) ends.push(ui.master.duration - 2);
  return Math.max(0, ...ends);
}
function moveThumb(seg) {
  const on = seg.querySelector("button.on");
  const th = seg.querySelector(".thumb");
  if (!on || !th) return;
  th.style.left = `${on.offsetLeft}px`;
  th.style.width = `${on.offsetWidth}px`;
}
function setSeg(id, attr, value) {
  const seg = $(id);
  seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset[attr] === value));
  moveThumb(seg);
}
async function resample(buf, rate = FS) {
  if (buf.sampleRate === rate) return buf;
  const oc = new OfflineAudioContext(buf.numberOfChannels, Math.ceil(buf.duration * rate), rate);
  const s = oc.createBufferSource();
  s.buffer = buf;
  s.connect(oc.destination);
  s.start();
  return oc.startRendering();
}
async function toMono(buffer) {
  const buf = await resample(buffer);
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
  }
  const b = ctx.createBuffer(1, mono.length, FS);
  b.copyToChannel(mono, 0);
  return b;
}

// ---------------------------------------------------------------- persistence + undo
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 600);
}
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  return S.saveSession(session).catch((err) => toast(`Couldn't save the session: ${err.message}`));
}
// Closing the window (or the app auto-exiting) must not drop the last 600 ms of edits.
addEventListener("pagehide", () => saveTimer && flushSave());
document.addEventListener("visibilitychange", () => document.hidden && saveTimer && flushSave());
const saveAudio = (id, buffer) =>
  store
    .set(`audio:${id}`, { sampleRate: buffer.sampleRate, channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice()) })
    .catch((err) => toast(`Couldn't store audio (is the disk full?): ${err.message}. Export what you need before closing.`));
async function loadAudio(id) {
  if (audio.has(id)) return audio.get(id);
  const rec = await store.get(`audio:${id}`);
  if (!rec) return null;
  const b = new AudioBuffer({ numberOfChannels: rec.channels.length, length: rec.channels[0].length, sampleRate: rec.sampleRate });
  rec.channels.forEach((d, c) => b.copyToChannel(d, c));
  const r = await resample(b);
  audio.set(id, r);
  return r;
}

/**
 * Every user change goes through here: snapshot for undo, apply, save, redraw.
 * `key` coalesces slider drags into one undo step; `audioChange` marks the mix stale.
 */
function edit(label, fn, { key = null, audioChange = true, redraw = true } = {}) {
  history.push(session, label, key);
  fn();
  if (audioChange) markStale();
  save();
  if (redraw) renderAll();
  updateUndo();
}
function applyHistory(r, verb) {
  if (!r) return toast(`Nothing to ${verb}.`);
  stopPlayback();
  session = r.session;
  markStale();
  save();
  bindSettingsToUi();
  renderAll();
  updateUndo();
  toast(`${verb === "undo" ? "Undid" : "Redid"}: ${r.label}`);
}
// Undo, redo and session switches swap the whole session object, so they wait for anything
// that is writing into it: a recording, Automix, or a clean / studio-tune job.
const busyWith = () => (ui.recording ? "the recording" : ui.busy ? "Automix" : ui.job || null);
function guardBusy(what) {
  const b = busyWith();
  if (b) toast(`Wait for ${b} to finish before ${what}.`);
  return !!b;
}
const undo = () => guardBusy("undoing") || applyHistory(history.undo(session), "undo");
const redo = () => guardBusy("redoing") || applyHistory(history.redo(session), "redo");
function updateUndo() {
  $("btnUndo").disabled = !history.undoStack.length;
  $("btnRedo").disabled = !history.redoStack.length;
  $("btnUndo").title = history.undoStack.length ? `Undo ${history.undoStack.at(-1).label} (Ctrl+Z)` : "Undo (Ctrl+Z)";
}
function markStale() {
  if (ui.master && !ui.stale) {
    ui.stale = true;
    renderReport();
  }
}

// ---------------------------------------------------------------- mic + recorder
const RECORDER = `
class BoothRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.at = -1; this.until = Infinity; this.on = false; this.peak = 0; this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data.cmd === "start") { this.at = Math.round(e.data.at * sampleRate); this.until = e.data.until ? Math.round(e.data.until * sampleRate) : Infinity; this.on = true; }
      if (e.data.cmd === "stop") { this.on = false; this.port.postMessage({ type: "done" }); }
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > this.peak) this.peak = a; }
    if (++this.n >= 6) { this.port.postMessage({ type: "meter", peak: this.peak }); this.peak = 0; this.n = 0; }
    if (this.on && currentFrame + ch.length > this.at && currentFrame < this.until) {
      const off = Math.max(0, this.at - currentFrame);
      const end = Math.min(ch.length, this.until - currentFrame);
      if (end > off) this.port.postMessage({ type: "chunk", data: ch.slice(off, end) });
    }
    return true;
  }
}
registerProcessor("booth-recorder", BoothRecorder);`;

const mic = { stream: null, source: null, node: null, gain: ctx.createGain(), monitor: ctx.createGain(), chunks: [], onDone: null, peak: 0, clipUntil: 0 };
mic.monitor.gain.value = 0;
mic.gain.connect(mic.monitor).connect(ctx.destination);
let workletReady = null;

async function ensureMic() {
  if (mic.node) return true;
  try {
    await ctx.resume();
    const deviceId = $("micSelect").value;
    mic.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    workletReady ??= ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([RECORDER], { type: "application/javascript" })));
    await workletReady;
    mic.source = ctx.createMediaStreamSource(mic.stream);
    mic.node = new AudioWorkletNode(ctx, "booth-recorder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    mic.gain.gain.value = S_().inputGainDb <= -60 ? 0 : dbToLin(S_().inputGainDb);
    mic.source.connect(mic.gain);
    mic.gain.connect(mic.node).connect(sink).connect(ctx.destination);
    mic.node.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === "chunk") {
        mic.chunks.push(d.data);
        addRecPeaks(d.data);
      }
      else if (d.type === "meter") {
        mic.peak = d.peak;
        if (d.peak >= 0.98) mic.clipUntil = performance.now() + 2000;
      } else if (d.type === "done") mic.onDone?.();
    };
    $("btnMic").textContent = "Mic live";
    $("btnMic").classList.add("live");
    // Monitoring comes back on if you left it on (it is what lets you hear yourself in the headset).
    try {
      if (localStorage.getItem("mvb.monitor") === "1") setMonitor(true);
    } catch {
      /* storage blocked */
    }
    const label = mic.stream.getAudioTracks()[0]?.label || "";
    if (/hands-?free|bluetooth|airpods|buds|\bbt\b/i.test(label))
      toast(`"${label}" looks like a Bluetooth headset: it adds 150–300 ms delay and drops to phone quality while its mic is on. A wired headset or USB mic records far better. Run the Sync test either way.`);
    const devId = mic.stream.getAudioTracks()[0]?.getSettings?.().deviceId;
    try {
      const saved = localStorage.getItem(`mvb.latency.${devId}`);
      if (saved != null) {
        S_().latencyMs = +saved;
        $("latency").value = saved;
        $("latencyOut").textContent = `${saved} ms`;
      }
    } catch {
      /* storage blocked */
    }
    await listDevices();
    updateRoundTrip();
    startMeters();
    return true;
  } catch (err) {
    console.error(err);
    toast(`Mic unavailable: ${err.message}`);
    return false;
  }
}
async function switchMic() {
  if (!mic.node) return;
  mic.stream.getTracks().forEach((t) => t.stop());
  mic.source.disconnect();
  mic.node.disconnect();
  mic.node = null;
  await ensureMic();
}
async function listDevices() {
  const sel = $("micSelect");
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  const cur = sel.value;
  sel.innerHTML = '<option value="">Default input</option>';
  for (const d of devices) if (d.deviceId && d.deviceId !== "default") sel.add(new Option(d.label || `Input ${sel.length}`, d.deviceId));
  sel.value = cur;
}
const autoLatency = () => (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + (mic.stream?.getAudioTracks()[0]?.getSettings?.().latency || 0);
const latencySeconds = () => autoLatency() + S_().latencyMs / 1000;
function updateRoundTrip() {
  const ms = Math.round(latencySeconds() * 1000);
  $("rtOut").textContent = `Round trip: ${ms} ms${ms > 25 ? " · monitor may feel late" : ""}`;
}

// ---------------------------------------------------------------- monitoring
function setMonitor(on) {
  mic.monitor.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.01);
  $("monitor").checked = on;
  $("btnMonitor").classList.toggle("on", on);
}
async function toggleMonitor(on) {
  if (on && !(await ensureMic())) return setMonitor(false);
  setMonitor(on);
  try {
    localStorage.setItem("mvb.monitor", on ? "1" : "0");
  } catch {
    /* storage blocked */
  }
  if (!on) return status("Monitoring off.");
  // Monitoring through the browser always takes the full round trip (mic → system → browser → headphones).
  // Over ~25 ms it is heard as an echo, so say how late it is here and what removes it.
  const ms = Math.max(0, Math.round(latencySeconds() * 1000));
  if (ms > 25) {
    toast(`Monitor is ${ms} ms late on this setup, so you'll hear an echo. For zero delay, turn Monitor off and use your headset's sidetone or your interface's direct monitoring.`);
    status(`Monitoring on · ${ms} ms behind your voice (a browser can't do less on this setup). Zero-delay options: headset sidetone (headset app or Windows mic Properties → Levels) or an interface's direct-monitor knob. Make sure Windows "Listen to this device" is off, or you'll hear yourself twice.`);
  } else status("Monitoring on: you hear your mic in the headphones. Headphones only (speakers will feed back).");
}

/** Store a measured round trip as this mic's latency trim (the browser's own report + trim = measured). */
function applyLatency(measured, how) {
  const trim = clamp(Math.round((measured - autoLatency()) * 1000), -200, 600);
  edit("Calibrate latency", () => (S_().latencyMs = trim), { audioChange: false, redraw: false });
  $("latency").value = trim;
  $("latencyOut").textContent = `${trim > 0 ? "+" : ""}${trim} ms`;
  try {
    const devId = mic.stream.getAudioTracks()[0]?.getSettings?.().deviceId;
    localStorage.setItem(`mvb.latency.${devId}`, String(trim));
  } catch {
    /* storage blocked */
  }
  updateRoundTrip();
  status(`${how}: your setup is ${Math.round(measured * 1000)} ms behind → trim ${trim > 0 ? "+" : ""}${trim} ms, saved for this mic. New takes now land on the beat. Fix old takes with Timing ◀ ▶ (select a clip).`);
}

/**
 * Sync test for headsets (the mic can't hear the headphones, so a loopback test can't work):
 * 4 lead-in clicks + 12 measured ones; the artist claps or says "ta" on each. The median offset is
 * how late a take sung "on the beat" really arrives, which is exactly what has to be compensated.
 */
async function syncTest() {
  if (!(await ensureMic())) return;
  stopPlayback();
  const gap = 0.6, lead = 4, n = 12;
  status("Sync test: clap or say “ta” right on every click. 4 clicks to get the feel, then 12 measured…");
  toast("Clap (or say “ta”) on every click");
  mic.chunks = [];
  const t0 = ctx.currentTime + 0.5;
  mic.node.port.postMessage({ cmd: "start", at: t0 });
  const lvl = metro.out.gain.value;
  metro.level = 1;
  for (let k = 0; k < lead + n; k++) metro.click(t0 + k * gap, k % 4 === 0);
  await new Promise((r) => setTimeout(r, (0.5 + (lead + n) * gap + 0.6) * 1000));
  await new Promise((resolve) => {
    mic.onDone = resolve;
    mic.node.port.postMessage({ cmd: "stop" });
  });
  metro.level = lvl;
  const data = new Float32Array(mic.chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of mic.chunks) {
    data.set(c, o);
    o += c.length;
  }
  mic.chunks = [];
  const r = measureSync(data, FS, { gap, lead, n });
  if (r.error) return status(`Sync test: ${r.error}`);
  applyLatency(r.latency, "Sync test");
}

async function calibrate() {
  if (!(await ensureMic())) return;
  stopPlayback();
  status("Calibrating… keep quiet.");
  mic.chunks = [];
  const t0 = ctx.currentTime + 0.3;
  const gap = 0.5;
  mic.node.port.postMessage({ cmd: "start", at: t0 });
  const lvl = metro.out.gain.value;
  metro.level = 1;
  for (let k = 0; k < 4; k++) metro.click(t0 + k * gap, true);
  await new Promise((r) => setTimeout(r, (0.3 + 4 * gap + 0.4) * 1000));
  await new Promise((resolve) => {
    mic.onDone = resolve;
    mic.node.port.postMessage({ cmd: "stop" });
  });
  metro.level = lvl;
  const total = mic.chunks.reduce((a, c) => a + c.length, 0);
  const data = new Float32Array(total);
  let o = 0;
  for (const c of mic.chunks) {
    data.set(c, o);
    o += c.length;
  }
  mic.chunks = [];
  const offs = [];
  for (let k = 0; k < 4; k++) {
    const a = Math.round(k * gap * FS);
    const b = Math.min(data.length, a + Math.round(0.45 * FS));
    let mx = 0;
    for (let i = a; i < b; i++) mx = Math.max(mx, Math.abs(data[i]));
    if (mx < 0.01) continue;
    for (let i = a; i < b; i++) {
      if (Math.abs(data[i]) > mx * 0.3) {
        offs.push((i - a) / FS);
        break;
      }
    }
  }
  if (offs.length < 2) {
    status("Calibration failed: no clicks heard. Turn up your speakers or hold your headphones to the mic.");
    return;
  }
  offs.sort((x, y) => x - y);
  applyLatency(offs[Math.floor(offs.length / 2)], "Loopback test");
}

// ---------------------------------------------------------------- transcription
let recog = null;
let transcript = "";
function startTranscription() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  transcript = "";
  if (!SR || !S_().transcribe) return;
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = false;
  recog.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) transcript += `${e.results[i][0].transcript.trim()}\n`;
  };
  recog.onend = () => ui.recording && recog?.start();
  try {
    recog.start();
  } catch {
    recog = null;
  }
}
function stopTranscription() {
  const r = recog;
  recog = null;
  r?.stop();
  return transcript.trim();
}

// ---------------------------------------------------------------- live mixer graph
let live = null; // per-playback nodes
function buildLive() {
  const verb = ctx.createConvolver();
  const rv = S_().reverb !== "auto" ? REVERBS[S_().reverb] : MODES[session.mode].reverb;
  verb.buffer = makeImpulse(ctx, rv.seconds, session.mode);
  const verbIn = ctx.createGain();
  verbIn.connect(verb).connect(rawBus);
  const dly = ctx.createDelay(2);
  const div = S_().delayDiv === "off" ? 0 : S_().delayDiv !== "auto" ? DELAYS[S_().delayDiv] : MODES[session.mode].delay?.division || 0;
  dly.delayTime.value = bpm() && div ? clamp((60 / bpm()) * div, 0.05, 1.9) : 0.3;
  const fb = ctx.createGain();
  fb.gain.value = 0.25;
  const dlp = ctx.createBiquadFilter();
  dlp.type = "lowpass";
  dlp.frequency.value = 4200;
  const dlyIn = ctx.createGain();
  dlyIn.gain.value = div && bpm() ? 1 : 0;
  dlyIn.connect(dly).connect(dlp).connect(fb).connect(dly);
  dlp.connect(rawBus);
  const tracks = new Map();
  for (const t of session.tracks) {
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    const m = ctx.createAnalyser();
    m.fftSize = 512;
    const rs = ctx.createGain();
    const ds = ctx.createGain();
    g.connect(p).connect(m);
    p.connect(rawBus);
    p.connect(rs).connect(verbIn);
    p.connect(ds).connect(dlyIn);
    tracks.set(t.id, { g, p, m, rs, ds });
  }
  const beats = new Map();
  for (const b of session.beats) {
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    const m = ctx.createAnalyser();
    m.fftSize = 512;
    g.connect(p).connect(m);
    p.connect(rawBus);
    beats.set(b.id, { g, p, m });
  }
  live = { verb, dly, tracks, beats, nodes: [verb, verbIn, dly, fb, dlp, dlyIn] };
  applyMixer();
}
function applyMixer() {
  if (!live) return;
  const sp = S_().space ?? 1;
  for (const t of session.tracks) {
    const n = live.tracks.get(t.id);
    if (!n) continue;
    const on = audible(t) && !(ui.recording && t.armed && !ui.recording.punch);
    n.g.gain.setTargetAtTime(on ? dbToLin(t.volumeDb) : 0, ctx.currentTime, 0.01);
    n.p.pan.setTargetAtTime(t.pan || 0, ctx.currentTime, 0.01);
    n.rs.gain.value = dbToLin(-20) * (t.revSend ?? 1) * sp;
    n.ds.gain.value = dbToLin(-24) * (t.dlySend ?? 1) * sp;
  }
  for (const b of session.beats) {
    const n = live.beats.get(b.id);
    if (!n) continue;
    n.g.gain.setTargetAtTime(audible(b) ? dbToLin(b.volumeDb || 0) : 0, ctx.currentTime, 0.01);
    n.p.pan.setTargetAtTime(b.kind === "bass" ? 0 : b.pan || 0, ctx.currentTime, 0.01);
  }
  masterGain.gain.setTargetAtTime(dbToLin(session.master.volumeDb || 0), ctx.currentTime, 0.01);
}
function teardownLive() {
  if (!live) return;
  for (const n of [...live.nodes, ...[...live.tracks.values()].flatMap((x) => [x.g, x.p, x.m, x.rs, x.ds]), ...[...live.beats.values()].flatMap((x) => [x.g, x.p, x.m])]) n.disconnect();
  live = null;
}

// ---------------------------------------------------------------- transport
const isLoop = () => session.loop.on && session.loop.end - session.loop.start > 0.25;

/** Schedule timeline segment [a, b) to sound at audio time T. */
function scheduleSegment(a, b, T, sources, { cue }) {
  const stopAt = T + (b - a);
  const add = (buf, bufStartTime, dest, gainNode) => {
    const s0 = Math.max(a, bufStartTime);
    const e0 = Math.min(b, bufStartTime + buf.duration);
    if (e0 - s0 <= 0.002) return null;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(gainNode || dest);
    s.start(T + (s0 - a), s0 - bufStartTime, e0 - s0);
    s.stop(stopAt + 0.01);
    sources.push(s);
    return { s0, e0 };
  };
  const useMix = !cue && ui.ab === "B" && ui.master && !ui.stale;
  if (useMix) {
    add(ui.master, 0, mixBus);
    return;
  }
  for (const b of session.beats) {
    const n = live.beats.get(b.id);
    if (n && audio.get(b.id)) add(audio.get(b.id), b.offset || 0, n.g);
  }
  for (const t of session.tracks) {
    const n = live.tracks.get(t.id);
    if (!n) continue;
    for (const c of t.clips) {
      const take = takeOf(t, c.takeId);
      const buf = audio.get(c.takeId);
      if (!take || !buf) continue;
      const s0 = Math.max(a, c.start);
      const e0 = Math.min(b, c.end);
      if (e0 - s0 <= 0.002) continue;
      const cg = ctx.createGain();
      cg.connect(n.g);
      const g = dbToLin(c.gainDb || 0);
      const tS = T + (s0 - a);
      const tE = T + (e0 - a);
      const fi = Math.max(0.003, c.fadeIn || 0);
      const fo = Math.max(0.003, c.fadeOut || 0);
      // Fade envelope relative to the clip's own edges.
      const env = (t0) => {
        let w = g;
        if (t0 - c.start < fi) w *= Math.max(0, (t0 - c.start) / fi);
        if (c.end - t0 < fo) w *= Math.max(0, (c.end - t0) / fo);
        return w;
      };
      cg.gain.setValueAtTime(env(s0), tS);
      if (c.start + fi > s0 && c.start + fi < e0) cg.gain.linearRampToValueAtTime(g, T + (c.start + fi - a));
      if (c.end - fo > s0 && c.end - fo < e0) cg.gain.setValueAtTime(g, T + (c.end - fo - a));
      cg.gain.linearRampToValueAtTime(env(e0), tE);
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(cg);
      // Source time for timeline s0. Negative = the take starts later than the clip (a take comped
      // into an earlier section): wait that long instead of playing its first sample early.
      const srcOff = s0 - (c.shift || 0) - take.at;
      const wait = Math.max(0, -srcOff);
      const len = Math.min(e0 - s0 - wait, buf.duration - Math.max(0, srcOff));
      if (len <= 0.002) continue;
      s.start(tS + wait, Math.max(0, srcOff), len);
      sources.push(s);
    }
  }
}

async function startPlayback(from = ui.playhead, { cue = false, countIn = 0 } = {}) {
  await ctx.resume();
  stopPlayback(false);
  buildLive();
  const sources = [];
  const pre = countIn ? countIn * barSeconds(bpm()) : 0;
  const t0 = ctx.currentTime + 0.08 + pre;
  const loop = isLoop() && !ui.recording?.punch ? { ...session.loop, L: session.loop.end - session.loop.start } : null;
  if (loop) from = loop.start;
  rawBus.gain.value = 1;
  mixBus.gain.value = 1;
  ui.playing = { t0, from, loop, sources, cue, nextPass: null, clickHorizon: from };
  ui.playStart = from;
  if (pre && bpm()) metro.schedule(bpm(), from - pre, from, from, t0);
  if (loop) {
    schedulePass(t0);
  } else {
    scheduleSegment(from, Math.max(from + 0.1, projectEnd() + 1), t0, sources, { cue });
  }
  document.body.classList.add("playing");
  requestAnimationFrame(frame);
  startMeters();
  return t0;
}
function schedulePass(T) {
  const p = ui.playing;
  scheduleSegment(p.loop.start, p.loop.end, T, p.sources, { cue: p.cue });
  if (S_().click) metro.schedule(bpm(), p.loop.start, p.loop.end, p.loop.start, T);
  p.nextPass = T + p.loop.L;
}
function stopPlayback(keep = true) {
  metro.stop();
  if (!ui.playing) return;
  if (keep) ui.playhead = currentPos();
  for (const s of ui.playing.sources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  ui.playing = null;
  teardownLive();
  document.body.classList.remove("playing");
}
function currentPos() {
  const p = ui.playing;
  if (!p) return ui.playhead;
  const el = ctx.currentTime - p.t0;
  if (el < 0) return p.from + el; // count-in
  if (p.loop) return p.loop.start + (el % p.loop.L);
  return p.from + el;
}
const pause = () => {
  if (ui.recording) return finishRecording();
  stopPlayback(true);
  drawPlayhead();
};
function stop() {
  if (ui.recording) return finishRecording();
  stopPlayback(false);
  ui.playhead = ui.playStart;
  drawPlayhead();
}
function returnToZero() {
  const was = ui.playing && !ui.recording;
  stopPlayback(false);
  ui.playhead = 0;
  ui.view.start = 0;
  renderLanesOnly();
  if (was) startPlayback(0);
}
function seek(t) {
  if (ui.recording) return;
  const was = !!ui.playing;
  stopPlayback(false);
  ui.playhead = Math.max(0, t);
  // Bring the playhead into view if it jumped off screen.
  const vis = viewWidth() / ui.view.pps;
  if (ui.playhead < ui.view.start || ui.playhead > ui.view.start + vis) scrollViewTo(ui.playhead - vis * 0.1);
  drawPlayhead();
  if (was) startPlayback(ui.playhead);
}
function nudge(dir, bar) {
  const step = bpm() ? (bar ? barSeconds(bpm()) : 60 / bpm()) : bar ? 5 : 1;
  seek(Math.max(0, (bpm() ? snapTime(currentPos(), bpm(), 1) : currentPos()) + dir * step));
}
function setAB(ab) {
  if (ab === "B" && (!ui.master || ui.stale)) return toast(ui.master ? "The mix is out of date. Run Automix again." : "Run Automix first to hear the engine's mix.");
  ui.ab = ab;
  setSeg("abSeg", "ab", ab);
  if (ui.playing && !ui.recording) startPlayback(currentPos());
  renderLanesOnly();
}

let lastPitchDraw = 0;
function frame() {
  const p = ui.playing;
  const pos = currentPos();
  if (p) {
    if (p.loop && ctx.currentTime > p.nextPass - 0.4) schedulePass(p.nextPass);
    if (!p.loop && S_().click && pos > p.clickHorizon - 1) {
      const from = Math.max(p.clickHorizon, pos);
      metro.schedule(bpm(), from, from + 2, p.from, p.t0);
      p.clickHorizon = from + 2;
    }
    if (ui.recording?.punch && !ui.recording.finishing && pos >= ui.recording.stopAt) {
      ui.recording.finishing = true;
      finishRecording();
    }
    if (!p.loop && !ui.recording && pos > projectEnd() + 0.5) {
      stopPlayback(false);
      ui.playhead = ui.playStart;
    }
    // Follow the playhead.
    const vw = viewWidth() / ui.view.pps;
    if (pos > ui.view.start + vw * 0.92 || pos < ui.view.start) {
      ui.view.start = Math.max(0, pos - vw * 0.1);
      ui.view.fit = false;
      renderLanesOnly();
    }
  }
  drawPlayhead(pos);
  updateRecView(pos);
  if (ui.recording || !$("prompter").hidden) prompterTick(pos);
  const now = performance.now();
  if (now - lastPitchDraw > 150 && document.querySelector('.tab.on[data-panel="tune"]')) {
    lastPitchDraw = now;
    drawPitch();
  }
  if (ui.playing) requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- meters
let meterLoop = false;
const spec = new Float32Array(analyser.frequencyBinCount);
const tbuf = new Float32Array(2048);
const kHist = [];
function peakOf(an) {
  const n = an.fftSize;
  const b = tbuf.subarray(0, n);
  an.getFloatTimeDomainData(b);
  let p = 0;
  for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(b[i]));
  return p;
}
const pct = (lin) => `${Math.max(0, Math.min(100, ((20 * Math.log10(lin + 1e-9) + 60) / 60) * 100))}%`;
function startMeters() {
  if (meterLoop) return;
  meterLoop = true;
  const c = $("spectrum");
  const g = c.getContext("2d");
  const draw = () => {
    const w = c.clientWidth, h = c.clientHeight, dpr = devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    analyser.getFloatFrequencyData(spec);
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#12e0d0");
    grad.addColorStop(0.6, "#ffb35c");
    grad.addColorStop(1, "#ff7a1a");
    g.beginPath();
    g.moveTo(0, h);
    for (let b = 0; b <= 96; b++) {
      const f = 30 * Math.pow(18000 / 30, b / 96);
      const i = Math.min(spec.length - 1, Math.round((f / (FS / 2)) * spec.length));
      const db = Number.isFinite(spec[i]) ? spec[i] : -120;
      g.lineTo((b / 96) * w, h - Math.max(0, Math.min(1, (db + 100) / 80)) * h);
    }
    g.lineTo(w, h);
    g.closePath();
    g.globalAlpha = 0.22;
    g.fillStyle = grad;
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = grad;
    g.lineWidth = 1.5;
    g.stroke();
    const l = peakOf(anL), r = peakOf(anR);
    $("mL").style.height = pct(l);
    $("mR").style.height = pct(r);
    $("mIn").style.height = pct(mic.peak);
    $("clipLed").classList.toggle("on", performance.now() < mic.clipUntil);
    $("roMic").textContent = mic.node ? `${(20 * Math.log10(mic.peak + 1e-9)).toFixed(0)} dB` : "off";
    if (ui.playing) {
      const pk = 20 * Math.log10(Math.max(l, r) + 1e-9);
      $("roPeak").textContent = pk < -90 ? "—" : `${pk.toFixed(1)} dB`;
      const kb = tbuf.subarray(0, kAn.fftSize);
      kAn.getFloatTimeDomainData(kb);
      let ms = 0;
      for (let i = 0; i < kb.length; i++) ms += kb[i] * kb[i];
      kHist.push(ms / kb.length);
      if (kHist.length > 180) kHist.shift(); // ≈3 s at 60 fps
      const avg = kHist.reduce((a, b) => a + b, 0) / kHist.length;
      const st = -0.691 + 10 * Math.log10(avg * 2 + 1e-12);
      $("roLufs").textContent = st < -70 ? "—" : `${st.toFixed(1)} LUFS`;
    }
    if (live && document.querySelector('.tab.on[data-panel="mixer"]')) {
      for (const [id, n] of live.tracks) {
        const el = document.querySelector(`.strip[data-id="${id}"] .smeter b`);
        if (el) el.style.height = pct(peakOf(n.m));
      }
      for (const [id, n] of live.beats) {
        const el = document.querySelector(`.strip[data-id="${id}"] .smeter b`);
        if (el) el.style.height = pct(peakOf(n.m));
      }
      const me = document.querySelector('.strip[data-id="master"] .smeter b');
      if (me) me.style.height = pct(Math.max(l, r));
    }
    if (ui.playing || mic.node) requestAnimationFrame(draw);
    else meterLoop = false;
  };
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------- recording
function armedTrack() {
  return session.tracks.find((t) => t.armed);
}
function arm(track) {
  edit(`Arm ${track.name}`, () => session.tracks.forEach((t) => (t.armed = t === track ? !t.armed : false)), { audioChange: false });
}
async function toggleRecord() {
  if (ui.recording) return finishRecording();
  if (ui.busy) return;
  let track = armedTrack();
  if (!track) {
    const sel = trackById(ui.selTrack);
    if (sel) {
      history.push(session, `Arm ${sel.name}`);
      session.tracks.forEach((t) => (t.armed = t === sel));
      track = sel;
    } else {
      history.push(session, "Add track");
      track = S.newTrack(session, "lead");
      track.armed = true;
      session.tracks.push(track);
      ui.selTrack = track.id;
    }
    renderAll();
  }
  if (!(await ensureMic())) return;
  mic.chunks = [];
  resetRecView();
  if (isPunch()) return startPunch(track);
  const loop = isLoop();
  const from = loop ? session.loop.start : ui.playhead;
  ui.recording = { trackId: track.id, from, loop: loop ? { ...session.loop, L: session.loop.end - session.loop.start } : null };
  const t0 = await startPlayback(from, { cue: true, countIn: bpm() ? +S_().countIn || 0 : 0 });
  mic.node.port.postMessage({ cmd: "start", at: t0 });
  document.body.classList.add("recording");
  applyMixer();
  ui.lyricLine = 0;
  startTranscription();
  if (S_().prompter && session.lyrics.trim()) openPrompter();
  status(loop ? "Loop recording… every pass becomes a take. R or Space to stop." : "Recording… R or Space to stop.");
}
const PUNCH_XF = 0.01; // 10 ms crossfade at each punch boundary
const isPunch = () => session.punch.on && session.punch.out - session.punch.in > 0.1;

/** Pre-roll → record exactly [in, out] (latency-compensated) → post-roll → stop. */
async function startPunch(track) {
  const { in: pin, out: pout } = session.punch;
  const bar = barSeconds(bpm());
  const from = Math.max(0, pin - (+S_().preRoll || 1) * bar);
  const recStart = pin - PUNCH_XF;
  const recEnd = pout + PUNCH_XF;
  ui.recording = { trackId: track.id, from, punch: { in: pin, out: pout }, stopAt: pout + bar };
  const t0 = await startPlayback(from, { cue: true });
  const lat = latencySeconds();
  // Audio that reaches the recorder at time T was sung at T − latency, so the
  // capture window is shifted by the latency instead of trimming afterwards.
  mic.node.port.postMessage({ cmd: "start", at: t0 + (recStart - from) + lat, until: t0 + (recEnd - from) + lat });
  document.body.classList.add("recording");
  applyMixer();
  // The armed track plays up to the punch-in, drops out for the punch, comes back after.
  const n = live.tracks.get(track.id);
  if (n && audible(track)) {
    const v = dbToLin(track.volumeDb);
    const tIn = t0 + (pin - from), tOut = t0 + (pout - from);
    n.g.gain.cancelScheduledValues(0);
    n.g.gain.setValueAtTime(v, ctx.currentTime);
    n.g.gain.setValueAtTime(v, Math.max(ctx.currentTime, tIn - PUNCH_XF / 2));
    n.g.gain.linearRampToValueAtTime(0, tIn + PUNCH_XF / 2);
    n.g.gain.setValueAtTime(0, tOut - PUNCH_XF / 2);
    n.g.gain.linearRampToValueAtTime(v, tOut + PUNCH_XF / 2);
  }
  ui.lyricLine = 0;
  startTranscription();
  if (S_().prompter && session.lyrics.trim()) openPrompter();
  status(`Punch armed: pre-roll from ${fmtTime(from)}, recording ${fmtTime(pin)} → ${fmtTime(pout)}, post-roll 1 bar.`);
}

async function finishRecording() {
  const rec = ui.recording;
  await new Promise((resolve) => {
    mic.onDone = resolve;
    mic.node.port.postMessage({ cmd: "stop" });
  });
  ui.recording = null;
  updateRecView(0);
  document.body.classList.remove("recording");
  stopPlayback(false);
  closePrompter();
  const text = stopTranscription();
  if (rec.punch) return finishPunch(rec, text);
  const total = mic.chunks.reduce((a, c) => a + c.length, 0);
  const trim = Math.round(latencySeconds() * FS);
  const data = new Float32Array(Math.max(0, total));
  let o = 0;
  for (const c of mic.chunks) {
    data.set(c, o);
    o += c.length;
  }
  mic.chunks = [];
  let pcm;
  if (trim >= 0) pcm = data.subarray(Math.min(trim, data.length));
  else {
    pcm = new Float32Array(data.length - trim);
    pcm.set(data, -trim);
  }
  const track = trackById(rec.trackId);
  if (!track || pcm.length < FS * 0.3) {
    ui.playhead = rec.from;
    return status("Take too short — discarded.");
  }
  // Loop record: slice the continuous capture into one take per pass.
  const passes = [];
  if (rec.loop) {
    const L = Math.round(rec.loop.L * FS);
    for (let p = 0; p * L < pcm.length; p++) {
      const seg = pcm.subarray(p * L, Math.min(pcm.length, (p + 1) * L));
      if (seg.length >= FS * 1 || p === 0) passes.push(seg);
    }
  } else passes.push(pcm);
  history.push(session, passes.length > 1 ? `Record ${passes.length} takes` : "Record take");
  let last = null;
  let lastFull = null;
  for (const seg of passes) {
    const buffer = ctx.createBuffer(1, seg.length, FS);
    buffer.copyToChannel(seg, 0);
    const take = { id: S.uid(), name: `Take ${track.takes.length + 1}`, at: rec.from, duration: buffer.duration, best: false, transcript: text };
    audio.set(take.id, buffer);
    saveAudio(take.id, buffer);
    track.takes.push(take);
    last = take;
    if (!rec.loop || buffer.duration >= rec.loop.L * 0.98) lastFull = take;
  }
  // A stopped-early final loop pass stays as a take, but the last full pass goes on the track.
  S.addTakeClip(track, lastFull || last);
  if (passes.length > 1) track.showTakes = true;
  ui.selTrack = track.id;
  ui.playhead = rec.from;
  markStale();
  save();
  renderAll();
  updateUndo();
  status(`${passes.length > 1 ? `${passes.length} takes` : "Take"} saved on ${track.name} · latency comp ${Math.round(latencySeconds() * 1000)} ms`);
}

function finishPunch(rec, text) {
  const total = mic.chunks.reduce((a, c) => a + c.length, 0);
  const data = new Float32Array(total);
  let o = 0;
  for (const c of mic.chunks) {
    data.set(c, o);
    o += c.length;
  }
  mic.chunks = [];
  ui.playhead = rec.from;
  const track = trackById(rec.trackId);
  const pin = rec.punch.in;
  // Stopped before the punch finished? Keep what was captured.
  const pout = Math.min(rec.punch.out, pin - PUNCH_XF + total / FS - PUNCH_XF);
  if (!track || pout - pin < 0.1) {
    drawPlayhead();
    return status("Punch stopped before the punch-in point. Nothing recorded.");
  }
  history.push(session, "Punch-in take");
  const buffer = ctx.createBuffer(1, total, FS);
  buffer.copyToChannel(data, 0);
  const take = { id: S.uid(), name: `Take ${track.takes.length + 1} · punch`, at: pin - PUNCH_XF, duration: buffer.duration, best: false, transcript: text, punch: { in: pin, out: pout } };
  audio.set(take.id, buffer);
  saveAudio(take.id, buffer);
  track.takes.push(take);
  S.addPunchClip(track, take, pin, pout, PUNCH_XF);
  track.showTakes = true;
  ui.selTrack = track.id;
  markStale();
  save();
  renderAll();
  updateUndo();
  status(`Punched ${fmtTime(pin)} → ${fmtTime(pout)} on ${track.name} with 10 ms crossfades. It's a new take in the lane, ready to comp.`);
}

// ---------------------------------------------------------------- imports
async function decodeFile(file) {
  return ctx.decodeAudioData(await file.arrayBuffer());
}
/**
 * Import one or more beat files. One file with no stem name = the full beat; several files
 * (or names like "Kick", "808", "Keys") = stems, each with its own lane, fader, mute and solo.
 */
async function importBeats(files) {
  files = [...files];
  if (!files.length) return;
  const added = [];
  for (const file of files) {
    try {
      status(`Decoding ${file.name}…`);
      const buffer = await decodeFile(file);
      const id = S.uid();
      audio.set(id, buffer);
      saveAudio(id, buffer);
      const name = file.name.replace(/\.[^.]+$/, "");
      const kind = S.guessStemKind(name) || (files.length === 1 && !session.beats.length ? "full" : "melody");
      added.push(S.newBeat(id, name, kind));
    } catch (err) {
      toast(`Couldn't read ${file.name}: ${err.message}`);
    }
  }
  if (!added.length) return;
  // Tempo from the drums if there are any: they carry the clearest pulse.
  const pulse = added.find((b) => b.kind === "drums") || added.find((b) => b.kind === "full") || added[0];
  const detected = S_().bpm ? 0 : estimateBpm(audio.get(pulse.id).getChannelData(0), FS);
  edit(added.length > 1 ? `Import ${added.length} stems` : "Import beat", () => {
    session.beats.push(...added);
    if (!S_().bpm && detected) S_().bpm = detected;
  });
  $("bpm").value = S_().bpm;
  if (ui.view.fit) fitView();
  const kinds = added.map((b) => S.STEM_KINDS[b.kind].label).join(", ");
  status(added.length > 1 || added[0].kind !== "full"
    ? `${added.length} stem(s) loaded: ${kinds}. Check each lane's role (drop-down) so Automix treats it right.${detected ? ` ${detected} BPM detected.` : ""}`
    : `Beat loaded · ${detected || S_().bpm || "?"} BPM${detected ? " detected" : ""}.`);
}
const importBeat = (file) => importBeats([file]);
async function importVocal(file, type) {
  try {
    status(`Decoding ${file.name}…`);
    const buffer = await toMono(await decodeFile(file));
    edit("Import vocal", () => {
      let track = trackById(ui.selTrack);
      if (!track || track.clips.length) {
        track = S.newTrack(session, type || track?.type || "lead");
        track.name = file.name.replace(/\.[^.]+$/, "").slice(0, 24);
        session.tracks.push(track);
      }
      const take = { id: S.uid(), name: `Take ${track.takes.length + 1}`, at: 0, duration: buffer.duration, best: false, transcript: "" };
      audio.set(take.id, buffer);
      saveAudio(take.id, buffer);
      track.takes.push(take);
      S.addTakeClip(track, take);
      ui.selTrack = track.id;
    });
    if (ui.view.fit) fitView();
    status("Vocal imported.");
  } catch (err) {
    toast(`Couldn't read that file: ${err.message}`);
  }
}

// ---------------------------------------------------------------- engine
function buildChain() {
  $("chain").innerHTML = STAGES.map(([k, label]) => `<div class="node" data-stage="${k}"><i></i><span>${label}</span></div>`).join("");
  document.querySelectorAll(".node").forEach((n) => {
    n.onclick = () => {
      if (ui.busy) return;
      const k = n.dataset.stage;
      edit(`${S_().stages[k] ? "Disable" : "Enable"} ${k} stage`, () => (S_().stages[k] = !S_().stages[k]), { redraw: false });
      paintChain();
    };
  });
  paintChain();
}
function paintChain() {
  document.querySelectorAll(".node").forEach((n) => {
    const k = n.dataset.stage;
    const st = ui.stageState[k] || {};
    n.className = `node ${S_().stages[k] ? st.state || "" : "off"}`;
    n.style.setProperty("--p", st.state === "done" || st.state === "skipped" ? 1 : st.p || 0);
    n.title = S_().stages[k] ? `${k}: ${st.state || "ready"} · click to switch off` : `${k}: off · click to switch on`;
  });
}

function engineInputs() {
  const tracks = [];
  for (const t of session.tracks) {
    if (!audible(t) || !t.clips.length) continue;
    const r = S.renderTrack(t, audio, FS);
    if (!r) continue;
    const buffer = ctx.createBuffer(1, r.data.length, FS);
    buffer.copyToChannel(r.data, 0);
    const studioTuned = t.clips.every((c) => takeOf(t, c.takeId)?.tuned);
    const preCleaned = t.clips.every((c) => takeOf(t, c.takeId)?.cleaned);
    tracks.push({ id: t.id, name: t.name, role: t.type, buffer, offset: r.offset, pan: t.pan, fx: t.fx, tune: t.tune && !studioTuned, dbl: t.dbl, clean: preCleaned ? NO_CLEAN : cleanOf(t), trimDb: t.volumeDb, revSend: t.revSend, dlySend: t.dlySend, mute: false });
  }
  const beats = session.beats.filter((b) => audible(b) && audio.get(b.id)).map((b) => ({ ...b, buffer: audio.get(b.id) }));
  return { tracks, beats };
}

async function automix() {
  if (ui.busy) return;
  if (ui.recording) await finishRecording();
  const { tracks, beats } = engineInputs();
  if (!tracks.length) return toast("Record or import a vocal first (and make sure it isn't muted).");
  stopPlayback(false);
  ui.busy = true;
  ui.cancel = { cancelled: false };
  document.body.classList.add("busy");
  $("btnCancel").hidden = false;
  ui.stageState = Object.fromEntries(STAGES.map(([k]) => [k, { state: "queued", p: 0 }]));
  paintChain();
  const t0 = performance.now();
  let active = null;
  try {
    if (beats.length && !S_().bpm) {
      S_().bpm = estimateBpm((beats.find((b) => b.kind === "drums") || beats[0]).buffer.getChannelData(0), FS);
      $("bpm").value = S_().bpm;
    }
    const run = await runEngine({
      tracks, beats, fs: FS, mode: session.mode, settings: { ...S_(), masterDb: session.master.volumeDb }, profile: ui.profile, signal: ui.cancel,
      onStage: (k, p, msg, state) => {
        active = k;
        const idx = STAGES.findIndex(([x]) => x === k);
        STAGES.forEach(([x], i) => {
          if (i < idx && ui.stageState[x].state !== "skipped") ui.stageState[x] = { state: "done", p: 1 };
        });
        ui.stageState[k] = { state: state || (p >= 1 ? "done" : "active"), p };
        paintChain();
        if (msg) status(msg);
      },
    });
    ui.run = run;
    ui.master = run.mix.buffer;
    ui.key = run.key;
    ui.profile = run.profile;
    ui.stale = false;
    store.set("profile", run.profile);
    $("roLufs").textContent = `${run.mix.lufs.toFixed(1)} LUFS`;
    $("roPeak").textContent = `${(run.mix.truePeak ?? run.mix.peak).toFixed(1)} dBTP`;
    updateChips();
    setAB("B");
    renderReport();
    renderSong();
    drawPitch();
    showTab("engine");
    status(`Mixed in ${((performance.now() - t0) / 1000).toFixed(1)}s · ${run.mix.lufs.toFixed(1)} LUFS · true peak ${(run.mix.truePeak ?? run.mix.peak).toFixed(1)} dBTP · B to compare`);
  } catch (err) {
    console.error(err);
    if (active) ui.stageState[active] = { state: "failed", p: 1 };
    paintChain();
    if (err.message === "Cancelled") status("Automix cancelled. Your takes are untouched.");
    else {
      status(`Automix failed at ${active || "start"}: ${err.message}. Click Automix to retry, or switch that stage off.`);
      toast(`${active || "Engine"} failed: ${err.message}`);
    }
  } finally {
    ui.busy = false;
    ui.cancel = null;
    document.body.classList.remove("busy");
    $("btnCancel").hidden = true;
  }
}

// ---------------------------------------------------------------- vocal cleanup (Clean tab)
const NO_CLEAN = { denoise: 0, breaths: "keep", deess: 0, pop: false, declick: false, hum: "off" };
const cleanOf = (t) => (t.clean = { ...CLEAN_DEFAULTS, ...(t.clean || {}) });
function renderCleanTab() {
  const t = trackById(ui.selTrack);
  $("cleanTrack").textContent = t ? t.name : "select a track";
  const on = !!t;
  for (const id of ["clDenoise", "clDeess", "clPop", "clDeclick", "btnCleanPreview", "btnCleanAll"]) $(id).disabled = !on;
  if (!t) return;
  const c = cleanOf(t);
  $("clDenoise").value = c.denoise;
  $("clDenoiseOut").textContent = c.denoise <= 0.02 ? "off" : `${Math.round(c.denoise * 100)}%`;
  $("clDeess").value = c.deess;
  $("clDeessOut").textContent = c.deess <= 0.02 ? "off" : `${Math.round(c.deess * 100)}%`;
  $("clPop").checked = !!c.pop;
  $("clDeclick").checked = !!c.declick;
  setSeg("clBreaths", "v", c.breaths);
  setSeg("clHum", "v", c.hum);
  const k = t.takes.find((x) => x.cleaned && t.clips.some((cl) => cl.takeId === x.id));
  $("cleanReport").innerHTML = k?.cleanReport ? `<section><h4>${esc(k.name)}</h4><ul>${k.cleanReport.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></section>` : "";
}
function cleanEdit(label, key, fn) {
  const t = trackById(ui.selTrack);
  if (!t) return;
  history.push(session, `${t.name}: ${label}`, `clean:${key}:${t.id}`);
  fn(cleanOf(t));
  t.cleanReviewed = true;
  markStale();
  save();
  updateUndo();
  renderCleanTab();
  renderSong();
}
async function previewClean() {
  const t = trackById(ui.selTrack);
  if (!t) return toast("Select a track first.");
  const src = studioSourceTake(t);
  if (!src || !audio.get(src.id)) return toast("That track has no take to clean.");
  if (guardBusy("cleaning")) return;
  const x = audio.get(src.id).getChannelData(0);
  $("btnCleanPreview").disabled = true;
  ui.job = "the cleanup";
  try {
    status(`Cleaning ${src.name}…`);
    const r = await renderVocal({ role: t.type, fx: "clean" }, x, FS, session.mode, (p) => status(`Cleaning ${src.name}… ${Math.round(p * 100)}%`), {
      stages: { clean: true, tone: false, dynamics: false }, clean: cleanOf(t),
    });
    const y = r.buffer.getChannelData(0);
    // Match the cleaned take's level to the original so the comparison is fair.
    let ex = 0, ey = 0;
    for (let i = 0; i < x.length; i++) {
      ex += x[i] * x[i];
      ey += y[i] * y[i];
    }
    const g = Math.sqrt(ex / Math.max(ey, 1e-12));
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = clamp(y[i] * g, -1, 1);
    const buffer = ctx.createBuffer(1, out.length, FS);
    buffer.copyToChannel(out, 0);
    const take = { id: S.uid(), name: `${src.name.replace(/ · clean$/, "")} · clean`, at: src.at, duration: buffer.duration, best: false, transcript: src.transcript || "", cleaned: true, cleanedFrom: src.id, tuned: src.tuned, cleanReport: r.report.filter((l) => !/^(Voice:|Tone EQ|Vocal rider|Compressor)/.test(l)) };
    audio.set(take.id, buffer);
    saveAudio(take.id, buffer);
    const tt = trackById(t.id);
    if (!tt) throw new Error("the track was removed while cleaning");
    edit(`Clean ${src.name}`, () => {
      tt.takes.push(take);
      for (const c of tt.clips) if (c.takeId === src.id) c.takeId = take.id;
      tt.showTakes = true;
      tt.cleanReviewed = true;
    });
    renderCleanTab();
    status(`Cleaned ${src.name} → "${take.name}" is on the track; the raw take is still in the lane. Press Space to listen, or click "Use" on the raw take to compare.`);
  } catch (err) {
    console.error(err);
    toast(`Cleanup failed: ${err.message}`);
  } finally {
    ui.job = null;
    $("btnCleanPreview").disabled = false;
  }
}

// ---------------------------------------------------------------- song checklist
function songSteps() {
  const vocals = session.tracks.filter((t) => t.takes.length);
  const anyTake = (f) => session.tracks.some((t) => t.takes.some(f));
  return [
    { t: "Beat", d: "Import your instrumental: one file, or the stems (drums, 808, melody…) selected together. Tempo is detected so bars, click and echo line up.", done: session.beats.length > 0, acts: [["Import beat / stems", () => $("fileBeat").click()]] },
    { t: "Song sections", d: "Mark where the intro, verses and hooks start (moves the playhead there first).", opt: true, done: session.markers.length >= 2,
      acts: ["Intro", "Verse", "Hook", "Bridge", "Outro"].map((n) => [n, () => addMarker(n)]) },
    { t: "Record vocals", d: "Add a Lead track, arm it, press R. Use loop record for several passes, punch-in to fix a line.", done: vocals.length > 0,
      acts: [["Add lead", () => addTrackOfType("lead")], ["Record (R)", () => toggleRecord()]] },
    { t: "Comp the best takes", d: "Open a track's take lanes, cut with the Cut tool, and pick the best take for each part (Comp / Use, ★).", opt: true,
      done: anyTake((k) => k.best) || session.tracks.some((t) => t.clips.length > 1), acts: [["Show takes", () => showTakesOfSelected()]] },
    { t: "Clean the vocals", d: "De-noise, breaths, de-ess, pop filter, hum, clicks. Automix uses these, or make a cleaned take now.", done: anyTake((k) => k.cleaned) || session.tracks.some((t) => t.cleanReviewed),
      acts: [["Open Clean", () => showTab("clean")]] },
    { t: "Tune", d: "Pick Natural / Tight / Hard for Automix, or Studio-tune a take on the backend for the best quality.", done: anyTake((k) => k.tuned) || (S_().tuneStyle !== "off" && !!ui.master),
      acts: [["Open Tune", () => showTab("tune")]] },
    { t: "Doubles & ad-libs", d: "Record a Double and Ad-lib track, or click 2X on the lead for AI doubles.", opt: true,
      done: session.tracks.some((t) => t.type !== "lead" && t.takes.length) || session.tracks.some((t) => t.dbl && t.dbl !== "off"),
      acts: [["Add double", () => addTrackOfType("double")], ["Add ad-lib", () => addTrackOfType("adlib")]] },
    { t: "Mix", d: "Pick a mix preset, then Automix. Press B to compare raw vs mix; nudge faders and Automix again.", done: !!ui.master && !ui.stale,
      acts: [["Presets", () => showTab("mixer")], ["Automix", () => automix()]] },
    { t: "Master", d: "Loudness target, tone, width and ceiling for the final file (Mixer tab → Master). Automix applies them.", done: !!ui.master && !ui.stale && S_().stages.master,
      acts: [["Open master", () => showTab("mixer")]] },
    { t: "Export", d: "WAV for distribution, MP3 to share, stems for anyone mixing it further.", done: !!ui.exported,
      acts: [["WAV", () => exportAs("wav")], ["MP3", () => exportAs("mp3")]] },
  ];
}
function renderSong() {
  const ol = $("songSteps");
  if (!ol) return;
  const steps = songSteps();
  const next = steps.findIndex((x) => !x.done && !x.opt);
  ol.innerHTML = "";
  steps.forEach((st, i) => {
    const li = document.createElement("li");
    li.className = `${st.done ? "done" : ""}${i === next ? " next" : ""}`;
    const txt = document.createElement("div");
    txt.innerHTML = `<b>${esc(st.t)}${st.opt ? '<span class="opt">OPTIONAL</span>' : ""}</b><small>${esc(st.d)}</small>`;
    const acts = document.createElement("div");
    acts.className = "acts";
    for (const [label, fn] of st.acts) {
      const b = Object.assign(document.createElement("button"), { textContent: label });
      b.onclick = () => Promise.resolve(fn()).then(renderSong);
      acts.append(b);
    }
    li.append(txt, acts);
    ol.append(li);
  });
}
function addTrackOfType(type) {
  edit("Add track", () => {
    const t = S.newTrack(session, type);
    session.tracks.forEach((x) => (x.armed = false));
    t.armed = true;
    session.tracks.push(t);
    ui.selTrack = t.id;
  }, { audioChange: false });
  status(`Added and armed ${trackById(ui.selTrack).name}. Press R to record.`);
}
function showTakesOfSelected() {
  const t = trackById(ui.selTrack) || session.tracks.find((x) => x.takes.length);
  if (!t) return toast("Record something first.");
  edit("Show takes", () => {
    t.showTakes = true;
    ui.selTrack = t.id;
  }, { audioChange: false });
}

// ---------------------------------------------------------------- studio tune (backend)
const beUrl = (path) => `${(S_().backendUrl || "http://127.0.0.1:8765").replace(/\/$/, "")}${path}`;
let beOk = false;
async function checkBackend() {
  try {
    const r = await fetch(beUrl("/health"), { cache: "no-store" });
    const j = await r.json();
    beOk = !!j.ok;
    $("beStatus").textContent = beOk ? `online · v${j.version}` : `engines missing: ${j.engines?.error || "?"}`;
  } catch {
    beOk = false;
    $("beStatus").textContent = "offline. Run backend/start-backend.bat (or launch MV Booth from its shortcut).";
  }
  $("beDot").className = `be-dot ${beOk ? "ok" : "down"}`;
  $("btnStudioTune").disabled = !beOk;
  return beOk;
}
/** The take under the selected clip, else under the playhead, else the newest take. */
function studioSourceTake(t) {
  const c = t.clips.find((x) => x.id === ui.selClip) || S.clipAt(t, currentPos()) || t.clips.at(-1);
  return (c && takeOf(t, c.takeId)) || t.takes.at(-1);
}
async function studioTune() {
  const t = trackById(ui.selTrack);
  if (!t) return toast("Select a track first.");
  const src = studioSourceTake(t);
  if (!src || !audio.get(src.id)) return toast("That track has no take to tune.");
  if (!(await checkBackend())) return toast("The tuning backend isn't running.");
  const st = S_().studio;
  const params = {
    key: S_().key === "auto" ? "auto" : +S_().key, scale: S_().scale, retune_ms: st.retuneMs, vibrato: st.vibrato,
    amount: st.amount, formant: st.formant, min_confidence: st.minConf, model: st.model,
  };
  if (guardBusy("studio-tuning")) return;
  $("btnStudioTune").disabled = true;
  ui.job = "the studio tune";
  try {
    status(`Sending ${src.name} to the studio tuner…`);
    const fd = new FormData();
    fd.append("file", encodeWav(audio.get(src.id)), "take.wav");
    fd.append("params", JSON.stringify(params));
    const r = await fetch(beUrl("/tune"), { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    const { job } = await r.json();
    let j;
    for (;;) {
      await new Promise((res) => setTimeout(res, 600));
      const jr = await fetch(beUrl(`/jobs/${job}`), { cache: "no-store" });
      if (!jr.ok) throw new Error("the backend lost the job (was it restarted?)");
      j = await jr.json();
      status(`Studio tune · ${Math.round((j.progress || 0) * 100)}% · ${j.message || j.state}`);
      if (j.state === "done" || j.state === "failed") break;
    }
    if (j.state === "failed") throw new Error(j.message);
    const wav = await (await fetch(beUrl(`/jobs/${job}/audio`))).arrayBuffer();
    const buffer = await toMono(await ctx.decodeAudioData(wav));
    const take = { id: S.uid(), name: `${src.name.replace(/ · tuned.*$/, "")} · tuned`, at: src.at, duration: buffer.duration, best: false, transcript: src.transcript || "", tuned: true, tunedFrom: src.id, report: j.report };
    audio.set(take.id, buffer);
    saveAudio(take.id, buffer);
    const tt = trackById(t.id);
    if (!tt) throw new Error("the track was removed while tuning");
    edit(`Studio-tune ${src.name}`, () => {
      tt.takes.push(take);
      // Swap the tuned take into every clip that used the source; the original stays in the lane.
      for (const c of tt.clips) if (c.takeId === src.id) c.takeId = take.id;
      tt.showTakes = true;
    });
    renderStudioReport(take);
    const sm = j.report.summary;
    status(`Tuned ${src.name} in ${j.report.seconds}s · key ${j.report.key.label} · ${sm.tuned}/${sm.regions} regions tuned, ${sm.skipped_low_confidence} left untouched (low confidence or already in tune). Original kept in the take lane.`);
  } catch (err) {
    console.error(err);
    toast(`Studio tune failed: ${err.message}`);
    status(`Studio tune failed: ${err.message}. Your takes are untouched.`);
  } finally {
    ui.job = null;
    $("btnStudioTune").disabled = !beOk;
  }
}
function renderStudioReport(take) {
  const el = $("studioReport");
  const rep = take?.report;
  if (!rep) return (el.innerHTML = "");
  const sm = rep.summary;
  const rows = rep.regions.map((r) => {
    const cls = r.tuned ? "tuned" : r.reason.startsWith("low") ? "skip" : "fine";
    return `<div class="rg ${cls}"><span>${fmtTime(take.at + r.start)}–${fmtTime(take.at + r.end)}</span><span>conf ${(r.confidence * 100).toFixed(0)}%</span><span>${r.tuned ? `${r.mean_shift_cents > 0 ? "+" : ""}${r.mean_shift_cents}¢` : esc(r.reason.split(":")[0])}</span></div>`;
  }).join("");
  el.innerHTML = `<section><h4>${esc(take.name)} · ${esc(rep.key.label)}</h4><ul><li>${sm.tuned}/${sm.regions} sung regions tuned (${Math.round(sm.coverage * 100)}% of sung time), average move ${sm.mean_shift_cents}¢</li><li>${sm.skipped_low_confidence} region(s) left as recorded</li></ul><div class="regions">${rows}</div></section>`;
}

// ---------------------------------------------------------------- export
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
// ---------------------------------------------------------------- session package (.mvbooth)
/** The whole session in one file: model + the audio its clips and beats use. No Automix needed. */
async function exportPackage() {
  await flushSave();
  const audioMap = new Map();
  for (const id of usedAudioIds(session)) {
    const b = audio.get(id) || (await loadAudio(id));
    if (b) audioMap.set(id, { sampleRate: b.sampleRate, channels: Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)) });
  }
  if (!audioMap.size) throw new Error("this session has no audio yet");
  status("Packing the session…");
  const blob = await packSession(session, audioMap);
  return blob;
}
async function importPackage(file) {
  if (guardBusy("opening a package")) return;
  status(`Opening ${file.name || "package"}…`);
  const { session: s, audio: pa } = await unpackSession(file);
  for (const [id, a] of pa) {
    const b = new AudioBuffer({ numberOfChannels: a.channels.length, length: a.channels[0].length, sampleRate: a.sampleRate });
    a.channels.forEach((d, c) => b.copyToChannel(d, c));
    const r = await resample(b);
    audio.set(id, r);
    await saveAudio(id, r);
  }
  // Opens as its own session (a new id), so it never overwrites the one it came from.
  s.id = S.uid();
  s.created = Date.now();
  await S.saveSession(s);
  await S.saveSession(session);
  await switchTo(await S.loadSession(s.id));
  status(`Opened "${s.name}" from the package · ${s.tracks.length} track(s), ${s.beats.length} beat stem(s).`);
}

async function exportAs(kind) {
  $("exportMenu").hidden = true;
  const rate = +S_().exportRate || 48000;
  if (kind === "package") {
    const blob = await exportPackage();
    download(blob, `${safe(session.name)}_${stamp()}.mvbooth`);
    status(`Session package saved (${(blob.size / 1048576).toFixed(1)} MB): beat, every take on the timeline, edits and settings. Open it in MV Booth with Session ▾ → Open session package, or send it for mixing.`);
    return;
  }
  if (kind === "raw") {
    const all = session.tracks.flatMap((t) => t.takes.map((k) => [t, k]));
    if (!all.length) return toast("No takes yet.");
    for (const [t, k] of all) download(encodeWav(await resample(audio.get(k.id), rate)), `MVBooth_raw_${safe(t.name)}_${safe(k.name)}.wav`);
    return;
  }
  if (!ui.master || ui.stale) return toast(ui.master ? "The mix is out of date. Run Automix first." : "Run Automix first, then export.");
  const base = `MVBooth_${safe(session.name)}_${stamp()}`;
  ui.exported = true;
  setTimeout(renderSong, 0);
  if (kind === "wav") download(encodeWav(await resample(ui.master, rate)), `${base}.wav`);
  else if (kind === "mp3") {
    status("Encoding MP3…");
    const blob = await encodeMp3(await resample(ui.master, rate), { onProgress: (p) => status(`Encoding MP3… ${Math.round(p * 100)}%`) });
    download(blob, `${base}.mp3`);
    status("MP3 exported (320 kbps).");
  } else if (kind === "stems") {
    const { beats } = engineInputs();
    const ids = [...ui.run.mixInput.map((v) => v.track.id), ...beats.map((b) => b.id)];
    for (const [i, id] of ids.entries()) {
      status(`Rendering stem ${i + 1}/${ids.length}…`);
      const { buffer } = await renderStem(ui.run, { beats, fs: FS, mode: session.mode, settings: S_() }, id);
      const name = beats.find((b) => b.id === id)?.name || ui.run.mixInput.find((v) => v.track.id === id).track.name;
      download(encodeWav(await resample(buffer, rate)), `${base}_stem_${String(i + 1).padStart(2, "0")}_${safe(name)}.wav`);
    }
    status("Stems exported (pre-master: they sum to the mix before the limiter).");
  }
}

// ---------------------------------------------------------------- timeline view
const HDR = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hdr")) || 248;
const viewWidth = () => Math.max(100, $("timeline").clientWidth - HDR());
const t2x = (t) => (t - ui.view.start) * ui.view.pps;
const x2t = (x) => ui.view.start + x / ui.view.pps;
function fitView() {
  ui.view.pps = viewWidth() / Math.max(30, projectEnd() + 4);
  ui.view.start = 0;
  ui.view.fit = true;
  renderLanesOnly();
}
function zoom(f, anchorT = currentPos()) {
  const ax = t2x(anchorT);
  ui.view.pps = clamp(ui.view.pps * f, 2, 2000);
  ui.view.start = Math.max(0, anchorT - ax / ui.view.pps);
  ui.view.fit = false;
  renderLanesOnly();
}
function drawPlayhead(pos = currentPos()) {
  $("clock").textContent = fmtTime(pos);
  const bb = barBeat(Math.max(0, pos), bpm());
  $("clockSub").textContent = bb ? `Bar ${bb.bar} · Beat ${bb.beat} · ${bpm()} BPM · 4/4` : "Set or tap a tempo for bars";
  const x = t2x(pos);
  const ph = $("playhead");
  ph.style.display = x < 0 || x > viewWidth() ? "none" : "block";
  ph.style.transform = `translateX(${x}px)`;
}

function peaks(id, buf) {
  let p = peaksCache.get(id);
  if (p) return p;
  const d = buf.getChannelData(0);
  const B = 256;
  const n = Math.ceil(d.length / B);
  const mn = new Float32Array(n), mx = new Float32Array(n);
  let peak = 1e-4;
  for (let i = 0; i < n; i++) {
    let a = 0, b = 0;
    for (let j = i * B; j < Math.min(d.length, (i + 1) * B); j++) {
      if (d[j] < a) a = d[j];
      if (d[j] > b) b = d[j];
    }
    mn[i] = a;
    mx[i] = b;
    peak = Math.max(peak, -a, b);
  }
  p = { mn, mx, B, peak };
  peaksCache.set(id, p);
  return p;
}
/** Draw `buf` (which starts at timeline time `bufAt`) between timeline times [s, e). */
function drawWave(g, buf, id, bufAt, s, e, top, h, color, glow, norm = true) {
  const P = peaks(id, buf);
  const mid = top + h / 2;
  const scale = (norm ? 1 / P.peak : 1) * (h / 2) * 0.9;
  g.fillStyle = color;
  g.shadowColor = glow;
  g.shadowBlur = 6;
  // One path, one fill: the glow is blurred once per waveform, not once per pixel column.
  g.beginPath();
  const x0 = Math.max(0, Math.floor(t2x(s)));
  const x1 = Math.min(viewWidth(), Math.ceil(t2x(e)));
  for (let x = x0; x < x1; x++) {
    const ta = x2t(x) - bufAt, tb = x2t(x + 1) - bufAt;
    const ia = Math.max(0, Math.floor((ta * buf.sampleRate) / P.B));
    const ib = Math.min(P.mn.length, Math.ceil((tb * buf.sampleRate) / P.B));
    let a = 0, b = 0;
    for (let i = ia; i < ib; i++) {
      if (P.mn[i] < a) a = P.mn[i];
      if (P.mx[i] > b) b = P.mx[i];
    }
    if (ib > ia) g.rect(x, mid - b * scale, 1, Math.max(1, (b - a) * scale));
  }
  g.fill();
  g.shadowBlur = 0;
}

function prepCanvas(canvas) {
  const w = canvas.clientWidth, h = canvas.clientHeight, dpr = devicePixelRatio || 1;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  const g = canvas.getContext("2d");
  // Re-allocating the bitmap every frame is the expensive part; only resize when the size changed.
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  } else if (g.reset) g.reset();
  else {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}
function drawGrid(g, w, h) {
  const B = bpm();
  const vs = ui.view.start, ve = x2t(w);
  if (isLoop() || session.loop.end > session.loop.start) {
    const lx0 = t2x(session.loop.start), lx1 = t2x(session.loop.end);
    g.fillStyle = session.loop.on ? "rgba(255,179,92,0.06)" : "rgba(255,255,255,0.015)";
    g.fillRect(lx0, 0, lx1 - lx0, h);
  }
  if (B) {
    const beat = 60 / B;
    const showBeats = ui.view.pps * beat > 14;
    for (let b = Math.floor(vs / beat); b * beat < ve; b++) {
      const bar = b % 4 === 0;
      if (!bar && !showBeats) continue;
      g.fillStyle = bar ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.025)";
      g.fillRect(Math.round(t2x(b * beat)), 0, 1, h);
    }
  }
  if (session.punch.out > session.punch.in) {
    const px0 = t2x(session.punch.in), px1 = t2x(session.punch.out);
    g.fillStyle = session.punch.on ? "rgba(255,59,74,0.09)" : "rgba(255,59,74,0.03)";
    g.fillRect(px0, 0, px1 - px0, h);
    if (session.punch.on) {
      g.fillStyle = "rgba(255,59,74,0.7)";
      g.fillRect(Math.round(px0), 0, 1, h);
      g.fillRect(Math.round(px1), 0, 1, h);
    }
  }
  for (const m of session.markers) {
    g.fillStyle = "rgba(255,122,26,0.35)";
    g.fillRect(Math.round(t2x(m.t)), 0, 1, h);
  }
}

function drawRuler() {
  const c = $("ruler");
  const { g, w, h } = prepCanvas(c);
  g.font = "10px JetBrains Mono, monospace";
  const B = bpm();
  $("rulerHead").textContent = B ? "BARS" : "TIME";
  if (session.loop.end > session.loop.start) {
    const lx0 = t2x(session.loop.start), lx1 = t2x(session.loop.end);
    g.fillStyle = session.loop.on ? "rgba(255,122,26,0.55)" : "rgba(255,255,255,0.12)";
    g.fillRect(lx0, 0, lx1 - lx0, 5);
  }
  if (session.punch.out > session.punch.in) {
    const px0 = t2x(session.punch.in), px1 = t2x(session.punch.out);
    g.fillStyle = session.punch.on ? "rgba(255,59,74,0.85)" : "rgba(255,59,74,0.3)";
    g.fillRect(px0, 25, px1 - px0, 5);
  }
  if (B) {
    const bar = barSeconds(B);
    const step = Math.max(1, Math.ceil(46 / (ui.view.pps * bar)));
    for (let n = Math.floor(ui.view.start / bar); n * bar < x2t(w); n++) {
      if (n % step) continue;
      const x = Math.round(t2x(n * bar));
      g.fillStyle = "rgba(255,255,255,0.18)";
      g.fillRect(x, 10, 1, h - 10);
      g.fillStyle = "#6b7684";
      g.fillText(String(n + 1), x + 4, 21);
    }
  } else {
    const steps = [1, 2, 5, 10, 15, 30, 60];
    const step = steps.find((s) => s * ui.view.pps > 60) || 120;
    for (let s = Math.floor(ui.view.start / step) * step; s < x2t(w); s += step) {
      const x = Math.round(t2x(s));
      g.fillStyle = "rgba(255,255,255,0.18)";
      g.fillRect(x, 10, 1, h - 10);
      g.fillStyle = "#6b7684";
      g.fillText(fmtTime(s).replace(/\.0$/, ""), x + 4, 21);
    }
  }
  for (const m of session.markers) {
    const x = t2x(m.t);
    g.fillStyle = "#ff7a1a";
    g.beginPath();
    g.moveTo(x, 6);
    g.lineTo(x + 7, 6);
    g.lineTo(x + 7, 14);
    g.lineTo(x, 18);
    g.fill();
    g.fillStyle = "#ffb35c";
    g.fillText(m.name, x + 10, 15);
  }
}

// ---------------------------------------------------------------- lanes
const DBL = { off: "DBL", stereo: "2X", oct: "2X+8" };
function laneEl(cls, color) {
  const lane = document.createElement("div");
  lane.className = `lane ${cls}`;
  if (color) lane.style.setProperty("--lane-color", color);
  return lane;
}
function tog(label, cls, title, on, fn) {
  const b = Object.assign(document.createElement("button"), { className: `tog ${cls}`, textContent: label, title });
  b.classList.toggle("on", !!on);
  b.onclick = (e) => {
    e.stopPropagation();
    fn();
  };
  return b;
}
function sel(opts, value, fn) {
  const s = document.createElement("select");
  for (const [k, v] of opts) s.add(new Option(v, k));
  s.value = value;
  s.onchange = () => fn(s.value);
  s.onclick = (e) => e.stopPropagation();
  return s;
}
function volRow(value, onInput, label) {
  const row = document.createElement("div");
  row.className = "vol";
  const r = Object.assign(document.createElement("input"), { type: "range", min: -60, max: 6, step: 0.5, value });
  const o = document.createElement("output");
  const show = () => (o.textContent = +r.value <= -60 ? "−∞ dB" : `${(+r.value).toFixed(1)} dB`);
  show();
  r.oninput = () => {
    onInput(+r.value);
    show();
  };
  r.ondblclick = () => {
    r.value = 0;
    r.oninput();
  };
  r.title = `${label} (double-click resets)`;
  row.append(r, o);
  return row;
}

function trackHead(t) {
  const head = document.createElement("div");
  head.className = "lane-head";
  head.onclick = (e) => {
    if (e.target.closest("button,select,input")) return;
    ui.selTrack = t.id;
    renderAll();
  };
  const top = document.createElement("div");
  top.className = "top";
  const armB = Object.assign(document.createElement("button"), { className: `arm${t.armed ? " on" : ""}`, title: "Record-arm (only one track at a time)" });
  armB.onclick = (e) => {
    e.stopPropagation();
    arm(t);
  };
  const name = Object.assign(document.createElement("input"), { className: "name", value: t.name });
  name.onchange = () => edit("Rename track", () => (t.name = name.value || t.name), { audioChange: false });
  top.append(
    armB,
    name,
    tog("✕", "x", "Delete track", false, () => {
      if (!confirm(`Delete track "${t.name}"? (Undo with Ctrl+Z)`)) return;
      stopPlayback();
      edit("Delete track", () => (session.tracks = session.tracks.filter((x) => x !== t)));
    }),
  );
  const r1 = document.createElement("div");
  r1.className = "row";
  r1.append(
    sel(Object.entries(ROLES).filter(([, r]) => !r.hidden).map(([k, r]) => [k, r.label]), t.type, (v) => edit("Track type", () => (t.type = v))),
    sel(Object.entries(FX), t.fx || "clean", (v) => edit("Track FX", () => (t.fx = v))),
  );
  const r2 = document.createElement("div");
  r2.className = "row";
  r2.append(tog("TUNE", "t", "Pitch correction on this track", t.tune !== false, () => edit("Toggle tune", () => (t.tune = t.tune === false))));
  if (t.type === "lead") {
    r2.append(tog(DBL[t.dbl || "off"], "d", "AI doubles: off → stereo pair → stereo + octave", t.dbl && t.dbl !== "off", () => edit("AI doubles", () => (t.dbl = { off: "stereo", stereo: "oct", oct: "off" }[t.dbl || "off"]))));
  }
  r2.append(
    tog("M", "m", "Mute", t.mute, () => edit("Mute", () => (t.mute = !t.mute), { redraw: true }) || applyMixer()),
    tog("S", "s", "Solo", t.solo, () => edit("Solo", () => (t.solo = !t.solo)) || applyMixer()),
    tog(`${t.takes.length} ${t.showTakes ? "▴" : "▾"}`, "", "Show take lanes (comping)", t.showTakes, () => edit("Show takes", () => (t.showTakes = !t.showTakes), { audioChange: false })),
  );
  head.append(top, r1, r2, volRow(t.volumeDb, (v) => {
    history.push(session, `${t.name} volume`, `vol:${t.id}`);
    t.volumeDb = v;
    markStale();
    save();
    applyMixer();
    updateUndo();
  }, "Track volume"));
  return head;
}

function takeHead(t, k) {
  const head = document.createElement("div");
  head.className = "lane-head";
  const used = t.clips.some((c) => c.takeId === k.id);
  const name = Object.assign(document.createElement("span"), { className: `tname${used ? " used" : ""}`, textContent: `${k.name} · ${k.duration.toFixed(1)}s`, title: k.transcript || k.name });
  head.append(
    tog("★", "star", "Mark as best take", k.best, () => edit("Best take", () => (k.best = !k.best), { audioChange: false })),
    name,
    tog("Use", "", "Use this whole take on the track", false, () => edit(`Use ${k.name}`, () => S.useWholeTake(t, k))),
    tog("Comp", "", "Swap this take into the selected clip (comping)", false, () => {
      const c = t.clips.find((x) => x.id === ui.selClip) || S.clipAt(t, ui.playhead);
      if (!c) return toast("Select a clip on this track (or put the playhead over one) first.");
      edit(`Comp ${k.name}`, () => {
        c.takeId = k.id;
        c.shift = 0;
      });
    }),
    tog("✕", "x", "Delete take", false, () => {
      if (!confirm(`Delete ${k.name}? (Undo with Ctrl+Z)`)) return;
      edit("Delete take", () => {
        t.takes = t.takes.filter((x) => x !== k);
        t.clips = t.clips.filter((c) => c.takeId !== k.id);
      });
    }),
  );
  return head;
}

function beatHead(b) {
  const head = document.createElement("div");
  head.className = "lane-head";
  const top = document.createElement("div");
  top.className = "top";
  const name = Object.assign(document.createElement("input"), { className: "name", value: b.name });
  name.onchange = () => edit("Rename beat", () => (b.name = name.value || b.name), { audioChange: false });
  top.append(name, tog("✕", "x", "Remove this beat stem", false, () => {
    if (!confirm(`Remove "${b.name}"? (Undo with Ctrl+Z)`)) return;
    stopPlayback();
    edit("Remove beat stem", () => (session.beats = session.beats.filter((x) => x.id !== b.id)));
  }));
  const row = document.createElement("div");
  row.className = "row";
  const kind = sel(Object.entries(S.STEM_KINDS).map(([k, v]) => [k, v.label]), b.kind, (v) => {
    edit("Stem role", () => (b.kind = v));
    applyMixer();
  });
  kind.title = "Stem role: decides how Automix treats it. Drums keep their punch, 808/bass stays mono and centred, melody and FX make room for the vocal.";
  kind.className = "kind";
  row.append(
    kind,
    tog("M", "m", "Mute", b.mute, () => edit("Mute beat", () => (b.mute = !b.mute)) || applyMixer()),
    tog("S", "s", "Solo: hear only soloed lanes", b.solo, () => edit("Solo beat", () => (b.solo = !b.solo)) || applyMixer()),
  );
  head.append(top, row, volRow(b.volumeDb || 0, (v) => {
    history.push(session, `${b.name} volume`, `vol:${b.id}`);
    b.volumeDb = v;
    markStale();
    save();
    applyMixer();
    updateUndo();
  }, `${b.name} volume`));
  return head;
}

function renderLanes() {
  const lanes = $("lanes");
  lanes.innerHTML = "";
  const proc = ui.ab === "B" && !ui.stale ? ui.run?.processed : null;
  for (const b of session.beats) {
    const col = S.STEM_KINDS[b.kind]?.color || "#ff7a1a";
    const lane = laneEl(`beat${session.beats.length > 1 ? " stem" : ""}${audible(b) ? "" : " muted"}`, col);
    const c = document.createElement("canvas");
    c._draw = (g, w, h) => {
      drawGrid(g, w, h);
      const buf = audio.get(b.id);
      if (buf) drawWave(g, buf, b.id, b.offset || 0, b.offset || 0, (b.offset || 0) + buf.duration, 8, h - 16, `${col}cc`, col);
    };
    c.onpointerdown = (e) => laneSeek(e, c);
    lane.append(beatHead(b), c);
    lanes.append(lane);
  }
  for (const t of session.tracks) {
    const lane = laneEl(`vocal${t.id === ui.selTrack ? " sel" : ""}`, t.color);
    const c = document.createElement("canvas");
    c._track = t;
    c._draw = (g, w, h) => drawTrack(g, w, h, t, proc?.get(t.id));
    c.onpointerdown = (e) => clipPointer(e, c, t);
    c.onpointermove = (e) => c.classList.toggle("over-clip", !!hitClip(e, c, t));
    lane.append(trackHead(t), c);
    lanes.append(lane);
    if (proc) {
      for (const v of ui.run.virtual.filter((v) => v.parent === t.id)) {
        const vl = laneEl("take", "#7f8ea0");
        const vh = document.createElement("div");
        vh.className = "lane-head";
        vh.append(Object.assign(document.createElement("span"), { className: "tname used", textContent: `${v.name} · AI` }));
        const vc = document.createElement("canvas");
        vc._draw = (g, w, h) => {
          drawGrid(g, w, h);
          const pr = proc.get(v.id);
          if (pr) drawWave(g, pr.buffer, `p:${v.id}:${ui.run.mix.lufs}`, v.offset, v.offset, v.offset + pr.buffer.duration, 4, h - 8, "rgba(150,170,190,0.7)", "transparent");
        };
        vc.onpointerdown = (e) => laneSeek(e, vc);
        vl.append(vh, vc);
        lanes.append(vl);
      }
    }
    if (t.showTakes) {
      for (const k of t.takes) {
        const tl = laneEl("take", t.color);
        const tc = document.createElement("canvas");
        tc._draw = (g, w, h) => {
          drawGrid(g, w, h);
          const buf = audio.get(k.id);
          if (!buf) return;
          drawWave(g, buf, k.id, k.at, k.at, k.at + k.duration, 4, h - 8, "rgba(160,255,248,0.32)", "transparent");
          for (const r of k.report?.regions || []) {
            g.fillStyle = r.tuned ? "rgba(18,224,208,0.55)" : r.reason.startsWith("low") ? "rgba(255,59,74,0.6)" : "rgba(255,255,255,0.15)";
            g.fillRect(t2x(k.at + r.start), 0, t2x(k.at + r.end) - t2x(k.at + r.start), 3);
          }
          for (const cl of t.clips.filter((x) => x.takeId === k.id)) {
            g.save();
            g.beginPath();
            g.rect(t2x(cl.start), 0, t2x(cl.end) - t2x(cl.start), h);
            g.clip();
            drawWave(g, buf, k.id, k.at + (cl.shift || 0), cl.start, cl.end, 4, h - 8, "rgba(160,255,248,0.9)", "#12e0d0");
            g.restore();
          }
        };
        tc.onpointerdown = (e) => laneSeek(e, tc);
        tl.append(takeHead(t, k), tc);
        lanes.append(tl);
      }
    }
  }
  $("emptyHint").hidden = !!(session.beats.length || session.tracks.length);
  renderLanesOnly();
}
function renderLanesOnly() {
  drawRuler();
  for (const c of document.querySelectorAll(".lane canvas")) {
    const { g, w, h } = prepCanvas(c);
    c._draw?.(g, w, h);
  }
  drawPlayhead();
  updateHScroll();
}
// Timeline scroll bar: the thumb is the visible window over the whole song.
const scrollSpan = () => Math.max(projectEnd() + 4, ui.view.start + viewWidth() / ui.view.pps, 30);
function updateHScroll() {
  const bar = $("hscroll"), th = $("hthumb");
  const W = bar.clientWidth, total = scrollSpan(), vis = viewWidth() / ui.view.pps;
  th.style.width = `${Math.max(24, (vis / total) * W)}px`;
  th.style.left = `${Math.min(W - th.offsetWidth, (ui.view.start / total) * W)}px`;
}
function scrollViewTo(t) {
  ui.view.start = Math.max(0, t);
  ui.view.fit = false;
  renderLanesOnly();
}

function drawTrack(g, w, h, t, proc) {
  drawGrid(g, w, h);
  if (proc) {
    drawWave(g, proc.buffer, `p:${t.id}:${ui.run.mix.lufs}`, proc.offset ?? engineOffset(t), engineOffset(t), engineOffset(t) + proc.buffer.duration, 6, h - 12, "rgba(160,255,248,0.95)", "#12e0d0");
    const fpx = (proc.hop / FS) * ui.view.pps;
    const x0 = t2x(engineOffset(t));
    g.strokeStyle = "#ffb35c";
    g.lineWidth = 1.4;
    g.beginPath();
    proc.rideCurve.forEach((db, i) => {
      const x = x0 + i * fpx;
      if (x < -2 || x > w + 2) return;
      const y = h / 2 - (clamp(db, -20, 12) / 20) * (h / 2) * 0.85;
      g.lineTo(x, y);
    });
    g.stroke();
    g.fillStyle = "rgba(255,59,74,0.75)";
    proc.deess.forEach((db, i) => {
      if (db < -1.5) g.fillRect(x0 + i * fpx, h - 4, Math.max(1, fpx), 4);
    });
    return;
  }
  for (const c of t.clips) {
    const take = takeOf(t, c.takeId);
    const buf = audio.get(c.takeId);
    const x0 = t2x(c.start), x1 = t2x(c.end);
    if (x1 < 0 || x0 > w) continue;
    const selc = c.id === ui.selClip;
    g.fillStyle = selc ? "rgba(255,122,26,0.12)" : "rgba(18,224,208,0.06)";
    g.fillRect(x0, 3, x1 - x0, h - 6);
    g.strokeStyle = selc ? "rgba(255,179,92,0.9)" : "rgba(18,224,208,0.28)";
    g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, 3.5, x1 - x0 - 1, h - 7);
    if (buf && take) {
      g.save();
      g.beginPath();
      g.rect(x0, 0, x1 - x0, h);
      g.clip();
      const gainScale = dbToLin(c.gainDb || 0);
      g.translate(0, (h / 2) * (1 - gainScale));
      g.scale(1, gainScale);
      drawWave(g, buf, c.takeId, take.at + (c.shift || 0), c.start, c.end, 12, h - 24, "rgba(160,255,248,0.8)", t.color);
      g.restore();
      g.fillStyle = "rgba(255,255,255,0.55)";
      g.font = "9px JetBrains Mono, monospace";
      g.fillText(`${take.name}${c.gainDb ? ` ${c.gainDb > 0 ? "+" : ""}${c.gainDb}dB` : ""}`, Math.max(x0, 0) + 5, 13);
    }
    // Fade ramps
    g.strokeStyle = "rgba(255,179,92,0.8)";
    g.beginPath();
    g.moveTo(x0, h - 4);
    g.lineTo(t2x(c.start + (c.fadeIn || 0)), 4);
    g.moveTo(t2x(c.end - (c.fadeOut || 0)), 4);
    g.lineTo(x1, h - 4);
    g.stroke();
  }
}
const engineOffset = (t) => S.trackStart(t);

// ---------------------------------------------------------------- pointer editing
function laneSeek(e, el) {
  const r = el.getBoundingClientRect();
  ui.selClip = null;
  seek(x2t(e.clientX - r.left));
  updateClipInsp();
}
const TOOL_HELP = {
  move: "<b>Move tool</b> · drag a clip left or right. Snaps to the beat grid (hold Alt for free placement). Click empty space to move the playhead.",
  trim: "<b>Trim tool</b> · grab near the start or end of a clip and drag to shorten or lengthen it. Nothing is deleted.",
  cut: "<b>Cut tool</b> · click inside a clip to cut it in two right there. Then comp each piece from the take lanes.",
  fade: "<b>Fade tool</b> · drag on the left half of a clip for a fade-in, on the right half for a fade-out.",
};
function setTool(tool) {
  ui.tool = tool;
  document.querySelectorAll("#toolSeg button").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
  $("timeline").dataset.tool = tool;
  showHint();
}
/** Which clip is under the pointer, and what the current tool will do to it. */
function hitClip(e, canvas, t) {
  if (ui.ab === "B" && ui.run && !ui.stale) return null;
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const c = t.clips.find((cl) => x >= t2x(cl.start) - 2 && x <= t2x(cl.end) + 2);
  if (!c) return null;
  const mid = (t2x(c.start) + t2x(c.end)) / 2;
  const mode = { move: "move", cut: "cut", trim: x < mid ? "trimL" : "trimR", fade: x < mid ? "fadeIn" : "fadeOut" }[ui.tool || "move"];
  return { c, mode, x };
}
function clipPointer(e, canvas, t) {
  const hit = hitClip(e, canvas, t);
  ui.selTrack = t.id;
  if (!hit) {
    laneSeek(e, canvas);
    document.querySelectorAll(".lane.vocal").forEach((l) => l.classList.toggle("sel", l.contains(canvas)));
    return;
  }
  const r = canvas.getBoundingClientRect();
  const startX = e.clientX;
  if (hit.mode === "cut") {
    const at = S_().snap && !e.altKey && bpm() ? snapTime(x2t(hit.x), bpm(), 4) : x2t(hit.x);
    edit("Cut clip", () => {
      const right = S.splitClip(t, hit.c.id, at);
      ui.selClip = right?.id || hit.c.id;
    });
    return;
  }
  const orig = { ...hit.c };
  const take = takeOf(t, hit.c.takeId);
  let moved = false;
  ui.selClip = hit.c.id;
  canvas.setPointerCapture(e.pointerId);
  const snap = (v, ev) => (S_().snap && !ev.altKey && bpm() ? snapTime(v, bpm(), 4) : v);
  canvas.onpointermove = (ev) => {
    const dt = (ev.clientX - startX) / ui.view.pps;
    if (!moved && Math.abs(ev.clientX - startX) < 3) return;
    if (!moved) history.push(session, { move: "Move clip", trimL: "Trim clip", trimR: "Trim clip", fadeIn: "Fade in", fadeOut: "Fade out" }[hit.mode]);
    moved = true;
    const c = hit.c;
    const minLen = 0.05;
    if (hit.mode === "move") {
      const ns = Math.max(0, snap(orig.start + dt, ev));
      const d = ns - orig.start;
      c.start = orig.start + d;
      c.end = orig.end + d;
      c.shift = (orig.shift || 0) + d;
    } else if (hit.mode === "trimL") {
      const lo = take.at + (orig.shift || 0);
      c.start = clamp(snap(orig.start + dt, ev), Math.max(0, lo), orig.end - minLen);
    } else if (hit.mode === "trimR") {
      const hi = take.at + (orig.shift || 0) + take.duration;
      c.end = clamp(snap(orig.end + dt, ev), orig.start + minLen, hi);
    } else if (hit.mode === "fadeIn") {
      c.fadeIn = clamp(x2t(ev.clientX - r.left) - c.start, 0, (c.end - c.start) / 2);
    } else if (hit.mode === "fadeOut") {
      c.fadeOut = clamp(c.end - x2t(ev.clientX - r.left), 0, (c.end - c.start) / 2);
    }
    const { g, w, h } = prepCanvas(canvas);
    drawTrack(g, w, h, t, null);
  };
  canvas.onpointerup = () => {
    canvas.onpointermove = (ev) => canvas.classList.toggle("over-clip", !!hitClip(ev, canvas, t));
    canvas.onpointerup = null;
    if (moved) {
      if (hit.mode === "move") {
        // Overlap rule: the moved clip wins.
        const c = hit.c;
        t.clips = t.clips.filter((x) => x !== c);
        S.carve(t, c.start, c.end);
        t.clips.push(c);
        t.clips.sort((a, b) => a.start - b.start);
      }
      markStale();
      save();
      updateUndo();
    } else {
      seek(x2t(startX - r.left));
    }
    renderAll();
  };
}
function updateClipInsp() {
  const t = trackById(ui.selTrack);
  const c = t?.clips.find((x) => x.id === ui.selClip);
  $("clipInsp").hidden = !c;
  if (!c) return;
  const tm = t.timingMs || 0;
  $("trackTimingOut").textContent = `${tm > 0 ? "+" : ""}${tm} ms`;
  $("clipGain").value = c.gainDb || 0;
  $("clipGainOut").textContent = `${(c.gainDb || 0).toFixed(1)} dB`;
  $("clipFadeIn").value = Math.round((c.fadeIn || 0) * 1000);
  $("clipFadeOut").value = Math.round((c.fadeOut || 0) * 1000);
}
/** Slide every clip's audio on the selected track earlier (−) or later (+); clip edges stay put. */
function nudgeTrackTiming(ms) {
  const t = trackById(ui.selTrack);
  if (!t) return toast("Select a clip on the track first.");
  history.push(session, `${t.name} timing`, `timing:${t.id}`);
  for (const c of t.clips) c.shift = (c.shift || 0) + ms / 1000;
  t.timingMs = Math.round(((t.timingMs || 0) + ms) * 10) / 10;
  markStale();
  save();
  renderLanesOnly();
  updateClipInsp();
  updateUndo();
  status(`${t.name}: audio ${t.timingMs > 0 ? "+" : ""}${t.timingMs} ms ${t.timingMs < 0 ? "earlier" : "later"} than recorded. Press Space to check it against the beat.`);
}
function splitAtPlayhead() {
  const t = trackById(ui.selTrack);
  if (!t) return toast("Select a track first.");
  const c = S.clipAt(t, currentPos());
  if (!c) return toast("Put the playhead over a clip on the selected track.");
  edit("Split clip", () => {
    const right = S.splitClip(t, c.id, currentPos());
    ui.selClip = right?.id || null;
  });
}
function deleteClip() {
  const t = trackById(ui.selTrack);
  if (!t || !ui.selClip) return toast("Click a clip to select it first.");
  edit("Delete clip", () => {
    t.clips = t.clips.filter((c) => c.id !== ui.selClip);
    ui.selClip = null;
  });
}

// ---------------------------------------------------------------- mixer tab
function renderStrips() {
  const el = $("strips");
  el.innerHTML = "";
  const strip = (id, name, color, vol, pan, onVol, onPan, extra) => {
    const s = document.createElement("div");
    s.className = `strip${id === "master" ? " master" : ""}`;
    s.dataset.id = id;
    s.style.borderTopColor = color;
    const n = Object.assign(document.createElement("div"), { className: "sname", textContent: name, title: name });
    const fr = document.createElement("div");
    fr.className = "fader-row";
    const f = Object.assign(document.createElement("input"), { type: "range", className: "fader", min: -60, max: 6, step: 0.5, value: vol, title: `${name} volume: up = louder. Double-click to reset to 0 dB.` });
    const m = document.createElement("div");
    m.className = "smeter";
    m.append(document.createElement("b"));
    fr.append(f, m);
    const o = document.createElement("output");
    const show = () => (o.textContent = +f.value <= -60 ? "−∞" : `${(+f.value).toFixed(1)}`);
    show();
    f.oninput = () => {
      onVol(+f.value);
      show();
    };
    f.ondblclick = () => {
      f.value = 0;
      f.oninput();
    };
    s.append(n, fr, o);
    if (onPan) {
      const pl = document.createElement("label");
      const pv = document.createElement("span");
      const panTxt = (v) => (Math.abs(v) < 0.03 ? "Pan · centre" : `Pan · ${v < 0 ? "L" : "R"} ${Math.round(Math.abs(v) * 100)}`);
      pv.textContent = panTxt(pan);
      pl.title = "Pan: where the track sits between the left and right speaker. Double-click to centre.";
      pl.append(pv);
      const p = Object.assign(document.createElement("input"), { type: "range", min: -1, max: 1, step: 0.05, value: pan });
      p.oninput = () => {
        onPan(+p.value);
        pv.textContent = panTxt(+p.value);
      };
      p.ondblclick = () => {
        p.value = 0;
        p.oninput();
      };
      pl.append(p);
      s.append(pl);
    }
    extra?.(s);
    el.append(s);
  };
  const coalesce = (label, key, fn) => {
    history.push(session, label, key);
    fn();
    markStale();
    save();
    applyMixer();
    updateUndo();
  };
  for (const t of session.tracks) {
    strip(t.id, t.name, t.color, t.volumeDb, t.pan || 0,
      (v) => coalesce(`${t.name} volume`, `vol:${t.id}`, () => (t.volumeDb = v)),
      (v) => coalesce(`${t.name} pan`, `pan:${t.id}`, () => (t.pan = v)),
      (s) => {
        for (const [k, label, help] of [["revSend", "Reverb", "Reverb: how much room sound this track gets. 100% = the engine's normal amount."], ["dlySend", "Echo", "Echo: how much beat-timed delay this track gets. 100% = the engine's normal amount."]]) {
          const l = document.createElement("label");
          const v = document.createElement("span");
          v.textContent = `${label} · ${Math.round((t[k] ?? 1) * 100)}%`;
          l.title = help;
          l.append(v);
          const r = Object.assign(document.createElement("input"), { type: "range", min: 0, max: 2, step: 0.05, value: t[k] ?? 1 });
          r.oninput = () => {
            coalesce(`${t.name} ${label}`, `${k}:${t.id}`, () => (t[k] = +r.value));
            v.textContent = `${label} · ${Math.round(+r.value * 100)}%`;
          };
          l.append(r);
          s.append(l);
        }
        const row = document.createElement("div");
        row.className = "row";
        row.append(
          tog("M", "m", "Mute: silence this track", t.mute, () => edit("Mute", () => (t.mute = !t.mute)) || applyMixer()),
          tog("S", "s", "Solo: hear only soloed tracks", t.solo, () => edit("Solo", () => (t.solo = !t.solo)) || applyMixer()),
        );
        s.append(row);
      });
  }
  for (const b of session.beats) {
    strip(b.id, b.name, S.STEM_KINDS[b.kind]?.color || "#ff7a1a", b.volumeDb || 0, b.pan || 0,
      (v) => coalesce(`${b.name} volume`, `vol:${b.id}`, () => (b.volumeDb = v)),
      b.kind === "bass" ? null : (v) => coalesce(`${b.name} pan`, `pan:${b.id}`, () => (b.pan = v)),
      (s) => {
        s.append(Object.assign(document.createElement("label"), { textContent: S.STEM_KINDS[b.kind]?.label || "Beat", title: "Stem role (change it on the lane)" }));
        const row = document.createElement("div");
        row.className = "row";
        row.append(
          tog("M", "m", "Mute this stem", b.mute, () => edit("Mute", () => (b.mute = !b.mute)) || applyMixer()),
          tog("S", "s", "Solo: hear only soloed lanes", b.solo, () => edit("Solo", () => (b.solo = !b.solo)) || applyMixer()),
        );
        s.append(row);
      });
  }
  strip("master", "Master", "#ff7a1a", session.master.volumeDb || 0, 0, (v) => coalesce("Master volume", "vol:master", () => (session.master.volumeDb = v)), null, (s) => {
    s.append(Object.assign(document.createElement("label"), { textContent: "Limiter −1 dB", title: "Live safety limiter; exports are mastered to the loudness target with a true-peak limiter" }));
  });
}

// ---------------------------------------------------------------- presets, guide, hints
const MIX_PRESETS = [
  { name: "Rap · Upfront", desc: "Vocal on top, short plate, dotted echo", mode: "rap", s: { targetLufs: -14, balance: 2, reverb: "plate", delayDiv: "1/8.", space: 0.7, tuneStyle: "natural" } },
  { name: "Rap · Spacey", desc: "Big hall, quarter-note echo, melodic", mode: "rap", s: { targetLufs: -14, balance: 0, reverb: "hall", delayDiv: "1/4", space: 1.4, tuneStyle: "tight" } },
  { name: "Rap · Club loud", desc: "Mastered loud (−9), tight room", mode: "rap", s: { targetLufs: -9, balance: 1, reverb: "room", delayDiv: "1/8.", space: 0.8, tuneStyle: "natural" } },
  { name: "Rap · Hard-tune", desc: "Robot tune, plate, wide echo", mode: "rap", s: { targetLufs: -14, balance: 1, reverb: "plate", delayDiv: "1/8.", space: 1, tuneStyle: "hard" } },
  { name: "VO · Dry & clear", desc: "Voice-over: almost no room, no echo", mode: "vo", s: { targetLufs: -16, balance: 0, reverb: "booth", delayDiv: "off", space: 0.5, tuneStyle: "off" } },
  { name: "Podcast", desc: "Dry, even, −16 LUFS standard", mode: "vo", s: { targetLufs: -16, balance: 0, reverb: "booth", delayDiv: "off", space: 0.25, tuneStyle: "off" } },
];
function renderPresets() {
  const el = $("mixPresets");
  el.innerHTML = "";
  for (const pr of MIX_PRESETS) {
    const b = document.createElement("button");
    b.innerHTML = `<b>${pr.name}</b><small>${pr.desc}</small>`;
    b.title = `${pr.name}: ${pr.desc}. Sets mode, loudness, vocal/beat balance, reverb, echo and tune style.`;
    b.onclick = () => {
      edit(`Preset: ${pr.name}`, () => {
        session.mode = pr.mode;
        Object.assign(S_(), pr.s);
      });
      bindSettingsToUi();
      status(`Preset "${pr.name}" set: ${pr.desc}. Press Automix to hear it.`);
    };
    el.append(b);
  }
}
function showHint(text) {
  $("hint").innerHTML = text || TOOL_HELP[ui.tool || "move"];
}
function openGuide() {
  $("guide").hidden = false;
}
const closeGuide = () => ($("guide").hidden = true);

// Live recording view: banner, level, and the waveform drawing in as you sing.
const recPeaks = [];
const REC_BLOCK = 512;
function addRecPeaks(chunk) {
  recPeaks.carry ??= { n: 0, m: 0 };
  const c = recPeaks.carry;
  for (let i = 0; i < chunk.length; i++) {
    const a = Math.abs(chunk[i]);
    if (a > c.m) c.m = a;
    if (++c.n === REC_BLOCK) {
      recPeaks.push(c.m);
      c.n = 0;
      c.m = 0;
    }
  }
}
function resetRecView() {
  recPeaks.length = 0;
  recPeaks.carry = { n: 0, m: 0 };
}
let lastRecDraw = 0;
function updateRecView(pos) {
  const banner = $("recBanner");
  const rec = ui.recording;
  if (!rec) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const t = trackById(rec.trackId);
  const startPos = rec.punch ? rec.punch.in : rec.from;
  const counting = pos < startPos - 0.005;
  banner.classList.toggle("countin", counting);
  if (counting) {
    const beatsLeft = bpm() ? Math.ceil((startPos - pos) / (60 / bpm())) : Math.ceil(startPos - pos);
    $("recText").textContent = rec.punch ? "PRE-ROLL" : "COUNT-IN";
    $("recSub").textContent = `${t?.name || ""} · recording starts in ${beatsLeft}${rec.punch ? ` · punch ${fmtTime(rec.punch.in)} → ${fmtTime(rec.punch.out)}` : ""}`;
  } else {
    const inPunch = !rec.punch || pos <= rec.punch.out;
    $("recText").textContent = inPunch ? "● RECORDING" : "POST-ROLL";
    $("recSub").textContent = `${t?.name || ""} · ${fmtTime(Math.max(0, recPeaks.length * REC_BLOCK / FS))} recorded${rec.loop ? ` · loop pass ${Math.floor((pos - rec.loop.start) / rec.loop.L + 1e-6) + 1}` : ""}${rec.punch ? ` · stops at ${fmtTime(rec.stopAt)}` : " · press R or Space to stop"}`;
  }
  $("recLvl").style.width = pct(mic.peak);
  const now = performance.now();
  if (now - lastRecDraw > 60) {
    lastRecDraw = now;
    const canvas = [...document.querySelectorAll(".lane.vocal canvas")].find((c) => c._track?.id === rec.trackId);
    if (canvas) {
      const { g, w, h } = prepCanvas(canvas);
      drawTrack(g, w, h, t, null);
      // Red live take, positioned where the audio will land on the timeline.
      const at0 = rec.punch ? rec.punch.in - PUNCH_XF : rec.from;
      const span = REC_BLOCK / FS;
      const x0 = t2x(at0);
      const xEnd = t2x(at0 + recPeaks.length * span);
      g.fillStyle = "rgba(255,59,74,0.14)";
      g.fillRect(x0, 2, Math.max(2, xEnd - x0), h - 4);
      g.fillStyle = "rgba(255,90,100,0.95)";
      g.shadowColor = "#ff3b4a";
      g.shadowBlur = 8;
      const mid = h / 2;
      g.beginPath();
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, xEnd); x++) {
        const a = Math.floor(x2t(x) - at0 >= 0 ? (x2t(x) - at0) / span : 0);
        const b = Math.max(a + 1, Math.floor((x2t(x + 1) - at0) / span));
        let m = 0;
        for (let i = a; i < Math.min(b, recPeaks.length); i++) m = Math.max(m, recPeaks[i]);
        const hh = Math.min(1, m * 1.4) * mid * 0.9;
        g.rect(x, mid - hh, 1, Math.max(1, hh * 2));
      }
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = "#fff";
      g.font = "600 10px JetBrains Mono, monospace";
      g.fillText("● REC", Math.max(4, x0 + 4), 14);
    }
  }
}

// ---------------------------------------------------------------- pitch view
function drawPitch() {
  const c = $("pitchGraph");
  const w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  const { g } = prepCanvas(c);
  const t = trackById(ui.selTrack);
  $("pitchLane").textContent = t ? t.name : "select a track";
  const proc = t && ui.run?.processed.get(t.id);
  if (!proc?.pitch) {
    g.fillStyle = "#4b5560";
    g.font = "12px Space Grotesk";
    g.fillText(t ? "Run Automix to see the pitch analysis." : "Click a track header.", 14, 24);
    return;
  }
  const { f0, f0Out } = proc.pitch;
  const midi = (f) => 69 + 12 * Math.log2(f / 440);
  let lo = Infinity, hi = -Infinity;
  for (const f of f0) if (f) {
    lo = Math.min(lo, midi(f));
    hi = Math.max(hi, midi(f));
  }
  if (!Number.isFinite(lo)) return;
  lo = Math.floor(lo) - 2;
  hi = Math.ceil(hi) + 2;
  const key = ui.key;
  const allowed = key ? new Set(SCALES[key.scale].steps.map((s) => (s + key.tonic) % 12)) : null;
  const y = (m) => h - ((m - lo) / (hi - lo)) * h;
  g.font = "9px JetBrains Mono";
  for (let m = lo; m <= hi; m++) {
    const pc = ((m % 12) + 12) % 12;
    const inKey = !allowed || allowed.has(pc);
    g.fillStyle = inKey ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.02)";
    g.fillRect(0, y(m + 0.5), w, Math.max(1, y(m - 0.5) - y(m + 0.5) - 1));
    if (inKey && (hi - lo < 30 || pc === 0)) {
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.fillText(`${NOTE_NAMES[pc]}${Math.floor(m / 12) - 1}`, 4, y(m) + 3);
    }
  }
  const hopSec = proc.hop / FS;
  const span = Math.min(f0.length, Math.round(8 / hopSec));
  const rel = Math.round((currentPos() - engineOffset(t) - 2) / hopSec);
  const first = Math.max(0, Math.min(f0.length - span, rel));
  const px = (i) => 28 + ((i - first) / span) * (w - 32);
  const plot = (arr, color, width) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    let pen = false;
    for (let i = first; i < first + span; i++) {
      if (!arr[i]) {
        pen = false;
        continue;
      }
      if (!pen) g.moveTo(px(i), y(midi(arr[i])));
      else g.lineTo(px(i), y(midi(arr[i])));
      pen = true;
    }
    g.stroke();
  };
  plot(f0, "#3d8f89", 1.2);
  g.shadowColor = "#ff7a1a";
  g.shadowBlur = 8;
  plot(f0Out, "#ff7a1a", 1.8);
  g.shadowBlur = 0;
}

// ---------------------------------------------------------------- report
function renderReport() {
  const el = $("report");
  if (!ui.run) return;
  const list = (arr) => `<ul>${arr.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
  let html = ui.stale ? '<p class="stale">Takes or settings changed since this mix. Run Automix again.</p>' : "";
  html += `<section class="master"><h4>Mix bus · ${MODES[session.mode].label}${ui.key ? ` · ${esc(keyLabel(ui.key))}` : ""}</h4>${list(ui.run.mix.notes)}</section>`;
  for (const v of ui.run.mixInput) {
    html += `<section><h4>${esc(v.track.name)} · ${esc((ROLES[v.track.role] || ROLES.lead).label)}</h4>${list(v.processed.report)}</section>`;
  }
  const p = ui.profile;
  if (p) {
    const voice = p.f0 ? `${Math.round(p.f0)} Hz average pitch (${p.f0 < 155 ? "low/baritone" : p.f0 < 240 ? "mid/tenor" : "high"} range)` : "still learning";
    html += `<section class="learn"><h4>What the engine has learned</h4>${list([
      `Sessions analysed: ${p.sessions}`,
      `Your voice: ${voice}`,
      p.sibCentre ? `Your sibilance sits at ${(p.sibCentre / 1000).toFixed(1)} kHz; short takes borrow this profile for EQ` : "Sibilance profile: learning",
      p.key ? `Last confident key: ${keyLabel({ ...p.key })}` : "Key memory: none yet",
    ])}</section>`;
  }
  el.innerHTML = html;
}

// ---------------------------------------------------------------- lyrics + prompter
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  let n = (w.match(/[aeiouy]+/g) || []).length;
  if (w.length > 2 && w.endsWith("e") && !w.endsWith("le") && n > 1) n--;
  return Math.max(1, n);
}
const BAR_TAG = /^\s*\[bar\s*(\d+)\]\s*/i;
function parseLyrics() {
  return session.lyrics.split("\n").map((raw) => {
    const m = raw.match(BAR_TAG);
    return { bar: m ? +m[1] : null, text: raw.replace(BAR_TAG, "") };
  });
}
function updateGutter() {
  $("gutter").textContent = parseLyrics()
    .map((l) => l.text.split(/\s+/).reduce((a, w) => a + syllables(w), 0) || "")
    .join("\n");
}
let prompterY = 0;
let prompterLast = 0;
function openPrompter() {
  const lines = parseLyrics();
  $("prompterText").innerHTML = lines.length && session.lyrics.trim()
    ? lines.map((l, i) => `<div class="pl" data-i="${i}">${l.bar ? `<small>BAR ${l.bar}</small>` : ""}${esc(l.text) || "&nbsp;"}</div>`).join("")
    : "(No lyrics yet — write them in the Lyrics tab.)";
  $("prompterText").querySelectorAll(".pl").forEach((d) => (d.onclick = () => (ui.lyricLine = +d.dataset.i)));
  $("prompter").hidden = false;
  $("prompterScroll").scrollTop = 0;
  prompterY = 0;
  prompterLast = performance.now();
  if (!ui.playing) {
    requestAnimationFrame(function loop() {
      if ($("prompter").hidden) return;
      prompterTick(currentPos());
      requestAnimationFrame(loop);
    });
  }
}
function prompterTick(pos) {
  if ($("prompter").hidden) return;
  const lines = parseLyrics();
  const synced = bpm() && lines.some((l) => l.bar);
  if (synced) {
    const bar = Math.floor(Math.max(0, pos) / barSeconds(bpm())) + 1;
    let cur = 0;
    lines.forEach((l, i) => {
      if (l.bar && l.bar <= bar) cur = i;
    });
    ui.lyricLine = cur;
  }
  const els = $("prompterText").querySelectorAll(".pl");
  els.forEach((d, i) => d.classList.toggle("on", i === ui.lyricLine));
  const el = $("prompterScroll");
  const target = els[ui.lyricLine];
  if (target && (synced || ui.recording)) {
    const want = target.offsetTop - el.clientHeight / 2 + target.clientHeight / 2;
    el.scrollTop += (want - el.scrollTop) * 0.15;
    prompterY = el.scrollTop;
  } else {
    const now = performance.now();
    prompterY += ((S_().scroll || 0) * (now - prompterLast)) / 1000;
    prompterLast = now;
    el.scrollTop = prompterY;
  }
}
const closePrompter = () => ($("prompter").hidden = true);

// ---------------------------------------------------------------- sessions menu
async function renderSessionMenu() {
  const m = $("sessionMenu");
  const all = await S.listSessions();
  const active = all.filter((s) => !s.deletedAt);
  const trash = all.filter((s) => s.deletedAt);
  m.innerHTML = '<div class="mh">Sessions</div>';
  for (const s of active) {
    const b = document.createElement("button");
    b.className = s.id === session.id ? "cur" : "";
    b.innerHTML = `<span>${esc(s.name)}</span><small>${new Date(s.updated).toLocaleDateString()}</small>`;
    b.onclick = () => openSession(s.id);
    m.append(b);
  }
  m.append(document.createElement("hr"));
  const act = (label, fn) => {
    const b = Object.assign(document.createElement("button"), { textContent: label });
    b.onclick = () => guardBusy("changing sessions") || fn();
    m.append(b);
  };
  act("+ New session", async () => {
    const name = prompt("Session name", `Session ${active.length + 1}`);
    if (!name) return;
    await S.saveSession(session);
    await switchTo(S.newSession(name));
  });
  act("Rename…", () => {
    const name = prompt("Rename session", session.name);
    if (name) edit("Rename session", () => (session.name = name), { audioChange: false });
    $("sessionName").textContent = session.name;
    m.hidden = true;
  });
  act("Open session package…", () => $("filePackage").click());
  act("Duplicate", async () => {
    await S.saveSession(session);
    await switchTo(S.duplicateSession(session));
    toast("Session duplicated.");
  });
  act("Delete (to trash)", async () => {
    if (!confirm(`Move "${session.name}" to the trash? It stays recoverable for 30 days.`)) return;
    await S.trashSession(session.id);
    const rest = (await S.listSessions()).filter((s) => !s.deletedAt && s.id !== session.id);
    if (rest.length) await openSession(rest[0].id);
    else await switchTo(S.newSession("Session 1"));
  });
  if (trash.length) {
    m.append(document.createElement("hr"));
    m.append(Object.assign(document.createElement("div"), { className: "mh", textContent: "Trash (30 days)" }));
    for (const s of trash) {
      const b = document.createElement("button");
      b.innerHTML = `<span>${esc(s.name)}</span><small>Restore</small>`;
      b.onclick = async () => {
        await S.trashSession(s.id, false);
        renderSessionMenu();
      };
      m.append(b);
    }
  }
}
async function openSession(id) {
  if (guardBusy("switching sessions")) return;
  const s = await S.loadSession(id);
  if (!s) return toast("That session couldn't be loaded.");
  await S.saveSession(session);
  await switchTo(s);
}
async function switchTo(s) {
  if (guardBusy("switching sessions")) return;
  stopPlayback(false);
  session = s;
  history.undoStack = [];
  history.redoStack = [];
  ui.run = null;
  ui.master = null;
  ui.stale = false;
  ui.selClip = null;
  ui.selTrack = s.tracks[0]?.id || null;
  ui.playhead = 0;
  await loadSessionAudio();
  await S.saveSession(session);
  $("sessionMenu").hidden = true;
  bindSettingsToUi();
  renderAll();
  fitView();
  updateUndo();
  $("report").innerHTML = '<p class="muted">Run <b>Automix</b> and the engine logs every decision it makes, with the numbers.</p>';
  ui.stageState = {};
  paintChain();
  status(`Opened "${s.name}".`);
}
async function loadSessionAudio() {
  for (const b of session.beats) await loadAudio(b.id);
  for (const t of session.tracks) for (const k of t.takes) await loadAudio(k.id);
}

// ---------------------------------------------------------------- render + controls
function renderAll() {
  $("sessionName").textContent = session.name;
  $("btnLoop").classList.toggle("on", session.loop.on);
  $("btnClick").classList.toggle("on", !!S_().click);
  $("btnPunch").classList.toggle("on", !!session.punch?.on);
  $("btnSnap").classList.toggle("on", !!S_().snap);
  renderLanes();
  // Side panels only rebuild while on screen; a hidden one is rebuilt when its tab opens.
  for (const [name, fn] of Object.entries(PANELS)) {
    if (document.querySelector(`.tab.on[data-panel="${name}"]`)) fn();
    else dirtyPanels.add(name);
  }
  updateClipInsp();
  updateChips();
  applyMixer();
}
const PANELS = { mixer: renderStrips, clean: renderCleanTab, song: renderSong };
const dirtyPanels = new Set();
function showTab(name) {
  if (dirtyPanels.delete(name)) PANELS[name]();
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((p) => p.classList.toggle("on", p.dataset.panel === name));
  requestAnimationFrame(() => {
    document.querySelectorAll(`.tab[data-panel="${name}"] .seg`).forEach(moveThumb);
    if (name === "tune") {
      drawPitch();
      checkBackend();
      const t = trackById(ui.selTrack);
      renderStudioReport(t && t.takes.find((k) => k.tuned && t.clips.some((c) => c.takeId === k.id)));
    }
  });
}
function updateChips() {
  const s = S_();
  const k = ui.key && s.key === "auto" ? keyLabel(ui.key) : s.key === "auto" ? "Key auto" : `${NOTE_NAMES[+s.key]} ${SCALES[s.scale].label.toLowerCase()}`;
  $("chipKey").textContent = k;
  $("chipKey").classList.toggle("hot", s.tuneStyle !== "off" && s.stages.tune);
}
function setMode(mode, user = false) {
  const s = S_();
  const apply = () => {
    session.mode = mode;
    if (user && mode === "vo") {
      if (s.targetLufs === -14) s.targetLufs = -16;
      if (s.tuneStyle === "natural") s.tuneStyle = "off";
    } else if (user && mode === "rap") {
      if (s.targetLufs === -16) s.targetLufs = -14;
      if (s.tuneStyle === "off") s.tuneStyle = "natural";
    }
  };
  if (user) edit(`Mode: ${mode}`, apply, { redraw: false });
  else apply();
  setSeg("modeSeg", "mode", mode);
  $("target").value = String(s.targetLufs);
  setSeg("styleSeg", "style", s.tuneStyle);
  updateChips();
}

/** Push the current session's settings into every control. */
function bindSettingsToUi() {
  const s = S_();
  const set = (id, v) => ($(id).value = v);
  set("bpm", s.bpm || 0);
  set("countIn", String(s.countIn ?? 1));
  set("preRoll", String(s.preRoll ?? 1));
  set("masterTone", s.masterTone || "neutral");
  set("ceiling", String(s.ceiling ?? -1));
  set("width", s.width ?? 1);
  $("widthOut").textContent = `${Math.round((s.width ?? 1) * 100)}%`;
  const st = s.studio;
  set("stRetune", st.retuneMs);
  $("stRetuneOut").textContent = st.retuneMs === 0 ? "0 ms · robot" : `${st.retuneMs} ms`;
  set("stVib", st.vibrato);
  $("stVibOut").textContent = `${Math.round(st.vibrato * 100)}%`;
  set("stAmt", st.amount);
  $("stAmtOut").textContent = `${Math.round(st.amount * 100)}%`;
  set("stConf", st.minConf);
  $("stConfOut").textContent = `${Math.round(st.minConf * 100)}%`;
  $("stFormant").checked = !!st.formant;
  set("backendUrl", s.backendUrl);
  set("clickLevel", s.clickLevel ?? 0.6);
  metro.level = s.clickLevel ?? 0.6;
  set("inGain", s.inputGainDb ?? 0);
  $("inGainOut").textContent = `${s.inputGainDb ?? 0} dB`;
  set("latency", s.latencyMs || 0);
  $("latencyOut").textContent = `${s.latencyMs || 0} ms`;
  set("balance", s.balance || 0);
  $("balanceOut").textContent = `${s.balance > 0 ? "+" : ""}${s.balance || 0} dB`;
  set("space", s.space ?? 1);
  $("spaceOut").textContent = `${Math.round((s.space ?? 1) * 100)}%`;
  set("target", String(s.targetLufs));
  set("reverbSel", s.reverb || "auto");
  set("delaySel", s.delayDiv || "auto");
  set("keySel", String(s.key));
  set("scaleSel", s.scale);
  $("scaleSel").disabled = s.key === "auto";
  $("alignDoubles").checked = s.alignDoubles !== false;
  set("tight", s.alignTight ?? 0.9);
  $("tightOut").textContent = `${Math.round((s.alignTight ?? 0.9) * 100)}%`;
  set("scrollSpeed", s.scroll ?? 18);
  $("usePrompter").checked = !!s.prompter;
  $("transcribe").checked = !!s.transcribe;
  set("exportRate", String(s.exportRate || 48000));
  $("lyrics").value = session.lyrics;
  updateGutter();
  setMode(session.mode);
  paintChain();
}

function bindControls() {
  const s = () => S_();
  document.querySelectorAll("#modeSeg button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode, true)));
  document.querySelectorAll("#abSeg button").forEach((b) => (b.onclick = () => setAB(b.dataset.ab)));
  document.querySelectorAll("#styleSeg button").forEach((b) => (b.onclick = () => {
    edit("Tune style", () => (s().tuneStyle = b.dataset.style), { redraw: false });
    setSeg("styleSeg", "style", s().tuneStyle);
    updateChips();
  }));
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
    showTab(b.dataset.tab);
    if (b.dataset.tab === "mixer") renderStrips();
    if (b.dataset.tab === "song") renderSong();
    if (b.dataset.tab === "clean") renderCleanTab();
  }));
  $("btnPlay").onclick = () => (ui.recording ? finishRecording() : ui.playing ? pause() : startPlayback());
  $("btnStop").onclick = stop;
  $("btnRec").onclick = toggleRecord;
  $("btnReturn").onclick = returnToZero;
  $("btnAutomix").onclick = automix;
  $("btnCancel").onclick = () => ui.cancel && (ui.cancel.cancelled = true);
  $("btnMic").onclick = ensureMic;
  $("micSelect").onchange = switchMic;
  $("monitor").onchange = (e) => toggleMonitor(e.target.checked);
  $("btnMonitor").onclick = () => toggleMonitor(!$("btnMonitor").classList.contains("on"));
  $("btnCalibrate").onclick = calibrate;
  $("btnSync").onclick = syncTest;
  $("btnLoop").onclick = () => edit(session.loop.on ? "Loop off" : "Loop on", () => (session.loop.on = !session.loop.on), { audioChange: false });
  $("btnClick").onclick = () => edit("Click", () => (s().click = !s().click), { audioChange: false });
  $("btnPunch").onclick = () => {
    if (!(session.punch.out > session.punch.in)) return toast("Set a punch range first: Shift-drag on the ruler, or drag a selection and click \"Punch ← selection\".");
    edit(session.punch.on ? "Punch off" : "Punch on", () => (session.punch.on = !session.punch.on), { audioChange: false });
  };
  $("btnPunchSel").onclick = () => {
    const { start, end } = session.loop;
    if (!(end > start)) return toast("Drag across the ruler to make a selection first.");
    edit("Punch from selection", () => {
      session.punch = { on: true, in: start, out: end };
      session.loop.on = false;
    }, { audioChange: false });
    toast(`Punch ${fmtTime(start)} → ${fmtTime(end)}. Arm a track and press R.`);
  };
  const studio = (id, key, outId, fmt) => {
    const el = $(id);
    el.oninput = () => {
      history.push(session, `Studio ${key}`, `studio:${key}`);
      S_().studio[key] = +el.value;
      $(outId).textContent = fmt(+el.value);
      save();
      updateUndo();
    };
  };
  studio("stRetune", "retuneMs", "stRetuneOut", (v) => (v === 0 ? "0 ms · robot" : `${v} ms`));
  studio("stVib", "vibrato", "stVibOut", (v) => `${Math.round(v * 100)}%`);
  studio("stAmt", "amount", "stAmtOut", (v) => `${Math.round(v * 100)}%`);
  studio("stConf", "minConf", "stConfOut", (v) => `${Math.round(v * 100)}%`);
  $("stFormant").onchange = (e) => edit("Formant preserve", () => (S_().studio.formant = e.target.checked), { audioChange: false, redraw: false });
  const preset = (label, v) => () => {
    edit(label, () => Object.assign(S_().studio, v), { audioChange: false, redraw: false });
    bindSettingsToUi();
  };
  $("btnHardPreset").onclick = preset("Hard-tune preset", { retuneMs: 0, vibrato: 0, amount: 1 });
  $("btnNaturalPreset").onclick = preset("Natural preset", { retuneMs: 60, vibrato: 0.8, amount: 1 });
  $("btnStudioTune").onclick = studioTune;
  $("clDenoise").oninput = (e) => cleanEdit("De-noise", "dn", (c) => (c.denoise = +e.target.value));
  $("clDeess").oninput = (e) => cleanEdit("De-esser", "ds", (c) => (c.deess = +e.target.value));
  $("clPop").onchange = (e) => cleanEdit("Pop filter", "pop", (c) => (c.pop = e.target.checked));
  $("clDeclick").onchange = (e) => cleanEdit("De-click", "dc", (c) => (c.declick = e.target.checked));
  document.querySelectorAll("#clBreaths button").forEach((b) => (b.onclick = () => cleanEdit("Breaths", "br", (c) => (c.breaths = b.dataset.v))));
  document.querySelectorAll("#clHum button").forEach((b) => (b.onclick = () => cleanEdit("Hum removal", "hum", (c) => (c.hum = b.dataset.v))));
  $("btnCleanPreview").onclick = previewClean;
  $("btnCleanAll").onclick = () => {
    const t = trackById(ui.selTrack);
    if (!t) return;
    edit("Cleanup on all tracks", () => session.tracks.forEach((x) => {
      x.clean = { ...cleanOf(t) };
      x.cleanReviewed = true;
    }));
    toast("Cleanup settings copied to every vocal track.");
  };
  $("masterTone").onchange = (e) => edit("Master tone", () => (S_().masterTone = e.target.value), { redraw: false });
  $("ceiling").onchange = (e) => edit("Ceiling", () => (S_().ceiling = +e.target.value), { redraw: false });
  $("backendUrl").onchange = (e) => {
    edit("Backend address", () => (S_().backendUrl = e.target.value.trim()), { audioChange: false, redraw: false });
    checkBackend();
  };
  $("preRoll").onchange = (e) => edit("Pre-roll", () => (s().preRoll = +e.target.value), { audioChange: false, redraw: false });
  $("btnSnap").onclick = () => edit("Snap", () => (s().snap = !s().snap), { audioChange: false });
  $("btnTap").onclick = () => {
    const b = tapper.tap();
    if (b) {
      edit("Tap tempo", () => (s().bpm = b), { redraw: true });
      $("bpm").value = b;
    }
    status(b ? `Tap tempo: ${b} BPM` : "Keep tapping…");
  };
  $("btnUndo").onclick = undo;
  document.querySelectorAll("#toolSeg button").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  $("btnGuide").onclick = openGuide;
  $("guideClose").onclick = closeGuide;
  $("guide").onclick = (e) => e.target.id === "guide" && closeGuide();
  $("btnRedo").onclick = redo;
  $("btnSplit").onclick = splitAtPlayhead;
  $("btnDelClip").onclick = deleteClip;
  $("btnMarker").onclick = () => addMarker();
  $("btnZoomIn").onclick = () => zoom(1.5);
  $("btnZoomOut").onclick = () => zoom(1 / 1.5);
  $("btnToStart").onclick = returnToZero;
  $("nudgeEarly").onclick = (e) => nudgeTrackTiming(e.shiftKey ? -1 : -10);
  $("nudgeLate").onclick = (e) => nudgeTrackTiming(e.shiftKey ? 1 : 10);
  {
    const bar = $("hscroll"), th = $("hthumb");
    bar.onpointerdown = (e) => {
      const W = bar.clientWidth, total = scrollSpan();
      if (e.target !== th) {
        // Click on the track: centre the view there.
        scrollViewTo(((e.clientX - bar.getBoundingClientRect().left) / W) * total - viewWidth() / ui.view.pps / 2);
        return;
      }
      const x0 = e.clientX, s0 = ui.view.start;
      bar.setPointerCapture(e.pointerId);
      bar.classList.add("drag");
      bar.onpointermove = (ev) => scrollViewTo(s0 + ((ev.clientX - x0) / W) * total);
      bar.onpointerup = () => {
        bar.onpointermove = bar.onpointerup = null;
        bar.classList.remove("drag");
      };
    };
  }
  $("btnFit").onclick = fitView;
  $("btnAddTrack").onclick = () => ($("addMenu").hidden = !$("addMenu").hidden);
  document.querySelectorAll("#addMenu button").forEach((b) => (b.onclick = () => {
    $("addMenu").hidden = true;
    edit("Add track", () => {
      const t = S.newTrack(session, b.dataset.type);
      session.tracks.push(t);
      ui.selTrack = t.id;
    }, { audioChange: false });
  }));
  $("btnSession").onclick = async () => {
    const m = $("sessionMenu");
    m.hidden = !m.hidden;
    if (!m.hidden) await renderSessionMenu();
  };
  $("btnExport").onclick = () => ($("exportMenu").hidden = !$("exportMenu").hidden);
  document.querySelectorAll("#exportMenu button").forEach((b) => (b.onclick = () => exportAs(b.dataset.exp).catch((e) => toast(`Export failed: ${e.message}`))));
  $("exportRate").onchange = (e) => edit("Export rate", () => (s().exportRate = +e.target.value), { audioChange: false, redraw: false });
  document.addEventListener("pointerdown", (e) => {
    for (const id of ["sessionMenu", "addMenu", "exportMenu"]) {
      const m = $(id);
      if (!m.hidden && !m.parentElement.contains(e.target)) m.hidden = true;
    }
  });

  const range = (id, key, outId, fmt, { audioChange = true, after } = {}) => {
    const el = $(id);
    el.oninput = () => {
      history.push(session, `${id}`, `set:${id}`);
      s()[key] = +el.value;
      if (outId) $(outId).textContent = fmt(+el.value);
      if (audioChange) markStale();
      save();
      after?.();
      updateUndo();
    };
  };
  range("balance", "balance", "balanceOut", (v) => `${v > 0 ? "+" : ""}${v} dB`);
  range("space", "space", "spaceOut", (v) => `${Math.round(v * 100)}%`, { after: applyMixer });
  range("latency", "latencyMs", "latencyOut", (v) => `${v > 0 ? "+" : ""}${v} ms`, { audioChange: false, after: updateRoundTrip });
  range("tight", "alignTight", "tightOut", (v) => `${Math.round(v * 100)}%`);
  range("width", "width", "widthOut", (v) => `${Math.round(v * 100)}%`);
  range("scrollSpeed", "scroll", null, null, { audioChange: false });
  range("clickLevel", "clickLevel", null, null, { audioChange: false, after: () => (metro.level = S_().clickLevel) });
  range("inGain", "inputGainDb", "inGainOut", (v) => (v <= -60 ? "−∞ dB" : `${v > 0 ? "+" : ""}${v} dB`), {
    audioChange: false,
    after: () => mic.gain.gain.setTargetAtTime(S_().inputGainDb <= -60 ? 0 : dbToLin(S_().inputGainDb), ctx.currentTime, 0.01),
  });
  $("bpm").onchange = (e) => edit("Tempo", () => (s().bpm = Math.max(0, +e.target.value || 0)));
  $("countIn").onchange = (e) => edit("Count-in", () => (s().countIn = +e.target.value), { audioChange: false, redraw: false });
  $("target").onchange = (e) => edit("Loudness target", () => (s().targetLufs = +e.target.value), { redraw: false });
  $("reverbSel").onchange = (e) => edit("Reverb", () => (s().reverb = e.target.value), { redraw: false });
  $("delaySel").onchange = (e) => edit("Delay", () => (s().delayDiv = e.target.value), { redraw: false });
  $("usePrompter").onchange = (e) => edit("Prompter", () => (s().prompter = e.target.checked), { audioChange: false, redraw: false });
  $("transcribe").onchange = (e) => edit("Transcription", () => (s().transcribe = e.target.checked), { audioChange: false, redraw: false });
  $("alignDoubles").onchange = (e) => edit("Align doubles", () => (s().alignDoubles = e.target.checked), { redraw: false });
  const keySel = $("keySel");
  keySel.add(new Option("Auto-detect", "auto"));
  NOTE_NAMES.forEach((n, i) => keySel.add(new Option(n, String(i))));
  const scaleSel = $("scaleSel");
  for (const [k, v] of Object.entries(SCALES)) scaleSel.add(new Option(v.label, k));
  keySel.onchange = scaleSel.onchange = () => {
    edit("Key / scale", () => {
      s().key = keySel.value;
      s().scale = scaleSel.value;
    }, { redraw: false });
    scaleSel.disabled = s().key === "auto";
    updateChips();
  };

  // Clip inspector
  const clipEdit = (label, key, fn) => {
    const t = trackById(ui.selTrack);
    const c = t?.clips.find((x) => x.id === ui.selClip);
    if (!c) return;
    history.push(session, label, `${key}:${c.id}`);
    fn(c);
    markStale();
    save();
    updateUndo();
    updateClipInsp();
    renderLanesOnly();
  };
  $("clipGain").oninput = (e) => clipEdit("Clip gain", "cg", (c) => (c.gainDb = +e.target.value));
  $("clipFadeIn").onchange = (e) => clipEdit("Fade in", "fi", (c) => (c.fadeIn = clamp(+e.target.value / 1000, 0, (c.end - c.start) / 2)));
  $("clipFadeOut").onchange = (e) => clipEdit("Fade out", "fo", (c) => (c.fadeOut = clamp(+e.target.value / 1000, 0, (c.end - c.start) / 2)));

  // Imports
  $("btnImportBeat").onclick = () => $("fileBeat").click();
  $("btnImportVocal").onclick = () => $("fileVocal").click();
  $("filePackage").onchange = (e) => {
    const [f] = e.target.files;
    e.target.value = "";
    if (f) importPackage(f).catch((err) => toast(`Couldn't open that package: ${err.message}`));
  };
  $("fileBeat").onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    importBeats(files);
  };
  $("fileVocal").onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    for (const f of files) await importVocal(f);
  };
  $("btnImportLyrics").onclick = () => $("fileLyrics").click();
  $("fileLyrics").onchange = async (e) => {
    const [f] = e.target.files;
    e.target.value = "";
    if (!f) return;
    const text = await f.text();
    edit("Import lyrics", () => (session.lyrics = text), { audioChange: false, redraw: false });
    $("lyrics").value = text;
    updateGutter();
  };
  const ly = $("lyrics");
  ly.oninput = () => {
    history.push(session, "Edit lyrics", "lyrics");
    session.lyrics = ly.value;
    updateGutter();
    save();
    updateUndo();
  };
  ly.onscroll = () => ($("gutter").scrollTop = ly.scrollTop);
  $("btnPrompter").onclick = openPrompter;
  $("prompterClose").onclick = closePrompter;

  // Ruler: click = seek, drag = set loop region, click a marker = jump.
  const ruler = $("ruler");
  ruler.onpointerdown = (e) => {
    const r = ruler.getBoundingClientRect();
    const x0 = e.clientX - r.left;
    const mk = session.markers.find((m) => Math.abs(t2x(m.t) - x0) < 8);
    let dragging = false;
    ruler.setPointerCapture(e.pointerId);
    ruler.onpointermove = (ev) => {
      const x = ev.clientX - r.left;
      if (!dragging && Math.abs(x - x0) < 5) return;
      if (!dragging) history.push(session, "Set loop");
      dragging = true;
      const snap = (t) => (bpm() && !ev.altKey ? snapTime(t, bpm(), 1) : t);
      const a = snap(Math.max(0, x2t(Math.min(x0, x))));
      const b = snap(Math.max(0, x2t(Math.max(x0, x))));
      if (e.shiftKey) {
        session.punch = { on: true, in: a, out: Math.max(b, a + 0.25) };
        $("btnPunch").classList.add("on");
      } else {
        session.loop = { on: true, start: a, end: Math.max(b, a + 0.25) };
        $("btnLoop").classList.add("on");
      }
      renderLanesOnly();
    };
    ruler.onpointerup = () => {
      ruler.onpointermove = null;
      ruler.onpointerup = null;
      if (dragging) {
        save();
        updateUndo();
        toast(e.shiftKey ? `Punch ${fmtTime(session.punch.in)} → ${fmtTime(session.punch.out)} (P toggles)` : `Loop ${fmtTime(session.loop.start)} – ${fmtTime(session.loop.end)} (L toggles · Shift-drag sets punch)`);
      } else seek(mk ? mk.t : x2t(x0));
    };
  };
  ruler.ondblclick = (e) => {
    const r = ruler.getBoundingClientRect();
    const mk = session.markers.find((m) => Math.abs(t2x(m.t) - (e.clientX - r.left)) < 8);
    if (!mk) return;
    const name = prompt("Marker name (empty deletes)", mk.name);
    if (name === null) return;
    edit(name ? "Rename marker" : "Delete marker", () => {
      if (name) mk.name = name;
      else session.markers = session.markers.filter((m) => m !== mk);
    }, { audioChange: false });
  };

  // Wheel: Ctrl/⌘ zooms around the cursor; sideways or Shift scrolls time.
  $("timeline").addEventListener("wheel", (e) => {
    const r = $("ruler").getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, x2t(e.clientX - r.left));
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      e.preventDefault();
      ui.view.start = Math.max(0, ui.view.start + (e.shiftKey ? e.deltaY : e.deltaX) / ui.view.pps);
      ui.view.fit = false;
      renderLanesOnly();
    }
  }, { passive: false });

  // Drag & drop
  const tl = $("timeline");
  tl.ondragover = (e) => {
    e.preventDefault();
    tl.classList.add("drag");
  };
  tl.ondragleave = () => tl.classList.remove("drag");
  tl.ondrop = async (e) => {
    e.preventDefault();
    tl.classList.remove("drag");
    const pkg = [...e.dataTransfer.files].find((f) => /\.mvbooth$/i.test(f.name));
    if (pkg) return importPackage(pkg).catch((err) => toast(`Couldn't open that package: ${err.message}`));
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("audio") || /\.(wav|mp3|m4a|aac|flac|ogg|aif+)$/i.test(f.name));
    // Onto a beat lane, named like stems, several files on an empty session, or the first file
    // with no beat yet → beat stems. Anything else → vocals.
    const onBeat = e.target.closest?.(".lane.beat");
    const named = files.filter((f) => S.guessStemKind(f.name.replace(/\.[^.]+$/, "")));
    const asBeat = onBeat || (!session.beats.length && !session.tracks.length) ? files : named.length ? named : !session.beats.length ? files.slice(0, 1) : [];
    await importBeats(asBeat);
    for (const f of files.filter((x) => !asBeat.includes(x))) await importVocal(f);
  };

  // Space is ALWAYS play / pause / pick-up, even right after clicking a button or
  // slider. Only text fields keep it.
  const typing = (el) => el?.matches?.("textarea, input[type=text], input[type=number], input:not([type])") || el?.isContentEditable;
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || typing(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) {
      document.activeElement?.blur?.();
      $("btnPlay").click();
    }
  }, true);
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space" && !typing(e.target)) e.preventDefault();
  }, true);
  // Hint line: explains whatever you hover.
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest?.("[title]");
    if (el && el.title) showHint(esc(el.title).replace(/^([^:·]{2,40})(:|·)/, "<b>$1</b>$2"));
    else if (e.target.closest?.(".lane canvas")) showHint();
  });
  // A mouse click must not leave a button focused: Enter (Stop) or Space would "press" it again,
  // e.g. one click on + Marker turned every Stop into a new marker. Keyboard users (Tab) keep focus.
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.("button");
    if (b && e.detail > 0) b.blur();
  });
  document.addEventListener("change", (e) => {
    if (e.target.matches?.("select, input[type=checkbox], input[type=range]")) e.target.blur();
  });
  // Keyboard map (never hijacks typing).
  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && (k === "z" || k === "Z")) {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && (k === "y" || k === "Y")) {
      e.preventDefault();
      return redo();
    }
    if (mod && (k === "s" || k === "S")) {
      e.preventDefault();
      S.saveSession(session).then(() => toast("Session saved."));
      return;
    }
    if (mod) return;
    if (e.code === "Space") return;
    if (k === "?") openGuide();
    else if (k === "1" || k === "v" || k === "V") setTool("move");
    else if (k === "2") setTool("trim");
    else if (k === "3") setTool("cut");
    else if (k === "4") setTool("fade");
    else if (k === "Enter") stop();
    else if (k === "r" || k === "R") toggleRecord();
    else if (k === "l" || k === "L") $("btnLoop").click();
    else if (k === "c" || k === "C") $("btnClick").click();
    else if (k === "p" || k === "P") $("btnPunch").click();
    else if (k === "t" || k === "T") $("btnTap").click();
    else if (k === "e" || k === "E") $("btnExport").click();
    else if (k === "b" || k === "B") setAB(ui.ab === "A" ? "B" : "A");
    else if (k === "x" || k === "X") splitAtPlayhead();
    else if (k === "m" || k === "M") addMarker();
    else if (k === "f" || k === "F") fitView();
    else if (k === "Delete" || k === "Backspace") deleteClip();
    else if (k === "Home") returnToZero();
    else if (k === "+" || k === "=") zoom(1.5);
    else if (k === "-" || k === "_") zoom(1 / 1.5);
    else if (k === "ArrowLeft" || k === "ArrowRight") {
      e.preventDefault();
      nudge(k === "ArrowLeft" ? -1 : 1, e.shiftKey);
    } else if ((k === "ArrowDown" || k === "ArrowUp") && !$("prompter").hidden) {
      e.preventDefault();
      ui.lyricLine = clamp(ui.lyricLine + (k === "ArrowDown" ? 1 : -1), 0, parseLyrics().length - 1);
    } else if (k === "Escape") {
      closePrompter();
      closeGuide();
      for (const id of ["sessionMenu", "addMenu", "exportMenu"]) $(id).hidden = true;
    }
  });
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (ui.view.fit) fitView();
      else renderLanesOnly();
      drawPitch();
      document.querySelectorAll(".seg").forEach(moveThumb);
    }, 120);
  });
  navigator.mediaDevices?.addEventListener?.("devicechange", listDevices);
}
function addMarker(name) {
  const t = currentPos();
  const label = typeof name === "string" ? name : `M${session.markers.length + 1}`;
  edit(`Add marker ${label}`, () => {
    session.markers.push({ t, name: label });
    session.markers.sort((a, b) => a.t - b.t);
  }, { audioChange: false });
  status(`Marker "${label}" at ${fmtTime(t)}. Move the playhead and add the next section.`);
}

// ---------------------------------------------------------------- app shell + boot
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

// ---------------------------------------------------------------- update notice
// Each release has its own fingerprint in sw.js (the cache name; Netlify builds add a content hash).
// The page remembers the one it started with; a different one on the server means a newer MV Booth
// is live. An open window keeps running the code it loaded, so it says so instead of going stale.
let swBaseline = null;
let lastUpdateCheck = 0;
async function checkForUpdate(force = false) {
  if (location.protocol === "file:" || !$("updateBar").hidden) return;
  if (!force && Date.now() - lastUpdateCheck < 60000) return;
  lastUpdateCheck = Date.now();
  try {
    const r = await fetch("sw.js", { cache: "no-store" });
    const v = r.ok ? (await r.text()).match(/const CACHE = "([^"]+)"/)?.[1] : null;
    if (!v) return;
    if (!swBaseline) swBaseline = v;
    else if (v !== swBaseline) {
      $("updateBar").hidden = false;
      $("updateBar").dataset.version = v;
    }
  } catch {
    /* offline: nothing to compare */
  }
}
$("btnUpdate").onclick = async () => {
  if (guardBusy("reloading")) return;
  stopPlayback(false);
  await flushSave();
  location.reload();
};
$("btnUpdateLater").onclick = () => {
  swBaseline = $("updateBar").dataset.version || swBaseline; // ask again only for the next release
  $("updateBar").hidden = true;
};
checkForUpdate(true);
setInterval(checkForUpdate, 5 * 60000);
addEventListener("focus", () => checkForUpdate());
document.addEventListener("visibilitychange", () => !document.hidden && checkForUpdate());
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  const ping = () => fetch("__alive", { cache: "no-store" }).catch(() => {});
  ping();
  setInterval(ping, 15000);
  // The shortcut starts the tuning backend with an idle exit; keep it alive while the booth is open.
  setInterval(() => fetch(beUrl("/health"), { cache: "no-store" }).catch(() => {}), 60000);
}

ui.profile = (await store.get("profile")) || null;
let first = await S.migrateLegacy();
if (!first) {
  const cur = await store.get("currentSession");
  first = cur ? await S.loadSession(cur) : null;
  if (!first) {
    const list = (await S.listSessions()).filter((x) => !x.deletedAt);
    first = list.length ? await S.loadSession(list[0].id) : null;
  }
}
if (!first) {
  first = S.newSession("Session 1");
  const taste = await store.get("taste");
  if (taste) Object.assign(first.settings, taste);
}
session = first;
await loadSessionAudio();
ui.selTrack = session.tracks[0]?.id || null;
buildChain();
bindControls();
renderPresets();
setTool("move");
bindSettingsToUi();
setSeg("abSeg", "ab", "A");
fitView();
renderAll();
updateUndo();
await S.saveSession(session);
document.fonts?.ready.then(() => document.querySelectorAll(".seg").forEach(moveThumb));
status(session.tracks.length ? `Opened "${session.name}" · ${session.tracks.length} track(s).` : "Ready. Drop a beat, add a track, press R.");
window.__booth = { get session() { return session; }, ui, audio, mic, automix, checkForUpdate, exportPackage, importPackage, renderAll, renderLanesOnly, importBeat, importBeats, importVocal, toggleRecord, ctx, undo, redo, splitAtPlayhead, seek, exportAs, startPlayback, stopPlayback, currentPos };
