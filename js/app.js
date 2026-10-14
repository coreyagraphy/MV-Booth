import { FX, MODES, ROLES, estimateBpm } from "./automix.js";
import { STAGES, renderStem, runEngine } from "./engine.js";
import * as store from "./store.js";
import { NOTE_NAMES, SCALES, keyLabel } from "./tune.js";
import { download, encodeWav } from "./wav.js";

const $ = (id) => document.getElementById(id);
const ctx = new AudioContext({ latencyHint: "interactive" });
const FS = ctx.sampleRate;

const DEFAULTS = {
  targetLufs: -14, balance: 0, space: 1, bpm: 0, latencyMs: 0, nextRole: "lead", prompter: true, transcribe: false, scroll: 18,
  tuneStyle: "natural", key: "auto", scale: "minor", alignDoubles: true, alignTight: 0.9,
};
const state = {
  mode: "rap",
  settings: { ...DEFAULTS },
  lyrics: "",
  beat: null, // { id, name, offset, mute, buffer }
  tracks: [], // { id, name, role, fx, tune, dbl, offset, mute, solo, pan, trimDb, transcript, buffer }
  run: null, // last engine result
  virtual: [],
  master: null,
  masterNotes: [],
  key: null,
  profile: null,
  stale: false,
  ab: "A",
  selected: null,
  playhead: 0,
  playing: null,
  recording: null,
  busy: false,
};

// ---------------------------------------------------------------- output graph + metering
const out = ctx.createGain();
const rawBus = ctx.createGain();
const mixBus = ctx.createGain();
rawBus.connect(out);
mixBus.connect(out);
out.connect(ctx.destination);
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

// ---------------------------------------------------------------- helpers
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3400);
}
const status = (msg) => ($("status").textContent = msg);
const end = (item) => (item?.buffer ? (item.offset || 0) + item.buffer.duration : 0);
const projectEnd = () => Math.max(end(state.beat), ...state.tracks.map(end), state.master ? state.master.duration - 2 : 0, 0);
const viewDuration = () => Math.max(30, projectEnd() + 4);
const audible = (t) => !t.mute && (!state.tracks.some((x) => x.solo) || t.solo);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

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

async function resample(buf) {
  if (buf.sampleRate === FS) return buf;
  const oc = new OfflineAudioContext(buf.numberOfChannels, Math.ceil(buf.duration * FS), FS);
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

// ---------------------------------------------------------------- persistence
let saveTimer;
function saveMeta() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const strip = ({ buffer: _b, ...rest }) => rest;
    store.set("project", {
      mode: state.mode,
      settings: state.settings,
      lyrics: state.lyrics,
      beat: state.beat ? strip(state.beat) : null,
      tracks: state.tracks.map(strip),
    });
  }, 300);
}
const saveAudio = (id, buffer) =>
  store.set(`audio:${id}`, {
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice()),
  });
async function loadAudio(id) {
  const rec = await store.get(`audio:${id}`);
  if (!rec) return null;
  const b = new AudioBuffer({ numberOfChannels: rec.channels.length, length: rec.channels[0].length, sampleRate: rec.sampleRate });
  rec.channels.forEach((d, c) => b.copyToChannel(d, c));
  return resample(b);
}
async function restore() {
  state.profile = (await store.get("profile")) || null;
  const taste = await store.get("taste");
  const p = await store.get("project");
  if (!p) {
    if (taste) Object.assign(state.settings, taste); // a fresh project starts from what you usually pick
    return;
  }
  state.mode = p.mode || "rap";
  Object.assign(state.settings, p.settings || {});
  state.lyrics = p.lyrics || "";
  if (p.beat) {
    const buffer = await loadAudio(p.beat.id);
    if (buffer) state.beat = { ...p.beat, buffer };
  }
  for (const t of p.tracks || []) {
    const buffer = await loadAudio(t.id);
    if (buffer) state.tracks.push({ fx: "clean", tune: true, dbl: "off", ...t, buffer });
  }
  state.selected = state.tracks[0]?.id || null;
}

// ---------------------------------------------------------------- mic + recorder
const RECORDER = `
class BoothRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.at = -1; this.on = false; this.peak = 0; this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data.cmd === "start") { this.at = Math.round(e.data.at * sampleRate); this.on = true; }
      if (e.data.cmd === "stop") { this.on = false; this.port.postMessage({ type: "done" }); }
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > this.peak) this.peak = a; }
    if (++this.n >= 6) { this.port.postMessage({ type: "meter", peak: this.peak }); this.peak = 0; this.n = 0; }
    if (this.on && currentFrame + ch.length > this.at) {
      const off = Math.max(0, this.at - currentFrame);
      this.port.postMessage({ type: "chunk", data: ch.slice(off) });
    }
    return true;
  }
}
registerProcessor("booth-recorder", BoothRecorder);`;

