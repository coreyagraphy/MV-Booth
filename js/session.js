// Session model: tracks → takes (immutable audio) → clips (non-destructive
// edits). Undo/redo snapshots, named sessions with trash, and rendering a
// track's comp into one buffer for the engine.
import * as store from "./store.js";

export const uid = () => Math.random().toString(36).slice(2, 10);
export const TRACK_COLORS = ["#12e0d0", "#ffb35c", "#8f7bff", "#ff5f8a", "#5fd38a", "#5ab4ff"];

export const DEFAULT_SETTINGS = {
  targetLufs: -14, balance: 0, space: 1, bpm: 0, latencyMs: 0, prompter: true, transcribe: false, scroll: 18,
  tuneStyle: "natural", key: "auto", scale: "minor", alignDoubles: true, alignTight: 0.9,
  reverb: "auto", delayDiv: "auto", click: false, clickLevel: 0.6, countIn: 1, snap: true, inputGainDb: 0,
  exportRate: 48000, preRoll: 1, masterTone: "neutral", width: 1, ceiling: -1,
  backendUrl: "http://127.0.0.1:8765",
  studio: { retuneMs: 60, vibrato: 0.8, amount: 1, formant: true, minConf: 0.5, model: "full" },
  stages: { tune: true, align: true, double: true, clean: true, tone: true, dynamics: true, space: true, master: true },
};

export function newSession(name = "Untitled session") {
  const now = Date.now();
  return {
    id: uid(), name, created: now, updated: now, mode: "rap",
    settings: structuredClone(DEFAULT_SETTINGS),
    lyrics: "", markers: [], loop: { on: false, start: 0, end: 8 }, punch: { on: false, in: 0, out: 0 },
    master: { volumeDb: 0 }, beats: [], tracks: [],
  };
}

// ---------------------------------------------------------------- beat stems
/** Beat stem roles. The role decides how Automix treats the stem under the vocal. */
export const STEM_KINDS = {
  full: { label: "Full beat", color: "#ff7a1a" },
  drums: { label: "Drums", color: "#ffb03a" },
  bass: { label: "808 / Bass", color: "#ff4f2e" },
  melody: { label: "Melody", color: "#ff9466" },
  fx: { label: "FX / Other", color: "#d98a5f" },
};
// Whole words only; "_", "-" and digits count as separators (stem files are named "02_Kick-Loop").
const W = (words) => new RegExp(`(?<![a-z])(?:${words})(?![a-z])`, "i");
const STEM_WORDS = [
  ["bass", W("808s?|bass|sub|subs|low ?end")],
  ["drums", W("drums?|kicks?|snares?|claps?|hats?|hi ?hats?|hh|oh|perc|percussion|rims?|cymbals?|crash|ride|toms?|shakers?|drum ?loop")],
  ["fx", W("fx|sfx|risers?|impacts?|sweeps?|vox|chants?|transitions?|noise|ambience")],
  ["melody", W("melody|melodies|melodic|keys|piano|synths?|pads?|guitars?|gtr|strings?|leads?|chords?|bells?|plucks?|flutes?|horns?|brass|organ|samples?|arps?|loop")],
  ["full", W("beat|instrumental|inst|2 ?track|stereo ?mix|full ?mix|full|master")],
];
/** Guess a stem's role from its file name; null when the name says nothing. */
export function guessStemKind(name) {
  for (const [k, re] of STEM_WORDS) if (re.test(name)) return k;
  return null;
}
export function newBeat(id, name, kind = "full") {
  return { id, name, kind: STEM_KINDS[kind] ? kind : "full", volumeDb: 0, pan: 0, mute: false, solo: false, offset: 0 };
}
/** Sessions before 2.5 had one `beat`; it becomes the first stem. */
export function migrateBeats(s) {
  if (!Array.isArray(s.beats)) s.beats = s.beat ? [{ ...newBeat(s.beat.id, s.beat.name), ...s.beat, kind: "full" }] : [];
  delete s.beat;
  return s;
}

export function newTrack(session, type = "lead") {
  const n = session.tracks.filter((t) => t.type === type).length + 1;
  const label = { lead: "Lead", double: "Double", adlib: "Ad-lib", hook: "Hook" }[type] || "Vocal";
  return {
    id: uid(), name: `${label} ${n}`, type, color: TRACK_COLORS[session.tracks.length % TRACK_COLORS.length],
    armed: false, volumeDb: 0, pan: 0, mute: false, solo: false, fx: "clean", tune: true, dbl: "off",
    revSend: 1, dlySend: 1, showTakes: false, takes: [], clips: [],
  };
}

