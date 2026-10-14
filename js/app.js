import { MODES, ROLES, estimateBpm, renderMix, renderVocal } from "./automix.js";
import * as store from "./store.js";
import { download, encodeWav } from "./wav.js";

const $ = (id) => document.getElementById(id);
const ctx = new AudioContext({ latencyHint: "interactive" });
const FS = ctx.sampleRate;

const state = {
  mode: "rap",
  settings: { targetLufs: -14, balance: 0, space: 1, bpm: 0, latencyMs: 0, nextRole: "lead", prompter: true, transcribe: false, scroll: 18 },
  lyrics: "",
  beat: null, // { id, name, offset, mute, buffer }
  tracks: [], // { id, name, role, offset, mute, solo, pan, trimDb, transcript, buffer, processed }
  master: null,
  masterNotes: [],
  stale: false,
  ab: "A",
  playhead: 0,
  playing: null, // { t0, from, sources }
  recording: null,
  busy: false,
};

// ---------------------------------------------------------------- output graph
const out = ctx.createGain();
const rawBus = ctx.createGain();
const mixBus = ctx.createGain();
rawBus.connect(out);
mixBus.connect(out);
out.connect(ctx.destination);

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
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}
function status(msg, p = null) {
  $("status").textContent = msg;
  $("progress").style.width = p == null ? "0" : `${Math.round(p * 100)}%`;
}
const end = (item) => (item?.buffer ? (item.offset || 0) + item.buffer.duration : 0);
const projectEnd = () => Math.max(end(state.beat), ...state.tracks.map(end), 0);
const viewDuration = () => Math.max(30, projectEnd() + 4);
const audible = (t) => !t.mute && (!state.tracks.some((x) => x.solo) || t.solo);

async function toMono(buffer) {
  let buf = buffer;
  if (buf.sampleRate !== FS) {
    const oc = new OfflineAudioContext(buf.numberOfChannels, Math.ceil(buf.duration * FS), FS);
    const s = oc.createBufferSource();
    s.buffer = buf;
    s.connect(oc.destination);
    s.start();
    buf = await oc.startRendering();
  }
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
  }
  const outBuf = ctx.createBuffer(1, mono.length, FS);
  outBuf.copyToChannel(mono, 0);
  return outBuf;
}

// ---------------------------------------------------------------- persistence
let saveTimer;
function saveMeta() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const strip = ({ buffer: _b, processed: _p, ...rest }) => rest;
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
  if (rec.sampleRate === FS) return b;
  const oc = new OfflineAudioContext(b.numberOfChannels, Math.ceil(b.duration * FS), FS);
  const s = oc.createBufferSource();
  s.buffer = b;
  s.connect(oc.destination);
  s.start();
  return oc.startRendering();
}

