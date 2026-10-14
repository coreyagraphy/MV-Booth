// The autonomous engineer. Three stages, each one a reverse-engineered
// version of a commercial tool:
//   1. analyseVocal   – Nectar "Vocal Assistant": learns the voice (F0, tone, dynamics)
//   2. renderVocal    – LUNA "VoiceAssist": gain riding, de-essing, breath/noise control
//   3. renderMix      – RoEx "Automix": level balance, unmasking, space, master to target
import {
  BANDS,
  bandSpectrum,
  clamp,
  dbToLin,
  denoise,
  estimateBpm,
  fft,
  frameF0,
  hann,
  integratedLoudness,
  limit,
  linToDb,
  lookaheadMax,
  loudnessEnvelope,
  percentile,
  samplePeak,
  smoothCurve,
  tick,
} from "./dsp.js";

export const MODES = {
  rap: {
    label: "Rap / Vocal",
    nrFloorDb: -12,
    gateDb: -10,
    breathDb: -7,
    rideRange: 6,
    rideAmount: 0.75,
    deessMax: 8,
    comp: { ratio: 4, attack: 0.004, release: 0.08, knee: 6, threshold: -25 },
    grit: 0.18,
    eqTarget: { 250: 5, 500: 3.5, 1000: 0, 2000: -3.5, 3200: -5.5, 6000: -8.5, 10000: -13 },
    reverb: { seconds: 1.15, preDelay: 0.022, sendDb: -17 },
    delay: { division: 1, sendDb: -24, feedback: 0.28 },
    beatOffsetLu: -1, // beat loudness relative to the lead vocal
    duckDb: 0.8,
    vocalLufs: -18,
  },
  vo: {
    label: "Voice-over",
    nrFloorDb: -18,
    gateDb: -18,
    breathDb: -12,
    rideRange: 8,
    rideAmount: 0.85,
    deessMax: 7,
    comp: { ratio: 3, attack: 0.008, release: 0.14, knee: 10, threshold: -24 },
    grit: 0,
    eqTarget: { 250: 6, 500: 4, 1000: 0, 2000: -4, 3200: -6.5, 6000: -9.5, 10000: -15 },
    reverb: { seconds: 0.35, preDelay: 0.008, sendDb: -28 },
    delay: null,
    beatOffsetLu: -13, // music bed sits well under the voice
    duckDb: 6,
    vocalLufs: -18,
  },
};

export const ROLES = {
  lead: { label: "Lead", levelDb: 0, pan: 0, hpBoost: 0, reverbDb: 0, delayDb: 0, deessMult: 1 },
  double: { label: "Double", levelDb: -7, pan: 0.38, hpBoost: 60, reverbDb: -4, delayDb: -60, deessMult: 1.7 },
  adlib: { label: "Ad-lib", levelDb: -5, pan: 0.6, hpBoost: 40, reverbDb: 5, delayDb: 6, deessMult: 1.2 },
  hook: { label: "Hook stack", levelDb: -3, pan: 0.25, hpBoost: 20, reverbDb: 2, delayDb: -3, deessMult: 1.3 },
  octave: { label: "Octave", levelDb: -13, pan: 0, hpBoost: 0, reverbDb: -6, delayDb: -60, deessMult: 2, hidden: true },
};

export const FX = { clean: "Clean", phone: "Phone", wide: "Wide (Haas)" };

const HOP = 512; // analysis hop (~10.7 ms @ 48 kHz)

// ---------------------------------------------------------------- 1. analysis