const mic = { stream: null, source: null, node: null, monitor: ctx.createGain(), chunks: [], onDone: null, peak: 0 };
mic.monitor.gain.value = 0;
mic.monitor.connect(ctx.destination);
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
    mic.source.connect(mic.node).connect(sink).connect(ctx.destination);
    mic.source.connect(mic.monitor);
    mic.node.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === "chunk") mic.chunks.push(d.data);
      else if (d.type === "meter") mic.peak = d.peak;
      else if (d.type === "done") mic.onDone?.();
    };
    $("btnMic").textContent = "Mic live";
    $("btnMic").classList.add("live");
    await listDevices();
    startMeters();
    return true;
  } catch (err) {
    console.error(err);
    toast(`Mic unavailable: ${err.message}. Open the booth through its launcher (localhost).`);
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
function latencySeconds() {
  const trackLatency = mic.stream?.getAudioTracks()[0]?.getSettings?.().latency || 0;
  return (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + trackLatency + state.settings.latencyMs / 1000;
}

// ---------------------------------------------------------------- transcription
let recog = null;
let transcript = "";
function startTranscription() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  transcript = "";
  if (!SR || !state.settings.transcribe) return;
  recog = new SR();
  recog.continuous = true;
  recog.interimResults = false;
  recog.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) transcript += `${e.results[i][0].transcript.trim()}\n`;
  };
  recog.onend = () => state.recording && recog?.start();
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