// ---------------------------------------------------------------- clips

/** Carve [s, e) out of a track's clips (playlist-style overwrite). */
export function carve(track, s, e) {
  const out = [];
  for (const c of track.clips) {
    if (c.end <= s || c.start >= e) out.push(c);
    else {
      if (c.start < s) out.push({ ...c, id: uid(), end: s, fadeOut: 0.005 });
      if (c.end > e) out.push({ ...c, id: uid(), start: e, fadeIn: 0.005 });
    }
  }
  track.clips = out.sort((a, b) => a.start - b.start);
}

export function addTakeClip(track, take) {
  carve(track, take.at, take.at + take.duration);
  track.clips.push({ id: uid(), takeId: take.id, start: take.at, end: take.at + take.duration, shift: 0, gainDb: 0, fadeIn: 0.005, fadeOut: 0.01 });
  track.clips.sort((a, b) => a.start - b.start);
}

/**
 * Place a punched take: it covers [pin − xf, pout + xf]; the new clip and the
 * existing audio overlap by `xf` at both boundaries with complementary fades,
 * so the edit is a click-free crossfade.
 */
export function addPunchClip(track, take, pin, pout, xf = 0.01) {
  const h = xf / 2;
  carve(track, pin + h, pout - h);
  for (const c of track.clips) {
    if (Math.abs(c.end - (pin + h)) < 1e-6) c.fadeOut = xf;
    if (Math.abs(c.start - (pout - h)) < 1e-6) c.fadeIn = xf;
  }
  track.clips.push({ id: uid(), takeId: take.id, start: pin - h, end: pout + h, shift: 0, gainDb: 0, fadeIn: xf, fadeOut: xf, punch: true });
  track.clips.sort((a, b) => a.start - b.start);
}

export function useWholeTake(track, take) {
  track.clips = [];
  addTakeClip(track, take);
}

export function splitClip(track, clipId, at) {
  const c = track.clips.find((x) => x.id === clipId);
  if (!c || at <= c.start + 0.01 || at >= c.end - 0.01) return null;
  const right = { ...c, id: uid(), start: at, fadeIn: 0.005 };
  c.end = at;
  c.fadeOut = 0.005;
  track.clips.push(right);
  track.clips.sort((a, b) => a.start - b.start);
  return right;
}

export const clipAt = (track, t) => track.clips.find((c) => t >= c.start && t < c.end);
export const trackStart = (track) => (track.clips.length ? Math.min(...track.clips.map((c) => c.start)) : 0);
export const trackEnd = (track) => (track.clips.length ? Math.max(...track.clips.map((c) => c.end)) : 0);

/** Render the comp (clips + gain + fades) into one mono buffer for the engine. */
export function renderTrack(track, audio, fs) {
  const clips = track.clips.filter((c) => audio.get(c.takeId));
  if (!clips.length) return null;
  const start = Math.min(...clips.map((c) => c.start));
  const end = Math.max(...clips.map((c) => c.end));
  const out = new Float32Array(Math.ceil((end - start) * fs));
  for (const c of clips) {
    const take = track.takes.find((t) => t.id === c.takeId);
    const src = audio.get(c.takeId).getChannelData(0);
    const g = Math.pow(10, (c.gainDb || 0) / 20);
    const n = Math.round((c.end - c.start) * fs);
    const fi = Math.max(1, Math.round(Math.max(0.003, c.fadeIn || 0) * fs));
    const fo = Math.max(1, Math.round(Math.max(0.003, c.fadeOut || 0) * fs));
    const dst0 = Math.round((c.start - start) * fs);
    const src0 = Math.round((c.start - (c.shift || 0) - take.at) * fs);
    for (let i = 0; i < n; i++) {
      const si = src0 + i;
      const di = dst0 + i;
      if (si < 0 || si >= src.length || di >= out.length) continue;
      let w = g;
      if (i < fi) w *= i / fi;
      if (n - i < fo) w *= (n - i) / fo;
      out[di] += src[si] * w;
    }
  }
  return { data: out, offset: start };
}

// ---------------------------------------------------------------- undo