export async function analyseVocal(raw, fs, mode, onProgress) {
  const preset = MODES[mode];
  const nr = await denoise(raw, fs, {
    floorDb: preset.nrFloorDb,
    onProgress: (p) => onProgress?.(p * 0.6),
  });
  const x = nr.out;
  const frames = Math.ceil(x.length / HOP);
  const N = 2048;
  const win = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const rms = new Float32Array(frames);
  const sibDb = new Float32Array(frames);
  const sibRatio = new Float32Array(frames);
  const flat = new Float32Array(frames);
  const lowRatio = new Float32Array(frames);
  const kP = Math.max(1, Math.floor((150 * N) / fs));
  const kLo = Math.floor((300 * N) / fs);
  const kHi = Math.floor((8000 * N) / fs);
  const kS0 = Math.floor((4500 * N) / fs);
  const kS1 = Math.min(N / 2, Math.floor((10500 * N) / fs));
  let sibCentroidNum = 0;
  let sibCentroidDen = 0;

  for (let f = 0; f < frames; f++) {
    const start = f * HOP - N / 2 + HOP / 2;
    let tsum = 0;
    for (let i = 0; i < N; i++) {
      const s = x[start + i] || 0;
      re[i] = s * win[i];
      im[i] = 0;
      tsum += s * s;
    }
    rms[f] = 10 * Math.log10(Math.max(tsum / N, 1e-12));
    fft(re, im);
    let total = 1e-20, sib = 1e-20, logSum = 0, linSum = 0, cnum = 0, low = 1e-20;
    for (let k = 1; k <= N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      total += p;
      if (k <= kP) low += p;
      if (k >= kS0 && k <= kS1) {
        sib += p;
        cnum += p * ((k * fs) / N);
      }
      if (k >= kLo && k <= kHi) {
        const m = Math.sqrt(p) + 1e-12;
        logSum += Math.log(m);
        linSum += m;
      }
    }
    const count = kHi - kLo + 1;
    flat[f] = Math.exp(logSum / count) / (linSum / count);
    sibDb[f] = 10 * Math.log10(sib / N);
    sibRatio[f] = 10 * Math.log10(sib / total);
    lowRatio[f] = 10 * Math.log10(low / total);
    if (sibRatio[f] > -10) {
      sibCentroidNum += cnum;
      sibCentroidDen += sib;
    }
    if (f % 4000 === 0) {
      onProgress?.(0.6 + (f / frames) * 0.3);
      await tick();
    }
  }

  const noiseDb = percentile(rms, 0.1);
  const speechDb = percentile(rms, 0.95);
  const span = Math.max(1, speechDb - noiseDb);
  const activeThresh = noiseDb + Math.max(9, span * 0.32);
  const active = new Uint8Array(frames);
  const breath = new Uint8Array(frames);
  // Breath = noise-like (flat spectrum), clearly quieter than speech, above the floor.
  for (let f = 0; f < frames; f++) {
    if (rms[f] > noiseDb + 5 && rms[f] > speechDb - 45 && rms[f] < speechDb - 20 && flat[f] > 0.3) breath[f] = 1;
    else if (rms[f] > activeThresh) active[f] = 1;
  }
  // Breaths are 120 ms – 900 ms islands; shorter blips are consonant tails.
  let breaths = 0;
  for (let f = 0; f < frames; ) {
    if (!breath[f]) {
      f++;
      continue;
    }
    let e = f;
    while (e < frames && breath[e]) e++;
    const dur = ((e - f) * HOP) / fs;
    if (dur < 0.12 || dur > 0.9) {
      for (let k = f; k < e; k++) {
        breath[k] = 0;
        if (rms[k] > activeThresh) active[k] = 1;
      }
    } else breaths++;
    f = e;
  }

  const activeRms = [];
  for (let f = 0; f < frames; f++) if (active[f]) activeRms.push(rms[f]);
  const activeLevel = activeRms.length ? percentile(activeRms, 0.5) : speechDb;
  const dynRange = activeRms.length ? percentile(activeRms, 0.95) - percentile(activeRms, 0.3) : 6;

  // Pitch: sample voiced frames for F0 statistics.
  const f0s = [];
  for (let f = 0; f < frames; f += 6) {
    if (active[f] && flat[f] < 0.3) {
      const v = frameF0(x, f * HOP, fs);
      if (v) f0s.push(v);
    }
  }
  const f0Median = f0s.length ? percentile(f0s, 0.5) : 140;
  const f0Low = f0s.length ? percentile(f0s, 0.1) : 100;

  // Plosives: a burst where sub-150 Hz energy dominates right at an onset.
  const plosive = new Uint8Array(frames);
  let plosives = 0;
  for (let f = 3; f < frames; f++) {
    if (active[f] && lowRatio[f] > -4 && rms[f] - rms[f - 3] > 8) {
      plosives++;
      plosive.fill(1, f - 1, Math.min(frames, f + 5));
      f += 8;
    }
  }
  let activeFrames = 0;
  for (let f = 0; f < frames; f++) activeFrames += active[f];

  const spectrum = bandSpectrum(x, fs, (start) => active[Math.floor(start / HOP)] === 1).bands;
  const sibCentre = sibCentroidDen > 0 ? clamp(sibCentroidNum / sibCentroidDen, 4800, 9500) : 6500;
  onProgress?.(1);

  return {
    clean: x,
    nr,
    frames,
    rms,
    sibDb,
    sibRatio,
    active,
    breath,
    breaths,
    noiseDb,
    speechDb,
    activeLevel,
    dynRange,
    f0Median,
    f0Low,
    spectrum,
    sibCentre,
    plosive,
    plosives,
    activeSec: (activeFrames * HOP) / fs,
  };
}

