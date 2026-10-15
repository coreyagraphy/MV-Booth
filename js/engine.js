// Orchestrates the whole autonomous session:
//   TUNE → ALIGN → DOUBLE → CLEAN/TONE/DYNAMICS (per lane) → SPACE → MASTER
// and learns the voice across sessions (spectrum, range, key).
import { renderMix, renderVocal } from "./automix.js";
import { alignDouble, makeDoubles } from "./doubles.js";
import { STYLES, detectKey, keyLabel, trackPitch, tuneTake } from "./tune.js";

export const STAGES = [
  ["tune", "Tune"],
  ["align", "Align"],
  ["double", "Double"],
  ["clean", "Clean"],
  ["tone", "Tone"],
  ["dynamics", "Dynamics"],
  ["space", "Space"],
  ["master", "Master"],
];

const overlap = (a, b) =>
  Math.max(0, Math.min(a.offset + a.buffer.duration, b.offset + b.buffer.duration) - Math.max(a.offset, b.offset));

export async function runEngine({ tracks, beats = [], fs, mode, settings, profile, onStage, signal }) {
  const st = { tune: true, align: true, double: true, clean: true, tone: true, dynamics: true, space: true, master: true, ...(settings.stages || {}) };
  const stage = (key, p, msg, state) => {
    if (signal?.cancelled) throw new Error("Cancelled");
    onStage?.(key, p, msg, state);
  };
  const vocals = tracks.filter((t) => !t.mute && t.buffer);
  const style = st.tune ? settings.tuneStyle || "off" : "off";
  const prep = new Map();

  // 1. TUNE ------------------------------------------------------------------
  for (const [i, t] of vocals.entries()) {
    const x = t.buffer.getChannelData(0);
    const pitch = await trackPitch(x, fs, (p) => stage("tune", (i + p * 0.5) / vocals.length, `Tracking pitch · ${t.name}`));
    prep.set(t.id, { x, pitch, f0Out: pitch.f0, notes: [] });
  }
  let key;
  if (settings.key === "auto") {
    const pool = vocals.filter((t) => t.role === "lead" || t.role === "hook");
    key = detectKey((pool.length ? pool : vocals).map((t) => prep.get(t.id).pitch.f0));
    if (!key.confident && profile?.key) key = { ...profile.key, confident: false, remembered: true };
  } else {
    key = { tonic: +settings.key, scale: settings.scale || "minor", confident: true };
  }
  for (const [i, t] of vocals.entries()) {
    const pr = prep.get(t.id);
    if (style === "off" || t.tune === false) {
      pr.notes.push(`Pitch: correction off${t.tune === false ? " for this lane" : ""}`);
      continue;
    }
    const r = await tuneTake(pr.x, fs, pr.pitch, key, style, (p) => stage("tune", (i + 0.5 + p * 0.5) / vocals.length, `Correcting · ${t.name}`));
    pr.x = r.out;
    pr.f0Out = pr.pitch.f0.map((f, k) => (f ? f * Math.pow(2, r.shift[k] / 12) : 0));
    pr.target = r.target;
    pr.notes.push(`Pitch: ${STYLES[style].label} tune in ${keyLabel(key)} — moved ${Math.round(r.moved * 100)}% of sung frames, max ${r.maxShift.toFixed(2)} st`);
  }
  stage("tune", 1, `Key ${keyLabel(key)}`, style === "off" ? "skipped" : "done");

  // 2. ALIGN recorded doubles / stacks to the lead they sit on -----------------
  const leads = vocals.filter((t) => t.role === "lead");
  const followers = settings.alignDoubles === false || !st.align ? [] : vocals.filter((t) => t.role === "double" || t.role === "hook");
  for (const [i, t] of followers.entries()) {
    const lead = leads.map((l) => [l, overlap(l, t)]).sort((a, b) => b[1] - a[1])[0];
    if (!lead || lead[1] < 0.5) continue;
    const L = prep.get(lead[0].id);
    const pr = prep.get(t.id);
    const r = await alignDouble(
      { x: pr.x, offset: t.offset || 0 },
      { x: L.x, f0Out: L.f0Out, offset: lead[0].offset || 0 },
      fs,
      { tight: settings.alignTight ?? 0.9, onProgress: (p) => stage("align", (i + p) / followers.length, `Aligning ${t.name} → ${lead[0].name}`) },
    );
    pr.x = r.out;
    pr.notes.push(`Aligned to ${lead[0].name}: ${r.avgShiftMs.toFixed(0)} ms avg timing fix, pitch-matched ${Math.round(r.pitchMatched * 100)}% of sung frames`);
  }
  stage("align", 1, null, followers.length ? "done" : "skipped");

  // 3. DOUBLE — studio ADT doubles generated from each lead ---------------------
  const virtual = [];
  const wantDbl = st.double ? leads.filter((t) => t.dbl && t.dbl !== "off") : [];
  for (const [i, t] of wantDbl.entries()) {
    stage("double", i / wantDbl.length, `Generating doubles · ${t.name}`);
    const pr = prep.get(t.id);
    for (const d of await makeDoubles(pr.x, fs, pr.f0Out, t.dbl)) {
      const v = { id: `${t.id}:${d.key}`, name: `${d.name} (${t.name})`, role: d.role || "double", pan: d.pan, offset: t.offset || 0, fx: "clean", virtual: true, parent: t.id,
        // Doubles follow their lead: same cleanup (hum notch, no re-denoise of a cleaned take), fader and sends.
        clean: t.clean, trimDb: t.trimDb, revSend: t.revSend, dlySend: t.dlySend };
      prep.set(v.id, { x: d.x, pitch: pr.pitch, f0Out: pr.f0Out, notes: [`Generated from ${t.name}: ${d.key === "oct" ? "octave below" : `${d.pan < 0 ? "+9" : "−11"} cents, drifting 19–27 ms delay`}`] });
      virtual.push(v);
    }
  }
  stage("double", 1, null, wantDbl.length ? "done" : "skipped");

  // 4. Per-lane chain: CLEAN → TONE → DYNAMICS ---------------------------------
  const all = [...vocals, ...virtual];
  const processed = new Map();
  for (const [i, t] of all.entries()) {
    const pr = prep.get(t.id);
    const r = await renderVocal(t, pr.x, fs, mode, (p) => {
      const g = (i + p) / all.length;
      stage(p < 0.6 ? "clean" : p < 0.9 ? "tone" : "dynamics", g, `Engineering ${t.name}`);
    }, { profile, stages: { clean: st.clean, tone: st.tone, dynamics: st.dynamics }, clean: t.clean, f0: t.virtual ? null : pr.f0Out });
    r.report = [...pr.notes, ...r.report];
    r.pitch = { f0: pr.pitch.f0, f0Out: pr.f0Out, target: pr.target };
    processed.set(t.id, r);
  }
  stage("clean", 1, null, st.clean ? "done" : "skipped");
  stage("tone", 1, null, st.tone ? "done" : "skipped");
  stage("dynamics", 1, null, st.dynamics ? "done" : "skipped");

  // 5. SPACE + MASTER ------------------------------------------------------------
  stage("space", 0.3, "Balancing, unmasking, space");
  const end = Math.max(0, ...beats.map((b) => (b.offset || 0) + b.buffer.duration), ...all.map((t) => (t.offset || 0) + t.buffer?.duration || 0), ...virtual.map((v) => v.offset + prep.get(v.id).x.length / fs));
  const length = Math.ceil((end + 2) * fs);
  const mixInput = all.map((t) => ({ track: t, processed: processed.get(t.id) }));
  const mix = await renderMix({ vocals: mixInput, beats, fs, mode, settings, length });
  stage("space", 1, null, st.space ? "done" : "skipped");
  stage("master", 1, st.master ? "Mastered" : "Master stage off", st.master ? "done" : "skipped");

  // Learn: fold this session's lead analysis into the voice profile.
  const next = { ...(profile || {}), sessions: (profile?.sessions || 0) + 1 };
  for (const t of leads) {
    const l = processed.get(t.id).learned;
    const w = Math.min(0.5, l.seconds / 60);
    next.spectrum = next.spectrum ? Object.fromEntries(Object.keys(l.spectrum).map((k) => [k, next.spectrum[k] * (1 - w) + l.spectrum[k] * w])) : l.spectrum;
    next.f0 = next.f0 ? next.f0 * (1 - w) + l.f0 * w : l.f0;
    next.sibCentre = next.sibCentre ? next.sibCentre * (1 - w) + l.sibCentre * w : l.sibCentre;
  }
  if (key.confident) next.key = { tonic: key.tonic, scale: key.scale };
  return { mix, processed, virtual, mixInput, key, profile: next, length };
}

/** Re-render one stem from a finished engine run. */
export function renderStem(run, { beats, fs, mode, settings }, only) {
  return renderMix({ vocals: run.mixInput, beats, fs, mode, settings, length: run.length, only });
}