export class History {
  constructor(limit = 50) {
    this.undoStack = [];
    this.redoStack = [];
    this.limit = limit;
    this.lastKey = null;
    this.lastAt = 0;
  }
  /** Snapshot before a change. Same `key` within 800 ms coalesces (slider drags). */
  push(session, label, key = null) {
    const now = Date.now();
    if (key && key === this.lastKey && now - this.lastAt < 800) {
      this.lastAt = now;
      return;
    }
    this.lastKey = key;
    this.lastAt = now;
    this.undoStack.push({ label, snap: JSON.stringify(session) });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(session) {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, snap: JSON.stringify(session) });
    this.lastKey = null;
    return { session: JSON.parse(e.snap), label: e.label };
  }
  redo(session) {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, snap: JSON.stringify(session) });
    this.lastKey = null;
    return { session: JSON.parse(e.snap), label: e.label };
  }
}

// ---------------------------------------------------------------- persistence

const TRASH_DAYS = 30;

export async function listSessions() {
  const idx = (await store.get("sessions")) || [];
  const cutoff = Date.now() - TRASH_DAYS * 864e5;
  const keep = idx.filter((s) => !s.deletedAt || s.deletedAt > cutoff);
  if (keep.length !== idx.length) {
    for (const s of idx.filter((x) => !keep.includes(x))) await purgeSession(s.id);
    await store.set("sessions", keep);
  }
  return keep;
}

async function purgeSession(id) {
  const s = await store.get(`session:${id}`);
  if (s) {
    for (const t of s.tracks) for (const tk of t.takes) await store.del(`audio:${tk.id}`);
    migrateBeats(s);
    for (const b of s.beats) await store.del(`audio:${b.id}`);
  }
  await store.del(`session:${id}`);
}

export async function saveSession(session) {
  session.updated = Date.now();
  await store.set(`session:${session.id}`, session);
  const idx = (await store.get("sessions")) || [];
  const row = { id: session.id, name: session.name, updated: session.updated };
  const i = idx.findIndex((s) => s.id === session.id);
  if (i >= 0) idx[i] = { ...idx[i], ...row };
  else idx.unshift(row);
  await store.set("sessions", idx);
  await store.set("currentSession", session.id);
}

export async function loadSession(id) {
  const s = await store.get(`session:${id}`);
  if (!s) return null;
  s.settings = {
    ...structuredClone(DEFAULT_SETTINGS), ...s.settings,
    stages: { ...DEFAULT_SETTINGS.stages, ...(s.settings?.stages || {}) },
    studio: { ...DEFAULT_SETTINGS.studio, ...(s.settings?.studio || {}) },
  };
  s.punch ??= { on: false, in: 0, out: 0 };
  return migrateBeats(s);
}

export async function trashSession(id, deleted = true) {
  const idx = (await store.get("sessions")) || [];
  const row = idx.find((s) => s.id === id);
  if (row) row.deletedAt = deleted ? Date.now() : undefined;
  await store.set("sessions", idx);
}

/** Copy a session; audio is immutable, so takes can share their stored audio. */
export function duplicateSession(session) {
  const copy = structuredClone(session);
  copy.id = uid();
  copy.name = `${session.name} (copy)`;
  copy.created = copy.updated = Date.now();
  return copy;
}

/** One-time import of the v2.0 single-project format. */
export async function migrateLegacy() {
  const p = await store.get("project");
  if (!p || (await store.get("sessions"))?.length) return null;
  const s = newSession("Session 1");
  s.mode = p.mode || "rap";
  s.settings = { ...s.settings, ...(p.settings || {}) };
  s.lyrics = p.lyrics || "";
  if (p.beat) s.beats.push({ ...newBeat(p.beat.id, p.beat.name), mute: !!p.beat.mute, offset: p.beat.offset || 0 });
  for (const old of p.tracks || []) {
    const rec = await store.get(`audio:${old.id}`);
    if (!rec) continue;
    const t = newTrack(s, ["lead", "double", "adlib", "hook"].includes(old.role) ? old.role : "lead");
    Object.assign(t, { name: old.name, mute: !!old.mute, solo: !!old.solo, fx: old.fx || "clean", tune: old.tune !== false, dbl: old.dbl || "off", pan: old.pan || 0 });
    const take = { id: old.id, name: "Take 1", at: old.offset || 0, duration: rec.channels[0].length / rec.sampleRate, best: true, transcript: old.transcript || "" };
    t.takes.push(take);
    addTakeClip(t, take);
    s.tracks.push(t);
  }
  await saveSession(s);
  await store.del("project");
  return s;
}