// ---------------------------------------------------------------- 2. vocal chain

function decideEq(an, mode, role, profile) {
  const preset = MODES[mode];
  let s = an.spectrum;
  if (profile?.spectrum) {
    // Short takes lean on what the engine has learned about this voice.
    const w = clamp(an.activeSec / 20, 0.25, 1);
    s = Object.fromEntries(Object.keys(s).map((k) => [k, s[k] * w + (profile.spectrum[k] ?? s[k]) * (1 - w)]));
  }
  const rel = (fc) => s[fc] - s[1000];
  const corr = (fc, lo, hi, bias = 0) => clamp((preset.eqTarget[fc] - rel(fc)) * 0.6 + bias, lo, hi);
  const hpf = clamp(an.f0Low * 0.72, mode === "vo" ? 60 : 75, 150) + ROLES[role].hpBoost;
  return {
    hpf: Math.round(hpf),
    mud: +corr(250, -5, 2).toFixed(1),
    box: +corr(500, -4, 1.5).toFixed(1),
    presence: +corr(3200, -3, 4, mode === "rap" ? 0.8 : 0).toFixed(1),
    air: +corr(10000, -3, 4.5, mode === "rap" ? 0.5 : 0).toFixed(1),
  };
}

function gainCurve(an, fs, mode) {
  const preset = MODES[mode];
  const env = loudnessEnvelope(an.clean, fs, HOP, 0.3);
  const activeLoud = [];
  for (let f = 0; f < an.frames; f++) if (an.active[f]) activeLoud.push(env[f]);
  const ref = activeLoud.length ? percentile(activeLoud, 0.55) : -20;
  const curve = new Float32Array(an.frames);
  let rideMin = 0, rideMax = 0;
  for (let f = 0; f < an.frames; f++) {
    if (an.active[f]) {
      const ride = clamp((ref - env[f]) * preset.rideAmount, -preset.rideRange, preset.rideRange);
      curve[f] = ride;
      rideMin = Math.min(rideMin, ride);
      rideMax = Math.max(rideMax, ride);
    } else {
      curve[f] = an.breath[f] ? preset.breathDb : preset.gateDb;
    }
  }
  // Open ~30 ms early, rise in ~20 ms, fall in ~90 ms.
  const shaped = smoothCurve(lookaheadMax(curve, 3), 0.45, 0.11);
  return { curve: shaped, rideMin, rideMax };
}

function deessCurve(an, mode, mult = 1) {
  const preset = MODES[mode];
  const out = new Float32Array(an.frames);
  let events = 0;
  let maxCut = 0;
  let on = false;
  for (let f = 0; f < an.frames; f++) {
    let cut = 0;
    if (an.active[f] && an.sibDb[f] > an.speechDb - 26) {
      cut = clamp((an.sibRatio[f] + 11) * 0.9 * mult, 0, preset.deessMax * mult);
    }
    if (cut > 1 && !on) events++;
    on = cut > 1;
    maxCut = Math.max(maxCut, cut);
    out[f] = -cut;
  }
  return { curve: smoothCurve(out, 0.2, 0.7).map((v) => Math.min(0, v)), events, maxCut };
}

function makeImpulse(ctx, seconds, preset) {
  const fs = ctx.sampleRate;
  const len = Math.max(1, Math.round(seconds * fs * 1.4));
  const ir = ctx.createBuffer(2, len, fs);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    let seed = 1234567 + c * 98765;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const n = seed / 2147483648 - 1;
      const t = i / fs;
      const damp = 0.15 + 0.8 * Math.min(1, t / seconds); // tail darkens over time
      lp += (n - lp) * (1 - damp);
      d[i] = lp * Math.exp((-6.9 * t) / seconds) * (preset === "vo" ? 0.6 : 1);
    }
  }
  return ir;
}