// ---------------------------------------------------------------- transport
function stopPlayback() {
  if (!state.playing) return;
  state.playhead = currentPos();
  for (const s of state.playing.sources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  state.playing = null;
  document.body.classList.remove("playing");
}
function currentPos() {
  if (!state.playing) return state.playhead;
  return state.playing.from + Math.max(0, ctx.currentTime - state.playing.t0);
}
function schedule(buffer, offset, from, t0, dest, sources) {
  if (!buffer) return;
  const rel = from - offset;
  if (rel >= buffer.duration) return;
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.connect(dest);
  if (rel >= 0) s.start(t0, rel);
  else s.start(t0 - rel, 0);
  sources.push(s);
}
async function startPlayback(from = state.playhead, { cue = false } = {}) {
  await ctx.resume();
  stopPlayback();
  const t0 = ctx.currentTime + 0.08;
  const sources = [];
  const useMix = !cue && state.ab === "B" && state.master;
  rawBus.gain.value = useMix ? 0 : 1;
  mixBus.gain.value = useMix ? 1 : 0;
  if (state.beat && !state.beat.mute) schedule(state.beat.buffer, state.beat.offset || 0, from, t0, rawBus, sources);
  for (const t of state.tracks) if (audible(t)) schedule(t.buffer, t.offset || 0, from, t0, rawBus, sources);
  if (state.master && !cue) schedule(state.master, 0, from, t0, mixBus, sources);
  state.playing = { t0, from, sources };
  state.playhead = from;
  document.body.classList.add("playing");
  requestAnimationFrame(frame);
  startMeters();
  return t0;
}
function setAB(ab) {
  if (ab === "B" && !state.master) return toast("Run Automix first to hear the engine's mix.");
  state.ab = ab;
  const useMix = ab === "B";
  rawBus.gain.setTargetAtTime(useMix ? 0 : 1, ctx.currentTime, 0.008);
  mixBus.gain.setTargetAtTime(useMix ? 1 : 0, ctx.currentTime, 0.008);
  setSeg("abSeg", "ab", ab);
  renderLanes();
}
let lastPitchDraw = 0;
function frame() {
  const pos = currentPos();
  $("clock").textContent = fmtTime(pos);
  placePlayhead(pos);
  if (state.playing && !state.recording && pos > projectEnd() + 0.5) {
    stopPlayback();
    state.playhead = 0;
  }
  if (state.recording) prompterTick();
  const now = performance.now();
  if (now - lastPitchDraw > 120 && document.querySelector('.tab.on[data-panel="tune"]')) {
    lastPitchDraw = now;
    drawPitch();
  }
  if (state.playing) requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- meters + spectrum
let meterLoop = false;
const spec = new Float32Array(analyser.frequencyBinCount);
const tbuf = new Float32Array(1024);
function peakOf(an) {
  an.getFloatTimeDomainData(tbuf);
  let p = 0;
  for (let i = 0; i < tbuf.length; i++) p = Math.max(p, Math.abs(tbuf[i]));
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
    const bars = 96;
    for (let b = 0; b <= bars; b++) {
      const f = 30 * Math.pow(18000 / 30, b / bars);
      const i = Math.min(spec.length - 1, Math.round((f / (FS / 2)) * spec.length));
      const db = Number.isFinite(spec[i]) ? spec[i] : -120;
      const y = h - Math.max(0, Math.min(1, (db + 100) / 80)) * h;
      g.lineTo((b / bars) * w, y);
    }
    g.lineTo(w, h);
    g.closePath();
    g.globalAlpha = 0.22;
    g.fillStyle = grad;
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = grad;
    g.lineWidth = 1.5;
    g.shadowColor = "#ff7a1a";
    g.shadowBlur = 8;
    g.stroke();
    g.shadowBlur = 0;
    const l = peakOf(anL), r = peakOf(anR);
    $("mL").style.height = pct(l);
    $("mR").style.height = pct(r);
    $("mIn").style.height = pct(mic.peak);
    $("roMic").textContent = mic.node ? `${(20 * Math.log10(mic.peak + 1e-9)).toFixed(0)} dB` : "off";
    if (state.playing) $("roPeak").textContent = `${(20 * Math.log10(Math.max(l, r) + 1e-9)).toFixed(1)} dB`;
    if (state.playing || mic.node) requestAnimationFrame(draw);
    else meterLoop = false;
  };
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------- recording
async function toggleRecord() {
  if (state.recording) return finishRecording();
  if (state.busy) return;
  if (!(await ensureMic())) return;
  mic.chunks = [];
  const from = state.playhead;
  const t0 = await startPlayback(from, { cue: true });
  mic.node.port.postMessage({ cmd: "start", at: t0 });
  state.recording = { from, role: state.settings.nextRole };
  document.body.classList.add("recording");
  startTranscription();
  if (state.settings.prompter && state.lyrics.trim()) openPrompter();
  status("Recording… R or Space to stop.");
}
async function finishRecording() {
  const rec = state.recording;
  await new Promise((resolve) => {
    mic.onDone = resolve;
    mic.node.port.postMessage({ cmd: "stop" });
  });
  state.recording = null;
  document.body.classList.remove("recording");
  stopPlayback();
  closePrompter();
  const text = stopTranscription();
  const total = mic.chunks.reduce((a, c) => a + c.length, 0);
  const trim = Math.round(latencySeconds() * FS);
  if (total - trim < FS * 0.3) return status("Take too short — discarded.");
  const data = new Float32Array(total);
  let o = 0;
  for (const c of mic.chunks) {
    data.set(c, o);
    o += c.length;
  }
  mic.chunks = [];
  let take;
  if (trim >= 0) take = data.subarray(trim);
  else {
    take = new Float32Array(total - trim);
    take.set(data, -trim);
  }
  const buffer = ctx.createBuffer(1, take.length, FS);
  buffer.copyToChannel(take, 0);
  const n = state.tracks.filter((t) => t.role === rec.role).length + 1;
  addTrack({ name: `${ROLES[rec.role].label} ${n}`, role: rec.role, offset: rec.from, buffer, transcript: text });
  state.playhead = rec.from;
  status(`Take saved · ${buffer.duration.toFixed(1)}s · latency comp ${Math.round(latencySeconds() * 1000)} ms`);
}
function addTrack(t) {
  const track = { id: uid(), mute: false, solo: false, pan: 0, trimDb: 0, transcript: "", offset: 0, fx: "clean", tune: true, dbl: "off", ...t };
  state.tracks.push(track);
  state.selected = track.id;
  saveAudio(track.id, track.buffer);
  markStale();
  saveMeta();
  renderLanes();
}
function markStale() {
  if (state.master && !state.stale) {
    state.stale = true;
    renderReport();
  }
}

// ---------------------------------------------------------------- imports
async function decodeFile(file) {
  return ctx.decodeAudioData(await file.arrayBuffer());
}
async function importBeat(file) {
  try {
    status(`Decoding ${file.name}…`);
    const buffer = await decodeFile(file);
    const id = uid();
    if (state.beat) store.del(`audio:${state.beat.id}`);
    state.beat = { id, name: file.name.replace(/\.[^.]+$/, ""), offset: 0, mute: false, buffer };
    saveAudio(id, buffer);
    state.settings.bpm = estimateBpm(buffer.getChannelData(0), FS);
    $("bpm").value = state.settings.bpm;
    updateChips();
    markStale();
    saveMeta();
    renderLanes();
    status(`Beat loaded · ${state.settings.bpm || "?"} BPM detected.`);
  } catch (err) {
    toast(`Couldn't read that file: ${err.message}`);
  }
}
async function importVocal(file) {
  try {
    status(`Decoding ${file.name}…`);
    const buffer = await toMono(await decodeFile(file));
    addTrack({ name: file.name.replace(/\.[^.]+$/, ""), role: state.settings.nextRole, buffer });
    status("Vocal imported.");
  } catch (err) {
    toast(`Couldn't read that file: ${err.message}`);
  }
}

// ---------------------------------------------------------------- engine
function buildChain() {
  $("chain").innerHTML = STAGES.map(([k, label]) => `<div class="node" data-stage="${k}"><i></i><span>${label}</span></div>`).join("");
}
function setStage(key, p) {
  const idx = STAGES.findIndex(([k]) => k === key);
  document.querySelectorAll(".node").forEach((n, i) => {
    n.classList.toggle("done", i < idx || (i === idx && p >= 1));
    n.classList.toggle("active", i === idx && p < 1);
    n.style.setProperty("--p", i < idx ? 1 : i === idx ? Math.max(0.05, p) : 0);
  });
}
function resetChain(done = false) {
  document.querySelectorAll(".node").forEach((n) => {
    n.classList.toggle("done", done);
    n.classList.remove("active");
    n.style.setProperty("--p", done ? 1 : 0);
  });
}

async function automix() {
  if (state.busy) return;
  if (state.recording) await finishRecording();
  if (!state.tracks.some((t) => !t.mute)) return toast("Record or import a vocal first.");
  stopPlayback();
  state.busy = true;
  document.body.classList.add("busy");
  resetChain();
  const t0 = performance.now();
  try {
    if (state.beat && !state.settings.bpm) {
      state.settings.bpm = estimateBpm(state.beat.buffer.getChannelData(0), FS);
      $("bpm").value = state.settings.bpm;
    }
    const run = await runEngine({
      tracks: state.tracks,
      beat: state.beat,
      fs: FS,
      mode: state.mode,
      settings: state.settings,
      profile: state.profile,
      onStage: (k, p, msg) => {
        setStage(k, p);
        if (msg) status(msg);
      },
    });
    state.run = run;
    state.virtual = run.virtual;
    state.master = run.mix.buffer;
    state.masterNotes = run.mix.notes;
    state.key = run.key;
    state.profile = run.profile;
    state.stale = false;
    store.set("profile", run.profile);
    const s = state.settings;
    store.set("taste", { balance: s.balance, space: s.space, targetLufs: s.targetLufs, tuneStyle: s.tuneStyle, alignTight: s.alignTight });
    $("btnExportMix").disabled = false;
    $("btnExportStems").disabled = false;
    $("roLufs").textContent = `${run.mix.lufs.toFixed(1)} LUFS`;
    $("roPeak").textContent = `${run.mix.peak.toFixed(1)} dB`;
    updateChips();
    resetChain(true);
    setAB("B");
    renderReport();
    drawPitch();
    showTab("engine");
    status(`Mixed in ${((performance.now() - t0) / 1000).toFixed(1)}s · ${run.mix.lufs.toFixed(1)} LUFS · peak ${run.mix.peak.toFixed(1)} dB · B to compare`);
  } catch (err) {
    console.error(err);
    toast(`Automix failed: ${err.message}`);
    status("Automix failed.");
    resetChain();
  } finally {
    state.busy = false;
    document.body.classList.remove("busy");
  }
}

// ---------------------------------------------------------------- export
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const safe = (s) => s.replace(/[^\w-]+/g, "_");
function exportMaster() {
  if (state.master) download(encodeWav(state.master), `MVBooth_${state.mode}_${stamp()}.wav`);
}
async function exportStems() {
  if (!state.run) return;
  const ids = [...state.run.mixInput.map((v) => v.track.id), ...(state.beat && !state.beat.mute ? ["beat"] : [])];
  for (const [i, id] of ids.entries()) {
    status(`Rendering stem ${i + 1}/${ids.length}…`);
    const { buffer } = await renderStem(state.run, { beat: state.beat, fs: FS, mode: state.mode, settings: state.settings }, id);
    const name = id === "beat" ? state.beat.name : state.run.mixInput.find((v) => v.track.id === id).track.name;
    download(encodeWav(buffer), `MVBooth_stem_${String(i + 1).padStart(2, "0")}_${safe(name)}.wav`);
  }
  status("Stems exported (pre-master: they sum to the mix before the limiter).");
}
function exportRaw() {
  if (!state.tracks.length) return toast("No takes yet.");
  for (const t of state.tracks) download(encodeWav(t.buffer), `MVBooth_raw_${safe(t.name)}.wav`);
}

// ---------------------------------------------------------------- lanes
const DBL = { off: "DBL", stereo: "2X", oct: "2X+8" };
function laneHead(item, kind) {
  const head = document.createElement("div");
  head.className = "lane-head";
  head.onclick = (e) => {
    if (kind !== "vocal" || e.target.closest("button,select,input")) return;
    state.selected = item.id;
    renderLanes();
    drawPitch();
  };
  const top = document.createElement("div");
  top.className = "top";
  const name = Object.assign(document.createElement("input"), { className: "name", value: item.name, readOnly: kind === "virtual" });
  name.onchange = () => {
    item.name = name.value || item.name;
    saveMeta();
  };
  top.append(name);
  const btn = (label, cls, title, on, fn) => {
    const b = Object.assign(document.createElement("button"), { className: `tog ${cls}`, textContent: label, title });
    b.classList.toggle("on", !!on);
    b.onclick = fn;
    return b;
  };
  const changed = () => {
    markStale();
    saveMeta();
    renderLanes();
    if (state.playing && !state.recording) startPlayback(currentPos());
  };
  if (kind !== "virtual") {
    top.append(btn("✕", "x", "Delete", false, () => {
      if (!confirm(`Delete "${item.name}"? This can't be undone.`)) return;
      stopPlayback();
      store.del(`audio:${item.id}`);
      if (kind === "beat") state.beat = null;
      else state.tracks = state.tracks.filter((t) => t !== item);
      changed();
    }));
  }
  head.append(top);
  if (kind === "beat") {
    const row = document.createElement("div");
    row.className = "row";
    row.append(Object.assign(document.createElement("span"), { className: "badge", textContent: `Beat · ${state.settings.bpm || "?"} BPM` }));
    row.append(btn("M", "m", "Mute", item.mute, () => {
      item.mute = !item.mute;
      changed();
    }));
    head.append(row);
  } else if (kind === "virtual") {
    head.append(Object.assign(document.createElement("span"), { className: "badge", textContent: "AI generated · in the mix" }));
  } else {
    const sel = (opts, value, fn) => {
      const s = document.createElement("select");
      for (const [k, v] of opts) s.add(new Option(v, k));
      s.value = value;
      s.onchange = () => fn(s.value);
      return s;
    };
    const r1 = document.createElement("div");
    r1.className = "row";
    r1.append(
      sel(Object.entries(ROLES).filter(([, r]) => !r.hidden).map(([k, r]) => [k, r.label]), item.role, (v) => {
        item.role = v;
        changed();
      }),
      sel(Object.entries(FX), item.fx || "clean", (v) => {
        item.fx = v;
        changed();
      }),
    );
    const r2 = document.createElement("div");
    r2.className = "row";
    r2.append(
      btn("TUNE", "t", "Pitch correction on this lane", item.tune !== false, () => {
        item.tune = item.tune === false;
        changed();
      }),
    );
    if (item.role === "lead") {
      r2.append(btn(DBL[item.dbl || "off"], "d", "AI doubles: off → stereo pair → stereo + octave", item.dbl && item.dbl !== "off", () => {
        item.dbl = { off: "stereo", stereo: "oct", oct: "off" }[item.dbl || "off"];
        changed();
      }));
    }
    r2.append(
      btn("M", "m", "Mute", item.mute, () => {
        item.mute = !item.mute;
        changed();
      }),
      btn("S", "s", "Solo", item.solo, () => {
        item.solo = !item.solo;
        changed();
      }),
    );
    head.append(r1, r2);
  }
  return head;
}

function renderLanes() {
  const lanes = $("lanes");
  lanes.innerHTML = "";
  const items = [];
  if (state.beat) items.push([state.beat, "beat"]);
  for (const t of state.tracks) {
    items.push([t, "vocal"]);
    if (state.ab === "B" && !state.stale) for (const v of state.virtual.filter((v) => v.parent === t.id)) items.push([v, "virtual"]);
  }
  for (const [item, kind] of items) {
    const lane = document.createElement("div");
    lane.className = `lane${kind === "beat" ? " beat" : ""}${kind === "virtual" ? " virtual" : ""}${item.id === state.selected ? " sel" : ""}`;
    const canvas = document.createElement("canvas");
    canvas._item = item;
    canvas._kind = kind;
    canvas.onpointerdown = (e) => seekFromEvent(e, canvas);
    lane.append(laneHead(item, kind), canvas);
    lanes.append(lane);
  }
  $("emptyHint").hidden = items.length > 0;
  renderRuler();
  drawLanes();
  placePlayhead(currentPos());
}
function seekFromEvent(e, el) {
  if (state.recording) return;
  const r = el.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * viewDuration();
  const wasPlaying = !!state.playing;
  stopPlayback();
  state.playhead = Math.max(0, t);
  $("clock").textContent = fmtTime(state.playhead);
  placePlayhead(state.playhead);
  if (wasPlaying) startPlayback(state.playhead);
}
function renderRuler() {
  const ruler = $("ruler");
  ruler.innerHTML = "";
  const dur = viewDuration();
  const step = dur > 240 ? 30 : dur > 90 ? 10 : 5;
  for (let s = 0; s < dur; s += step) {
    const span = document.createElement("span");
    span.style.left = `${(s / dur) * 100}%`;
    span.textContent = fmtTime(s).replace(/\.0$/, "");
    ruler.append(span);
  }
}
function placePlayhead(pos) {
  $("playhead").style.transform = `translateX(${(pos / viewDuration()) * $("ruler").clientWidth}px)`;
}
function drawLanes() {
  const dur = viewDuration();
  const dpr = window.devicePixelRatio || 1;
  const processed = state.run?.processed;
  for (const canvas of document.querySelectorAll(".lane canvas")) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w) continue;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d");
    g.scale(dpr, dpr);
    const item = canvas._item;
    const kind = canvas._kind;
    // Bar grid when the tempo is known.
    if (state.settings.bpm) {
      const bar = (60 / state.settings.bpm) * 4;
      g.fillStyle = "rgba(255,255,255,0.035)";
      for (let t = 0; t < dur; t += bar) g.fillRect((t / dur) * w, 0, 1, h);
    }
    const proc = kind !== "beat" && state.ab === "B" && !state.stale ? processed?.get(item.id) : null;
    const buf = proc ? proc.buffer : item.buffer;
    if (!buf) continue;
    const data = buf.getChannelData(0);
    const off = item.offset || 0;
    const x0 = (off / dur) * w;
    const x1 = ((off + buf.duration) / dur) * w;
    const spp = data.length / Math.max(1, x1 - x0);
    const mid = h / 2;
    let peak = 1e-3;
    for (let i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i]));
    const grad = g.createLinearGradient(0, 0, 0, h);
    if (kind === "beat") {
      grad.addColorStop(0, "rgba(255,179,92,0.85)");
      grad.addColorStop(0.5, "rgba(255,122,26,0.55)");
      grad.addColorStop(1, "rgba(255,179,92,0.85)");
    } else {
      const a = proc ? 1 : 0.55;
      grad.addColorStop(0, `rgba(160,255,248,${a})`);
      grad.addColorStop(0.5, `rgba(18,224,208,${a * 0.75})`);
      grad.addColorStop(1, `rgba(160,255,248,${a})`);
    }
    g.fillStyle = grad;
    g.shadowColor = kind === "beat" ? "#ff7a1a" : "#12e0d0";
    g.shadowBlur = proc ? 10 : 4;
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x++) {
      const a = Math.floor((x - x0) * spp);
      const b = Math.min(data.length, Math.floor((x - x0 + 1) * spp));
      let mn = 0, mx = 0;
      for (let i = a; i < b; i += Math.max(1, Math.floor((b - a) / 48))) {
        const v = data[i] / peak;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      g.fillRect(x, mid - mx * mid * 0.86, 1, Math.max(1, (mx - mn) * mid * 0.86));
    }
    g.shadowBlur = 0;
    if (proc && kind === "vocal") {
      // Visible automation: the vocal rider's gain line + de-ess hits.
      const fpx = (proc.hop / FS / dur) * w;
      g.strokeStyle = "#ffb35c";
      g.lineWidth = 1.4;
      g.beginPath();
      proc.rideCurve.forEach((db, i) => {
        const x = x0 + i * fpx;
        const y = mid - (Math.max(-20, Math.min(12, db)) / 20) * mid * 0.85;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
      g.fillStyle = "rgba(255,59,74,0.75)";
      proc.deess.forEach((db, i) => {
        if (db < -1.5) g.fillRect(x0 + i * fpx, h - 4, Math.max(1, fpx), 4);
      });
    }
  }
}

// ---------------------------------------------------------------- pitch view
function drawPitch() {
  const c = $("pitchGraph");
  const w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  const dpr = devicePixelRatio || 1;
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext("2d");
  g.scale(dpr, dpr);
  const t = state.tracks.find((x) => x.id === state.selected);
  $("pitchLane").textContent = t ? t.name : "select a lane";
  const proc = t && state.run?.processed.get(t.id);
  if (!proc?.pitch) {
    g.fillStyle = "#4b5560";
    g.font = "12px Space Grotesk";
    g.fillText(t ? "Run Automix to see the pitch analysis." : "Click a vocal lane header.", 14, 24);
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
  const key = state.key;
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
  // Zoomed window (8 s) that follows the playhead, like a pitch editor.
  const hopSec = proc.hop / FS;
  const span = Math.min(f0.length, Math.round(8 / hopSec));
  const rel = Math.round((currentPos() - (t.offset || 0) - 2) / hopSec);
  const first = Math.max(0, Math.min(f0.length - span, rel));
  const n = span;
  const px = (i) => 28 + ((i - first) / n) * (w - 32);
  g.fillStyle = "rgba(255,255,255,0.3)";
  g.fillText(`${fmtTime(first * hopSec + (t.offset || 0))} – ${fmtTime((first + span) * hopSec + (t.offset || 0))}`, w - 110, 12);
  const plot = (arr, color, width) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    let pen = false;
    for (let i = first; i < first + n; i++) {
      if (!arr[i]) {
        pen = false;
        continue;
      }
      const x = px(i);
      if (!pen) g.moveTo(x, y(midi(arr[i])));
      else g.lineTo(x, y(midi(arr[i])));
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
  if (!state.run) return;
  const list = (arr) => `<ul>${arr.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
  let html = state.stale ? '<p class="stale">Takes or settings changed since this mix. Run Automix again.</p>' : "";
  html += `<section class="master"><h4>Mix bus · ${MODES[state.mode].label}${state.key ? ` · ${esc(keyLabel(state.key))}` : ""}</h4>${list(state.masterNotes)}</section>`;
  for (const v of state.run.mixInput) {
    const r = v.processed;
    html += `<section><h4>${esc(v.track.name)} · ${esc((ROLES[v.track.role] || ROLES.lead).label)}</h4>${list(r.report)}`;
    if (v.track.transcript) html += `<div class="transcript">“${esc(v.track.transcript)}”</div>`;
    html += "</section>";
  }
  const p = state.profile;
  if (p) {
    const voice = p.f0 ? `${Math.round(p.f0)} Hz average pitch (${p.f0 < 155 ? "low/baritone" : p.f0 < 240 ? "mid/tenor" : "high"} range)` : "still learning";
    html += `<section class="learn"><h4>What the engine has learned</h4>${list([
      `Sessions analysed: ${p.sessions}`,
      `Your voice: ${voice}`,
      p.sibCentre ? `Your sibilance sits at ${(p.sibCentre / 1000).toFixed(1)} kHz; short takes borrow this profile for EQ` : "Sibilance profile: learning",
      p.key ? `Last confident key: ${keyLabel({ ...p.key })}${state.key?.remembered ? " (used this session)" : ""}` : "Key memory: none yet",
      "New projects start from your last mix settings",
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
function updateGutter() {
  $("gutter").textContent = state.lyrics
    .split("\n")
    .map((line) => line.split(/\s+/).reduce((a, w) => a + syllables(w), 0) || "")
    .join("\n");
}
let prompterY = 0;
let prompterLast = 0;
function openPrompter() {
  $("prompterText").textContent = state.lyrics || "(No lyrics yet — write them in the Lyrics tab.)";
  $("prompter").hidden = false;
  $("prompterScroll").scrollTop = 0;
  prompterY = 0;
  prompterLast = performance.now();
  if (!state.recording) {
    requestAnimationFrame(function loop() {
      if ($("prompter").hidden) return;
      prompterTick();
      requestAnimationFrame(loop);
    });
  }
}
function prompterTick() {
  if ($("prompter").hidden) return;
  const now = performance.now();
  const el = $("prompterScroll");
  prompterY += (state.settings.scroll * (now - prompterLast)) / 1000;
  prompterLast = now;
  if (Math.abs(el.scrollTop - Math.floor(prompterY)) > 40) prompterY = el.scrollTop;
  el.scrollTop = prompterY;
}
const closePrompter = () => ($("prompter").hidden = true);

// ---------------------------------------------------------------- controls
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((p) => p.classList.toggle("on", p.dataset.panel === name));
  requestAnimationFrame(() => {
    document.querySelectorAll(`.tab[data-panel="${name}"] .seg`).forEach(moveThumb);
    if (name === "tune") drawPitch();
  });
}
function updateChips() {
  const s = state.settings;
  $("chipBpm").textContent = s.bpm ? `${s.bpm} BPM` : "— BPM";
  const k = state.key && s.key === "auto" ? keyLabel(state.key) : s.key === "auto" ? "Key auto" : `${NOTE_NAMES[+s.key]} ${SCALES[s.scale].label.toLowerCase()}`;
  $("chipKey").textContent = k;
  $("chipKey").classList.toggle("hot", s.tuneStyle !== "off");
}
function setMode(mode, user = false) {
  state.mode = mode;
  setSeg("modeSeg", "mode", mode);
  const s = state.settings;
  if (user && mode === "vo") {
    if (s.targetLufs === -14) s.targetLufs = -16;
    if (s.tuneStyle === "natural") s.tuneStyle = "off";
  } else if (user && mode === "rap") {
    if (s.targetLufs === -16) s.targetLufs = -14;
    if (s.tuneStyle === "off") s.tuneStyle = "natural";
  }
  $("target").value = String(s.targetLufs);
  setSeg("styleSeg", "style", s.tuneStyle);
  updateChips();
  markStale();
  saveMeta();
}

function bindControls() {
  const s = state.settings;
  document.querySelectorAll("#modeSeg button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode, true)));
  document.querySelectorAll("#abSeg button").forEach((b) => (b.onclick = () => setAB(b.dataset.ab)));
  document.querySelectorAll("#styleSeg button").forEach((b) => (b.onclick = () => {
    s.tuneStyle = b.dataset.style;
    setSeg("styleSeg", "style", s.tuneStyle);
    updateChips();
    markStale();
    saveMeta();
  }));
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $("btnPlay").onclick = () => (state.recording ? finishRecording() : state.playing ? stopPlayback() : startPlayback());
  $("btnRec").onclick = toggleRecord;
  $("btnReturn").onclick = () => {
    const playing = state.playing && !state.recording;
    stopPlayback();
    state.playhead = 0;
    placePlayhead(0);
    $("clock").textContent = fmtTime(0);
    if (playing) startPlayback(0);
  };
  $("btnAutomix").onclick = automix;
  $("btnMic").onclick = ensureMic;
  $("micSelect").onchange = switchMic;
  $("monitor").onchange = (e) => mic.monitor.gain.setTargetAtTime(e.target.checked ? 1 : 0, ctx.currentTime, 0.01);

  const roleSel = $("nextRole");
  for (const [k, r] of Object.entries(ROLES)) if (!r.hidden) roleSel.add(new Option(r.label, k));
  roleSel.value = s.nextRole;
  roleSel.onchange = () => {
    s.nextRole = roleSel.value;
    saveMeta();
  };
  const keySel = $("keySel");
  keySel.add(new Option("Auto-detect", "auto"));
  NOTE_NAMES.forEach((n, i) => keySel.add(new Option(n, String(i))));
  keySel.value = String(s.key);
  const scaleSel = $("scaleSel");
  for (const [k, v] of Object.entries(SCALES)) scaleSel.add(new Option(v.label, k));
  scaleSel.value = s.scale;
  keySel.onchange = scaleSel.onchange = () => {
    s.key = keySel.value;
    s.scale = scaleSel.value;
    scaleSel.disabled = s.key === "auto";
    updateChips();
    markStale();
    saveMeta();
  };
  scaleSel.disabled = s.key === "auto";
  $("alignDoubles").checked = s.alignDoubles;
  $("alignDoubles").onchange = (e) => {
    s.alignDoubles = e.target.checked;
    markStale();
    saveMeta();
  };

  const bindRange = (id, key, outId, fmt) => {
    const el = $(id);
    el.value = s[key];
    const show = () => outId && ($(outId).textContent = fmt(+el.value));
    show();
    el.oninput = () => {
      s[key] = +el.value;
      show();
      saveMeta();
    };
    el.onchange = () => {
      markStale();
      updateChips();
    };
  };
  bindRange("balance", "balance", "balanceOut", (v) => `${v > 0 ? "+" : ""}${v} dB`);
  bindRange("space", "space", "spaceOut", (v) => `${Math.round(v * 100)}%`);
  bindRange("latency", "latencyMs", "latencyOut", (v) => `${v > 0 ? "+" : ""}${v} ms`);
  bindRange("tight", "alignTight", "tightOut", (v) => `${Math.round(v * 100)}%`);
  bindRange("scrollSpeed", "scroll", null, null);
  bindRange("bpm", "bpm", null, null);
  $("target").value = String(s.targetLufs);
  $("target").onchange = (e) => {
    s.targetLufs = +e.target.value;
    markStale();
    saveMeta();
  };
  $("usePrompter").checked = s.prompter;
  $("usePrompter").onchange = (e) => {
    s.prompter = e.target.checked;
    saveMeta();
  };
  $("transcribe").checked = s.transcribe;
  $("transcribe").onchange = (e) => {
    s.transcribe = e.target.checked;
    saveMeta();
  };

  $("btnImportBeat").onclick = () => $("fileBeat").click();
  $("btnImportVocal").onclick = () => $("fileVocal").click();
  $("fileBeat").onchange = (e) => {
    const [f] = e.target.files;
    e.target.value = "";
    if (f) importBeat(f);
  };
  $("fileVocal").onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    for (const f of files) await importVocal(f);
  };
  $("btnExportMix").onclick = exportMaster;
  $("btnExportStems").onclick = exportStems;
  $("btnExportRaw").onclick = exportRaw;

  const ly = $("lyrics");
  ly.value = state.lyrics;
  ly.oninput = () => {
    state.lyrics = ly.value;
    updateGutter();
    saveMeta();
  };
  ly.onscroll = () => ($("gutter").scrollTop = ly.scrollTop);
  updateGutter();
  $("btnPrompter").onclick = openPrompter;
  $("prompterClose").onclick = closePrompter;
  $("ruler").onpointerdown = (e) => seekFromEvent(e, $("ruler"));

  const tl = $("timeline");
  tl.ondragover = (e) => {
    e.preventDefault();
    tl.classList.add("drag");
  };
  tl.ondragleave = () => tl.classList.remove("drag");
  tl.ondrop = async (e) => {
    e.preventDefault();
    tl.classList.remove("drag");
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("audio") || /\.(wav|mp3|m4a|aac|flac|ogg|aif+)$/i.test(f.name));
    const onBeatLane = e.target.closest?.(".lane.beat");
    for (const f of files) {
      if (!state.beat || onBeatLane) await importBeat(f);
      else await importVocal(f);
    }
  };

  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.code === "Space") {
      e.preventDefault();
      $("btnPlay").click();
    } else if (e.key === "r" || e.key === "R") toggleRecord();
    else if (e.key === "b" || e.key === "B") setAB(state.ab === "A" ? "B" : "A");
    else if (e.key === "Home") $("btnReturn").click();
    else if (e.key === "Escape") closePrompter();
  });
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderRuler();
      drawLanes();
      drawPitch();
      placePlayhead(currentPos());
      document.querySelectorAll(".seg").forEach(moveThumb);
    }, 120);
  });
  navigator.mediaDevices?.addEventListener?.("devicechange", listDevices);
}

// ---------------------------------------------------------------- app shell
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
if (["localhost", "127.0.0.1"].includes(location.hostname)) {
  // Keeps the local server alive while the booth is open; it exits on its own after.
  const ping = () => fetch("__alive", { cache: "no-store" }).catch(() => {});
  ping();
  setInterval(ping, 15000);
}

await restore();
buildChain();
bindControls();
setMode(state.mode);
state.stale = false;
setSeg("abSeg", "ab", "A");
renderLanes();
updateChips();
document.fonts?.ready.then(() => document.querySelectorAll(".seg").forEach(moveThumb));
status(state.tracks.length ? `Restored ${state.tracks.length} take(s). Hit Automix to engineer.` : "Ready. Drop a beat or press R to record.");
window.__booth = { state, automix, importBeat, importVocal, toggleRecord, ctx };