async function restore() {
  const p = await store.get("project");
  if (!p) return;
  state.mode = p.mode || "rap";
  Object.assign(state.settings, p.settings || {});
  state.lyrics = p.lyrics || "";
  if (p.beat) {
    const buffer = await loadAudio(p.beat.id);
    if (buffer) state.beat = { ...p.beat, buffer };
  }
  for (const t of p.tracks || []) {
    const buffer = await loadAudio(t.id);
    if (buffer) state.tracks.push({ ...t, buffer, processed: null });
  }
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

const mic = { stream: null, source: null, node: null, monitor: ctx.createGain(), chunks: [], onDone: null };
mic.monitor.gain.value = 0;
mic.monitor.connect(ctx.destination);

async function ensureMic() {
  if (mic.node) return true;
  try {
    await ctx.resume();
    const deviceId = $("micSelect").value;
    mic.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    const url = URL.createObjectURL(new Blob([RECORDER], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    mic.source = ctx.createMediaStreamSource(mic.stream);
    mic.node = new AudioWorkletNode(ctx, "booth-recorder", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const sink = ctx.createGain();
    sink.gain.value = 0;
    mic.source.connect(mic.node).connect(sink).connect(ctx.destination);
    mic.source.connect(mic.monitor);
    mic.node.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === "chunk") mic.chunks.push(d.data);
      else if (d.type === "meter") $("inMeter").style.width = `${Math.min(100, Math.max(0, (20 * Math.log10(d.peak + 1e-9) + 60) / 60) * 100)}%`;
      else if (d.type === "done") mic.onDone?.();
    };
    $("btnMic").textContent = "Mic live";
    await listDevices();
    return true;
  } catch (err) {
    console.error(err);
    toast(`Mic unavailable: ${err.message}. Open this page via localhost or https.`);
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
  for (const d of devices) {
    if (!d.deviceId || d.deviceId === "default") continue;
    sel.add(new Option(d.label || `Input ${sel.length}`, d.deviceId));
  }
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
  return t0;
}

function setAB(ab) {
  if (ab === "B" && !state.master) return toast("Run Automix first to hear the mix.");
  state.ab = ab;
  const useMix = ab === "B";
  rawBus.gain.setTargetAtTime(useMix ? 0 : 1, ctx.currentTime, 0.008);
  mixBus.gain.setTargetAtTime(useMix ? 1 : 0, ctx.currentTime, 0.008);
  document.querySelectorAll("#abSeg button").forEach((b) => b.classList.toggle("on", b.dataset.ab === ab));
  drawLanes();
}

function frame() {
  const pos = currentPos();
  $("clock").textContent = fmtTime(pos);
  placePlayhead(pos);
  if (state.playing && !state.recording && pos > projectEnd() + 0.5) {
    stopPlayback();
    state.playhead = 0;
  }
  if (state.recording) prompterTick();
  if (state.playing) requestAnimationFrame(frame);
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
  status("Recording… press R or Space to stop.");
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
  if (total - trim < FS * 0.3) {
    status("Take too short — discarded.");
    return;
  }
  const data = new Float32Array(total);
  let o = 0;
  for (const c of mic.chunks) {
    data.set(c, o);
    o += c.length;
  }
  mic.chunks = [];
  const take = trim >= 0 ? data.subarray(trim) : Float32Array.from([...new Float32Array(-trim), ...data]);
  const buffer = ctx.createBuffer(1, take.length, FS);
  buffer.copyToChannel(take, 0);
  const n = state.tracks.filter((t) => t.role === rec.role).length + 1;
  addTrack({ name: `${ROLES[rec.role].label} ${n}`, role: rec.role, offset: rec.from, buffer, transcript: text });
  state.playhead = rec.from;
  status(`Take saved (${buffer.duration.toFixed(1)}s, latency comp ${Math.round(latencySeconds() * 1000)} ms).`);
}

function addTrack(t) {
  const track = { id: uid(), mute: false, solo: false, pan: 0, trimDb: 0, transcript: "", offset: 0, processed: null, ...t };
  state.tracks.push(track);
  saveAudio(track.id, track.buffer);
  markStale();
  saveMeta();
  renderLanes();
}

function markStale() {
  if (state.master) {
    state.stale = true;
    renderReport();
  }
}

// ---------------------------------------------------------------- imports
async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  return ctx.decodeAudioData(bytes);
}

async function importBeat(file) {
  try {
    status(`Decoding ${file.name}…`);
    const buffer = await decodeFile(file);
    const id = uid();
    state.beat = { id, name: file.name.replace(/\.[^.]+$/, ""), offset: 0, mute: false, buffer };
    saveAudio(id, buffer);
    if (!state.settings.bpm) {
      state.settings.bpm = estimateBpm(buffer.getChannelData(0), FS);
      $("bpm").value = state.settings.bpm;
    }
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

// ---------------------------------------------------------------- automix
async function automix() {
  if (state.busy) return;
  if (state.recording) await finishRecording();
  const vocals = state.tracks.filter((t) => !t.mute);
  if (!vocals.length) return toast("Record or import a vocal first.");
  stopPlayback();
  state.busy = true;
  document.body.classList.add("busy");
  try {
    if (state.beat && !state.settings.bpm) {
      state.settings.bpm = estimateBpm(state.beat.buffer.getChannelData(0), FS);
      $("bpm").value = state.settings.bpm;
    }
    const steps = vocals.length + 1;
    for (const [i, t] of vocals.entries()) {
      status(`Engineering ${t.name}…`, i / steps);
      t.processed = await renderVocal(t, t.buffer.getChannelData(0), FS, state.mode, (p) => status(`Engineering ${t.name}…`, (i + p) / steps));
    }
    status("Balancing, unmasking, mastering…", vocals.length / steps);
    const length = Math.ceil((projectEnd() + MODES[state.mode].reverb.seconds + 0.5) * FS);
    const mix = await renderMix({
      vocals: vocals.map((t) => ({ track: t, processed: t.processed })),
      beat: state.beat?.buffer || null,
      beatTrack: state.beat,
      fs: FS,
      mode: state.mode,
      settings: state.settings,
      length,
    });
    state.master = mix.buffer;
    state.masterNotes = mix.notes;
    state.stale = false;
    $("btnExportMix").disabled = false;
    $("btnExportStems").disabled = false;
    setAB("B");
    renderReport();
    showTab("engine");
    status(`Mixed · ${mix.lufs.toFixed(1)} LUFS · peak ${mix.peak.toFixed(1)} dBFS. Press B to A/B.`, 1);
  } catch (err) {
    console.error(err);
    toast(`Automix failed: ${err.message}`);
    status("Automix failed.");
  } finally {
    state.busy = false;
    document.body.classList.remove("busy");
  }
}

// ---------------------------------------------------------------- export
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

function exportMaster() {
  if (!state.master) return;
  download(encodeWav(state.master), `MVBooth_${state.mode}_${stamp()}.wav`);
}

async function exportStems() {
  const vocals = state.tracks.filter((t) => !t.mute && t.processed);
  if (!vocals.length) return;
  const length = state.master.length;
  const ids = [...vocals.map((t) => t.id), ...(state.beat && !state.beat.mute ? ["beat"] : [])];
  for (const [i, id] of ids.entries()) {
    status("Rendering stems…", i / ids.length);
    const { buffer } = await renderMix({
      vocals: vocals.map((t) => ({ track: t, processed: t.processed })),
      beat: state.beat?.buffer || null,
      beatTrack: state.beat,
      fs: FS,
      mode: state.mode,
      settings: state.settings,
      length,
      only: id,
    });
    const name = id === "beat" ? state.beat.name : state.tracks.find((t) => t.id === id).name;
    download(encodeWav(buffer), `MVBooth_stem_${String(i + 1).padStart(2, "0")}_${name.replace(/[^\w-]+/g, "_")}.wav`);
  }
  status("Stems exported (pre-master, they sum to the mix before the limiter).", 1);
}

function exportRaw() {
  if (!state.tracks.length) return toast("No takes yet.");
  for (const t of state.tracks) download(encodeWav(t.buffer), `MVBooth_raw_${t.name.replace(/[^\w-]+/g, "_")}.wav`);
}

// ---------------------------------------------------------------- lanes UI
function laneHead(item, isBeat) {
  const head = document.createElement("div");
  head.className = "lane-head";
  const name = Object.assign(document.createElement("input"), { className: "name", value: item.name });
  name.onchange = () => {
    item.name = name.value || item.name;
    saveMeta();
  };
  const ctrls = document.createElement("div");
  ctrls.className = "ctrls";
  if (!isBeat) {
    const role = document.createElement("select");
    for (const [k, r] of Object.entries(ROLES)) role.add(new Option(r.label, k));
    role.value = item.role;
    role.onchange = () => {
      item.role = role.value;
      markStale();
      saveMeta();
    };
    ctrls.append(role);
  } else {
    ctrls.append(Object.assign(document.createElement("span"), { className: "muted", textContent: "Beat" }));
  }
  const tog = (label, cls, key) => {
    const b = Object.assign(document.createElement("button"), { className: `tog ${cls}`, textContent: label, title: key });
    b.classList.toggle("on", !!item[key]);
    b.onclick = () => {
      item[key] = !item[key];
      b.classList.toggle("on", item[key]);
      markStale();
      saveMeta();
      if (state.playing && !state.recording) startPlayback(currentPos());
    };
    return b;
  };
  ctrls.append(tog("M", "m", "mute"));
  if (!isBeat) ctrls.append(tog("S", "s", "solo"));
  const del = Object.assign(document.createElement("button"), { className: "tog x", textContent: "✕", title: "Delete" });
  del.onclick = () => {
    if (!confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    stopPlayback();
    store.del(`audio:${item.id}`);
    if (isBeat) state.beat = null;
    else state.tracks = state.tracks.filter((t) => t !== item);
    markStale();
    saveMeta();
    renderLanes();
  };
  ctrls.append(del);
  head.append(name, ctrls);
  return head;
}

function renderLanes() {
  const lanes = $("lanes");
  lanes.innerHTML = "";
  const items = [...(state.beat ? [[state.beat, true]] : []), ...state.tracks.map((t) => [t, false])];
  for (const [item, isBeat] of items) {
    const lane = document.createElement("div");
    lane.className = `lane${isBeat ? " beat" : ""}`;
    const canvas = document.createElement("canvas");
    canvas._item = item;
    canvas._beat = isBeat;
    canvas.onpointerdown = (e) => seekFromEvent(e, canvas);
    lane.append(laneHead(item, isBeat), canvas);
    lanes.append(lane);
  }
  $("emptyHint").hidden = items.length > 0;
  renderRuler();
  drawLanes();
  placePlayhead(currentPos());
}

function seekFromEvent(e, el) {
  const r = el.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * viewDuration();
  const wasPlaying = !!state.playing && !state.recording;
  if (state.recording) return;
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
  const width = $("ruler").clientWidth;
  $("playhead").style.transform = `translateX(${(pos / viewDuration()) * width}px)`;
}

function drawLanes() {
  const dur = viewDuration();
  const dpr = window.devicePixelRatio || 1;
  for (const canvas of document.querySelectorAll(".lane canvas")) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w) continue;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d");
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const item = canvas._item;
    const off = item.offset || 0;
    const showProcessed = !canvas._beat && state.ab === "B" && item.processed;
    const buf = showProcessed ? item.processed.buffer : item.buffer;
    const data = buf.getChannelData(0);
    const x0 = (off / dur) * w;
    const x1 = ((off + buf.duration) / dur) * w;
    const spp = data.length / Math.max(1, x1 - x0);
    const mid = h / 2;
    const color = canvas._beat ? "rgba(255,138,61,0.55)" : showProcessed ? "rgba(25,211,197,0.95)" : "rgba(25,211,197,0.5)";
    g.fillStyle = color;
    const peak = showProcessed ? Math.max(1e-3, maxAbs(data)) : 1;
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x++) {
      const a = Math.floor((x - x0) * spp);
      const b = Math.min(data.length, Math.floor((x - x0 + 1) * spp));
      let mn = 0, mx = 0;
      for (let i = a; i < b; i += Math.max(1, Math.floor((b - a) / 64))) {
        const v = data[i] / peak;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      g.fillRect(x, mid - mx * mid * 0.9, 1, Math.max(1, (mx - mn) * mid * 0.9));
    }
    if (showProcessed) {
      // LUNA-style visible automation: the rider's gain curve over the take.
      const { rideCurve, deess, hop } = item.processed;
      const fpx = (hop / FS / dur) * w;
      g.strokeStyle = "#ff8a3d";
      g.lineWidth = 1.5;
      g.beginPath();
      rideCurve.forEach((db, i) => {
        const x = x0 + i * fpx;
        const y = mid - (Math.max(-20, Math.min(12, db)) / 20) * mid * 0.85;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
      g.fillStyle = "rgba(255,72,72,0.6)";
      deess.forEach((db, i) => {
        if (db < -1.5) g.fillRect(x0 + i * fpx, h - 4, Math.max(1, fpx), 4);
      });
    }
  }
}

function maxAbs(d) {
  let m = 0;
  for (let i = 0; i < d.length; i += 8) m = Math.max(m, Math.abs(d[i]));
  return m;
}

// ---------------------------------------------------------------- report
function renderReport() {
  const el = $("report");
  if (!state.master) return;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  let html = state.stale ? '<p class="stale">Takes changed since the last mix — run Automix again.</p>' : "";
  html += `<section class="master"><h4>Mix bus · ${MODES[state.mode].label}</h4><ul>${state.masterNotes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></section>`;
  for (const t of state.tracks) {
    if (!t.processed) continue;
    html += `<section><h4>${esc(t.name)} · ${ROLES[t.role].label}</h4><ul>${t.processed.report.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
    if (t.transcript) html += `<div class="transcript">“${esc(t.transcript)}”</div>`;
    html += "</section>";
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
    .map((line) => {
      const n = line.split(/\s+/).reduce((a, w) => a + syllables(w), 0);
      return n ? String(n) : "";
    })
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
  if (!state.recording) requestAnimationFrame(function loop() {
    if ($("prompter").hidden) return;
    prompterTick();
    requestAnimationFrame(loop);
  });
}
function prompterTick() {
  const now = performance.now();
  const el = $("prompterScroll");
  if ($("prompter").hidden) return;
  prompterY += (state.settings.scroll * (now - prompterLast)) / 1000;
  prompterLast = now;
  if (Math.abs(el.scrollTop - Math.floor(prompterY)) > 40) prompterY = el.scrollTop; // user scrolled
  el.scrollTop = prompterY;
}
const closePrompter = () => ($("prompter").hidden = true);

// ---------------------------------------------------------------- tabs + controls
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((p) => p.classList.toggle("on", p.dataset.panel === name));
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll("#modeSeg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === mode);
    b.setAttribute("aria-checked", b.dataset.mode === mode);
  });
  markStale();
  saveMeta();
}

function bindControls() {
  const s = state.settings;
  document.querySelectorAll("#modeSeg button").forEach((b) => (b.onclick = () => {
    setMode(b.dataset.mode);
    if (b.dataset.mode === "vo" && s.targetLufs === -14) {
      s.targetLufs = -16;
      $("target").value = "-16";
    }
  }));
  document.querySelectorAll("#abSeg button").forEach((b) => (b.onclick = () => setAB(b.dataset.ab)));
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
  for (const [k, r] of Object.entries(ROLES)) roleSel.add(new Option(r.label, k));
  roleSel.value = s.nextRole;
  roleSel.onchange = () => {
    s.nextRole = roleSel.value;
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
    el.onchange = markStale;
  };
  bindRange("balance", "balance", "balanceOut", (v) => `${v > 0 ? "+" : ""}${v} dB`);
  bindRange("space", "space", "spaceOut", (v) => `${Math.round(v * 100)}%`);
  bindRange("latency", "latencyMs", "latencyOut", (v) => `${v > 0 ? "+" : ""}${v} ms`);
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
      placePlayhead(currentPos());
    }, 120);
  });
  navigator.mediaDevices?.addEventListener?.("devicechange", listDevices);
}

// ---------------------------------------------------------------- boot
await restore();
setMode(state.mode);
bindControls();
renderLanes();
document.querySelector('#abSeg button[data-ab="A"]').classList.add("on");
status(state.tracks.length ? `Restored ${state.tracks.length} take(s). Hit Automix to re-engineer.` : "Ready. Drop a beat or hit R to record.");
window.__booth = { state, automix, importBeat, importVocal, toggleRecord, ctx };