function curveToGain(curveDb, extraDb = 0) {
  const g = new Float32Array(curveDb.length);
  for (let i = 0; i < g.length; i++) g[i] = dbToLin(curveDb[i] + extraDb);
  return g;
}

/** Render the processed, panned vocal for one track. */
export async function renderVocal(track, raw, fs, mode, onProgress, { profile } = {}) {
  const an = await analyseVocal(raw, fs, mode, (p) => onProgress?.(p * 0.85));
  const preset = MODES[mode];
  const role = ROLES[track.role] ? track.role : "lead";
  const eq = decideEq(an, mode, role, profile);
  const ride = gainCurve(an, fs, mode);
  const ds = deessCurve(an, mode, ROLES[role].deessMult);
  const preGainDb = clamp(-20 - an.activeLevel, -12, 36);
  const threshold = preset.comp.threshold - clamp((an.dynRange - 8) * 0.4, 0, 4);

  const ctx = new OfflineAudioContext(2, an.clean.length, fs);
  const buf = ctx.createBuffer(1, an.clean.length, fs);
  buf.copyToChannel(an.clean, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const dur = an.clean.length / fs;

  const rider = ctx.createGain();
  rider.gain.value = dbToLin(preGainDb);
  if (ride.curve.length > 1) rider.gain.setValueCurveAtTime(curveToGain(ride.curve, preGainDb), 0, dur);

  const nodes = [rider];
  const biq = (type, freq, q, gain = 0) => {
    const n = ctx.createBiquadFilter();
    n.type = type;
    n.frequency.value = freq;
    n.Q.value = q;
    n.gain.value = gain;
    nodes.push(n);
    return n;
  };
  biq("highpass", eq.hpf, 0.707);
  biq("highpass", eq.hpf, 0.707);
  const pop = biq("highpass", 20, 0.8);
  if (an.plosives) pop.frequency.setValueCurveAtTime(smoothCurve(Float32Array.from(an.plosive, (p) => (p ? 260 : 20)), 0.6, 0.25), 0, dur);
  biq("peaking", 250, 1.0, eq.mud);
  biq("peaking", 500, 1.2, eq.box);
  biq("peaking", 3200, 0.9, eq.presence);
  biq("highshelf", 10000, 0.707, eq.air);
  const deesser = biq("peaking", an.sibCentre, 1.4, 0);
  if (ds.curve.length > 1) deesser.gain.setValueCurveAtTime(ds.curve, 0, dur);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = threshold;
  comp.ratio.value = preset.comp.ratio;
  comp.attack.value = preset.comp.attack;
  comp.release.value = preset.comp.release;
  comp.knee.value = preset.comp.knee;
  nodes.push(comp);

  src.connect(nodes[0]);
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);

  const pan = ctx.createStereoPanner();
  pan.pan.value = 0; // placement happens in the mix stage
  comp.connect(pan);
  if (preset.grit > 0) {
    const shaper = ctx.createWaveShaper();
    const k = 2.5;
    const c = new Float32Array(2048);
    for (let i = 0; i < c.length; i++) {
      const v = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.tanh(k * v) / Math.tanh(k);
    }
    shaper.curve = c;
    shaper.oversample = "4x";
    const drive = ctx.createGain();
    drive.gain.value = 4;
    const wet = ctx.createGain();
    wet.gain.value = preset.grit / 4;
    comp.connect(drive).connect(shaper).connect(wet).connect(pan);
  }
  if (track.fx === "phone") {
    // Lo-fi phone/megaphone: band-limit and drive, no dry signal.
    pan.disconnect();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 480;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3100;
    const sh = ctx.createWaveShaper();
    sh.curve = Float32Array.from({ length: 1024 }, (_, i) => Math.tanh(5 * ((i / 1023) * 2 - 1)) / Math.tanh(5));
    const pre = ctx.createGain();
    pre.gain.value = 3;
    const post = ctx.createGain();
    post.gain.value = 0.5;
    pan.connect(hp).connect(lp).connect(pre).connect(sh).connect(post).connect(ctx.destination);
  } else {
    pan.connect(ctx.destination);
  }
  src.start(0);
  const rendered = await ctx.startRendering();
  onProgress?.(1);

  const L = rendered.getChannelData(0);
  const R = rendered.getChannelData(1);
  const lufs = integratedLoudness([L, R], fs);
  const ratio = preset.comp.ratio;
  return {
    buffer: rendered,
    lufs,
    rideCurve: ride.curve,
    deess: ds.curve,
    hop: HOP,
    learned: { spectrum: an.spectrum, f0: an.f0Median, sibCentre: an.sibCentre, seconds: an.activeSec },
    report: [
      an.nr.applied
        ? `Noise reduction: ${an.nr.reductionDb.toFixed(1)} dB avg mask (input SNR ${an.nr.snrDb.toFixed(0)} dB)`
        : `Noise reduction: skipped — take is clean (SNR ${an.nr.snrDb.toFixed(0)} dB)`,
      `Voice: F0 ≈ ${Math.round(an.f0Median)} Hz → low cut ${eq.hpf} Hz (24 dB/oct)`,
      `Tone EQ: 250 Hz ${fmt(eq.mud)} · 500 Hz ${fmt(eq.box)} · 3.2 kHz ${fmt(eq.presence)} · air ${fmt(eq.air)}`,
      `De-ess: ${ds.events} events @ ${(an.sibCentre / 1000).toFixed(1)} kHz, deepest ${ds.maxCut.toFixed(1)} dB`,
      `Breaths tamed: ${an.breaths} (${preset.breathDb} dB) · gaps gated ${preset.gateDb} dB`,
      `Plosives caught: ${an.plosives} (dynamic 260 Hz high-pass on each pop)`,
      `Vocal rider: ${ride.rideMin.toFixed(1)} … +${ride.rideMax.toFixed(1)} dB automation`,
      `Compressor: ${ratio}:1 @ ${threshold.toFixed(1)} dB${preset.grit ? ` + ${Math.round(preset.grit * 100)}% parallel grit` : ""}`,
      ...(track.fx === "phone" ? ["FX: phone band-pass 480 Hz–3.1 kHz + drive"] : []),
    ],
  };
}

const fmt = (v) => `${v > 0 ? "+" : ""}${v} dB`;

// ---------------------------------------------------------------- 3. mix + master

function activityEnvelope(buffer) {
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const frames = Math.ceil(L.length / HOP);
  const raw = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const end = Math.min(L.length, (f + 1) * HOP);
    for (let i = f * HOP; i < end; i++) s += L[i] * L[i] + R[i] * R[i];
    raw[f] = 10 * Math.log10(Math.max(s / (2 * HOP), 1e-12)) > -45 ? 1 : 0;
  }
  return smoothCurve(lookaheadMax(raw, 2), 0.5, 0.04);
}

/**
 * Build the full mix. `vocals` = [{ track, processed }], `beat` = AudioBuffer|null.
 * `opts.only` renders a single stem; `opts.raw` skips mastering.
 */
export async function renderMix({ vocals, beat, beatTrack, fs, mode, settings, length, only = null }) {
  const preset = MODES[mode];
  const balance = settings.balance ?? 0; // + = vocal louder vs beat
  const space = settings.space ?? 1;
  const ctx = new OfflineAudioContext(2, length, fs);
  const bus = ctx.createGain();
  const notes = [];

  // Shared space: plate/room + tempo delay.
  const pre = ctx.createDelay(1);
  pre.delayTime.value = preset.reverb.preDelay;
  const verbHp = ctx.createBiquadFilter();
  verbHp.type = "highpass";
  verbHp.frequency.value = 320;
  const verbLp = ctx.createBiquadFilter();
  verbLp.type = "lowpass";
  verbLp.frequency.value = 7500;
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulse(ctx, preset.reverb.seconds, mode);
  const verbReturn = ctx.createGain(); // ducked under the lead so the tail blooms in the gaps
  pre.connect(verbHp).connect(verbLp).connect(conv).connect(verbReturn).connect(bus);

  const bpm = settings.bpm || 0;
  let delayIn = null;
  if (preset.delay && bpm) {
    const dt = clamp(((60 / bpm) * preset.delay.division), 0.08, 1.5);
    const d = ctx.createDelay(2);
    d.delayTime.value = dt;
    const fb = ctx.createGain();
    fb.gain.value = preset.delay.feedback;
    const dhp = ctx.createBiquadFilter();
    dhp.type = "highpass";
    dhp.frequency.value = 500;
    const dlp = ctx.createBiquadFilter();
    dlp.type = "lowpass";
    dlp.frequency.value = 4200;
    delayIn = ctx.createGain();
    delayIn.connect(dhp).connect(d).connect(dlp).connect(fb).connect(d);
    dlp.connect(bus);
    notes.push(`Delay: 1/4 note @ ${bpm} BPM = ${Math.round(dt * 1000)} ms, filtered 500 Hz–4.2 kHz`);
  }
  notes.push(`Space: ${preset.reverb.seconds}s ${mode === "vo" ? "room" : "plate"}, pre-delay ${Math.round(preset.reverb.preDelay * 1000)} ms, ×${space.toFixed(2)} send`);

  // Vocals ------------------------------------------------------------
  const leadLufs = [];
  const activity = new Float32Array(Math.ceil(length / HOP));
  let panFlip = 1;
  let throws = 0;
  for (const { track, processed } of vocals) {
    const role = ROLES[track.role] || ROLES.lead;
    const targetLufs = preset.vocalLufs + role.levelDb + (track.trimDb || 0);
    const gainDb = clamp(targetLufs - processed.lufs, -30, 30);
    if (track.role === "lead") leadLufs.push(targetLufs);
    if (track.role === "lead" || track.role === "hook") {
      const env = activityEnvelope(processed.buffer);
      const off = Math.round(((track.offset || 0) * fs) / HOP);
      for (let i = 0; i < env.length && i + off < activity.length; i++) activity[i + off] = Math.max(activity[i + off], env[i]);
    }
    const panAmt = track.pan ? track.pan : role.pan * panFlip;
    if (role.pan) panFlip *= -1;
    if (only && only !== track.id) continue;
    const src = ctx.createBufferSource();
    src.buffer = processed.buffer;
    const g = ctx.createGain();
    g.gain.value = dbToLin(gainDb);
    let p;
    if (track.fx === "wide") {
      // Haas widening: same signal, right side 14 ms late.
      const split = ctx.createChannelSplitter(2);
      p = ctx.createChannelMerger(2);
      const haas = ctx.createDelay(0.05);
      haas.delayTime.value = 0.014;
      src.connect(g).connect(split);
      split.connect(p, 0, 0);
      split.connect(haas, 1).connect(p, 0, 1);
      p.connect(bus);
    } else {
      p = ctx.createStereoPanner();
      p.pan.value = clamp(panAmt, -1, 1);
      src.connect(g).connect(p).connect(bus);
    }
    const rs = ctx.createGain();
    rs.gain.value = dbToLin(preset.reverb.sendDb + role.reverbDb) * space;
    p.connect(rs).connect(pre);
    if (delayIn && role.delayDb > -40) {
      const ds = ctx.createGain();
      const base = dbToLin(preset.delay.sendDb + role.delayDb) * space;
      ds.gain.value = base;
      if (track.role === "lead" && mode === "rap") {
        // Delay throws: open the send on the last word of each phrase.
        const env = activityEnvelope(processed.buffer);
        const curve = new Float32Array(env.length).fill(base);
        const fps = fs / HOP;
        let run = 0;
        for (let i = 1; i < env.length; i++) {
          if (env[i] >= 0.5) run++;
          else if (env[i - 1] >= 0.5) {
            if (run > 0.8 * fps) {
              throws++;
              for (let k = Math.max(0, i - Math.round(0.3 * fps)); k < Math.min(env.length, i + Math.round(0.05 * fps)); k++) curve[k] = base * dbToLin(11);
            }
            run = 0;
          }
        }
        const sm = smoothCurve(curve, 0.3, 0.15);
        if (sm.length > 1) ds.gain.setValueCurveAtTime(sm, track.offset || 0, (sm.length * HOP) / fs);
      }
      p.connect(ds).connect(delayIn);
    }
    src.start(track.offset || 0);
  }

  if (activity.length > 1) {
    verbReturn.gain.setValueCurveAtTime(activity.map((a) => 1 - 0.5 * a), 0, length / fs);
    notes.push("Reverb ducking: tail drops 6 dB under the lead, blooms in the gaps");
  }
  if (throws) notes.push(`Delay throws: ${throws} phrase endings sent to the delay (+11 dB)`);

  // Beat: level-match, unmask, duck -------------------------------------
  if (beat && !(beatTrack?.mute) && (!only || only === "beat")) {
    const bL = beat.getChannelData(0);
    const bR = beat.numberOfChannels > 1 ? beat.getChannelData(1) : bL;
    const beatLufs = integratedLoudness([bL, bR], fs);
    const ref = leadLufs.length ? Math.max(...leadLufs) : preset.vocalLufs;
    const beatGainDb = clamp(ref + preset.beatOffsetLu - balance - beatLufs, -40, 20);

    // Masking: where does the beat crowd the vocal's presence band most?
    const beatBands = bandSpectrum(bL, fs, null, 8192).bands;
    let carveF = 2500;
    let worst = -Infinity;
    for (const fc of [1000, 2000, 3200]) {
      const crowd = beatBands[fc] - beatBands[500];
      if (crowd > worst) {
        worst = crowd;
        carveF = fc === 1000 ? 1400 : fc === 2000 ? 2400 : 3400;
      }
    }
    const carveDb = clamp(2 + (worst + 8) * 0.25, 1.5, 5);

    const src = ctx.createBufferSource();
    src.buffer = beat;
    const g = ctx.createGain();
    g.gain.value = dbToLin(beatGainDb);
    const carve = ctx.createBiquadFilter();
    carve.type = "peaking";
    carve.frequency.value = carveF;
    carve.Q.value = 1.1;
    const duck = ctx.createGain();
    const dur = length / fs;
    if (activity.length > 1) {
      carve.gain.setValueCurveAtTime(activity.map((a) => -carveDb * a), 0, dur);
      duck.gain.setValueCurveAtTime(activity.map((a) => dbToLin(-preset.duckDb * a)), 0, dur);
    }
    src.connect(g).connect(carve).connect(duck).connect(bus);
    src.start(beatTrack?.offset || 0);
    notes.unshift(
      `Beat: ${beatLufs.toFixed(1)} LUFS → ${(beatLufs + beatGainDb).toFixed(1)} (${preset.beatOffsetLu - balance >= 0 ? "+" : ""}${(preset.beatOffsetLu - balance).toFixed(1)} LU vs lead)`,
      `Unmasking: beat dips −${carveDb.toFixed(1)} dB @ ${(carveF / 1000).toFixed(1)} kHz + ${preset.duckDb} dB duck, only while the vocal speaks`,
    );
  }

  // Glue + render ---------------------------------------------------------
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -16;
  glue.ratio.value = 1.8;
  glue.attack.value = 0.03;
  glue.release.value = 0.2;
  glue.knee.value = 8;
  if (only) bus.connect(ctx.destination);
  else bus.connect(glue).connect(ctx.destination);
  const rendered = await ctx.startRendering();
  if (only) return { buffer: rendered, notes };

  // Master: loudness normalise + look-ahead limit, measured twice.
  await tick();
  const chans = [rendered.getChannelData(0), rendered.getChannelData(1)];
  const pre1 = integratedLoudness(chans, fs);
  const target = settings.targetLufs ?? -14;
  const gain = Number.isFinite(pre1) ? dbToLin(target - pre1) : 1;
  const gained = chans.map((c) => c.map((v) => v * gain));
  let lim = limit(gained, fs, -1);
  let post = integratedLoudness(lim.channels, fs);
  // One correction pass: the limiter shaves loudness when it works hard.
  if (Number.isFinite(post) && target - post > 0.3) {
    const g2 = dbToLin(target - post);
    lim = limit(gained.map((c) => c.map((v) => v * g2)), fs, -1);
    post = integratedLoudness(lim.channels, fs);
  }
  const master = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: fs });
  master.copyToChannel(lim.channels[0], 0);
  master.copyToChannel(lim.channels[1], 1);
  const peak = linToDb(samplePeak(lim.channels));
  notes.push(
    `Glue: 1.8:1 bus compression, 30 ms attack`,
    `Master: ${post.toFixed(1)} LUFS integrated (target ${target}), peak ${peak.toFixed(1)} dBFS, limiter max −${lim.maxReductionDb.toFixed(1)} dB`,
  );
  return { buffer: master, notes, lufs: post, peak };
}

export { estimateBpm, integratedLoudness, BANDS };
