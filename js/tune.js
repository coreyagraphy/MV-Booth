// Vocal correction: YIN pitch tracking, key detection, note snapping with
// retune speed, and TD-PSOLA pitch shifting (keeps formants, so the voice
// still sounds like you). Also exports the PSOLA engine for doubles.
import { biquad, clamp, fft, filter, percentile, tick } from "./dsp.js";

export const HOP = 512;
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const SCALES = {
  major: { label: "Major", steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { label: "Minor", steps: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor: { label: "Harmonic minor", steps: [0, 2, 3, 5, 7, 8, 11] },
  minorPent: { label: "Minor pentatonic", steps: [0, 3, 5, 7, 10] },
  majorPent: { label: "Major pentatonic", steps: [0, 2, 4, 7, 9] },
  chromatic: { label: "Chromatic", steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};
export const STYLES = {
  off: { label: "Off" },
  natural: { label: "Natural", lpMs: 160, speedMs: 90, amount: 0.8 },
  tight: { label: "Tight", lpMs: 60, speedMs: 28, amount: 1 },
  hard: { label: "Hard tune", lpMs: 0, speedMs: 0, amount: 1 },
};

const midiOf = (f) => 69 + 12 * Math.log2(f / 440);

// ---------------------------------------------------------------- YIN

/** Pitch per HOP-sized frame (frame f is centred on sample f*HOP). 0 = unvoiced. */
export async function trackPitch(x, fs, onProgress) {
  const tauMax = Math.ceil(fs / 60);
  const tauMin = Math.floor(fs / 1000);
  const Wi = 1024;
  const W = Wi + tauMax;
  let Nfft = 1;
  while (Nfft < W + Wi) Nfft <<= 1;
  const frames = Math.ceil(x.length / HOP);
  const f0 = new Float32Array(frames);
  const conf = new Float32Array(frames);
  const are = new Float64Array(Nfft), aim = new Float64Array(Nfft);
  const bre = new Float64Array(Nfft), bim = new Float64Array(Nfft);
  const d = new Float64Array(tauMax + 1);
  const sq = new Float64Array(W + 1);

  // Energy gate: skip near-silent frames entirely.
  const rmsDb = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const a = Math.max(0, f * HOP - 512);
    const b = Math.min(x.length, f * HOP + 512);
    for (let i = a; i < b; i++) s += x[i] * x[i];
    rmsDb[f] = 10 * Math.log10(Math.max(s / Math.max(1, b - a), 1e-12));
  }
  const gate = Math.max(percentile(rmsDb, 0.95) - 40, -85);

  for (let f = 0; f < frames; f++) {
    if (f % 1500 === 0) {
      // Yield on every 1500th frame, voiced or not, so long silences don't freeze the UI.
      onProgress?.(f / frames);
      await tick();
    }
    if (rmsDb[f] < gate) continue;
    const start = f * HOP - (W >> 1);
    are.fill(0); aim.fill(0);
    sq[0] = 0;
    // Two real signals in one complex FFT: a (the Wi-sample window) in re, b (the W-sample span) in im.
    for (let i = 0; i < W; i++) {
      const v = x[start + i] || 0;
      aim[i] = v;
      if (i < Wi) are[i] = v;
      sq[i + 1] = sq[i] + v * v;
    }
    fft(are, aim);
    for (let k = 0; k < Nfft; k++) {
      // Unpack A = (Z[k] + conj Z[−k]) / 2, B = (Z[k] − conj Z[−k]) / 2i, then conj(A)·B.
      const m = (Nfft - k) & (Nfft - 1);
      const zr = are[k], zi = aim[k], nr = are[m], ni = aim[m];
      const ar = 0.5 * (zr + nr), ai = 0.5 * (zi - ni);
      const br = 0.5 * (zi + ni), bi = -0.5 * (zr - nr);
      bre[k] = ar * br + ai * bi;
      bim[k] = ar * bi - ai * br;
    }
    fft(bre, bim, true);
    const e0 = sq[Wi];
    if (e0 < 1e-9) continue;
    d[0] = 0;
    let run = 0;
    let best = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      const v = e0 + (sq[tau + Wi] - sq[tau]) - 2 * bre[tau];
      run += v;
      d[tau] = run > 0 ? (v * tau) / run : 1;
    }
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (d[tau] < 0.2) {
        while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) continue;
    const a = d[best - 1], b = d[best], c = d[best + 1];
    const den = a - 2 * b + c;
    const shift = den !== 0 ? clamp((0.5 * (a - c)) / den, -1, 1) : 0;
    f0[f] = fs / (best + shift);
    conf[f] = 1 - b;
  }
  // Kill isolated blips and octave jumps against the local median.
  const out = f0.slice();
  for (let f = 2; f < frames - 2; f++) {
    if (!f0[f]) continue;
    const nb = [f0[f - 2], f0[f - 1], f0[f + 1], f0[f + 2]].filter(Boolean);
    if (nb.length < 2) {
      out[f] = 0;
      continue;
    }
    const med = percentile(nb, 0.5);
    const r = f0[f] / med;
    if (r > 1.8 && r < 2.2) out[f] = f0[f] / 2;
    else if (r > 0.45 && r < 0.56) out[f] = f0[f] * 2;
  }
  onProgress?.(1);
  return { f0: out, conf, hop: HOP };
}

// ---------------------------------------------------------------- key

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

/** Krumhansl–Schmuckler key estimate from one or more pitch curves. */
export function detectKey(curves) {
  const hist = new Array(12).fill(0);
  for (const f0 of curves) {
    for (const f of f0) {
      if (!f) continue;
      const m = midiOf(f);
      const pc = ((Math.round(m) % 12) + 12) % 12;
      hist[pc] += 1 - Math.min(1, Math.abs(m - Math.round(m)) * 1.5);
    }
  }
  let best = { tonic: 0, scale: "minor", score: -Infinity };
  for (let t = 0; t < 12; t++) {
    const rot = hist.map((_, i) => hist[(i + t) % 12]);
    const maj = pearson(rot, KS_MAJOR);
    const min = pearson(rot, KS_MINOR);
    if (maj > best.score) best = { tonic: t, scale: "major", score: maj };
    if (min > best.score) best = { tonic: t, scale: "minor", score: min };
  }
  return { ...best, confident: best.score > 0.5 && hist.reduce((a, b) => a + b, 0) > 40 };
}

export const keyLabel = (k) => `${NOTE_NAMES[k.tonic]} ${SCALES[k.scale].label.toLowerCase()}`;

// ---------------------------------------------------------------- correction curve

/** Semitone shift per frame that snaps the take to the key at the chosen speed. */
export function correctionCurve(f0, fs, { tonic, scale, style }) {
  const st = STYLES[style];
  const n = f0.length;
  const shift = new Float32Array(n);
  const target = new Float32Array(n);
  if (!st || style === "off") return { shift, target };
  const allowed = new Set(SCALES[scale].steps.map((s) => (s + tonic) % 12));
  const hopSec = HOP / fs;
  const lpFrames = Math.max(0, Math.round(st.lpMs / 1000 / hopSec / 2));
  const alpha = st.speedMs ? 1 - Math.exp(-hopSec / (st.speedMs / 1000)) : 1;
  const midi = Array.from(f0, (f) => (f ? midiOf(f) : NaN));
  const nearest = (m) => {
    let best = Math.round(m);
    let bd = Infinity;
    for (let c = Math.floor(m) - 2; c <= Math.ceil(m) + 2; c++) {
      if (!allowed.has(((c % 12) + 12) % 12)) continue;
      const dd = Math.abs(m - c);
      if (dd < bd) {
        bd = dd;
        best = c;
      }
    }
    return best;
  };
  let cur = null;
  let s = 0;
  let gap = 99;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(midi[i])) {
      gap++;
      s *= 0.6;
      shift[i] = s;
      if (gap > 6) cur = null;
      continue;
    }
    // Centre of the note, ignoring vibrato (natural styles keep the vibrato).
    let sum = 0, cnt = 0;
    for (let j = i - lpFrames; j <= i + lpFrames; j++) {
      if (j >= 0 && j < n && !Number.isNaN(midi[j])) {
        sum += midi[j];
        cnt++;
      }
    }
    const centre = sum / cnt;
    const cand = nearest(centre);
    if (cur == null || Math.abs(centre - cand) + 0.15 < Math.abs(centre - cur)) cur = cand;
    const c = (cur - centre) * st.amount;
    if (gap > 6) s = style === "natural" ? c * 0.5 : c; // note onset
    gap = 0;
    s += (c - s) * alpha;
    shift[i] = s;
    target[i] = cur;
  }
  return { shift, target };
}

// ---------------------------------------------------------------- PSOLA

/** Zero-phase low-pass that leaves one clean peak per period to lock marks onto. */
function fundamentalGuide(x, fs, f0) {
  const voiced = Array.from(f0).filter(Boolean);
  const cut = clamp((voiced.length ? percentile(voiced, 0.5) : 150) * 1.35, 140, 650);
  const co = biquad("lowpass", cut, fs, 0.6);
  const once = filter(filter(x, co), co);
  return filter(filter(once.reverse(), co), co).reverse();
}

function pitchMarks(raw, fs, f0) {
  const x = fundamentalGuide(raw, fs, f0);
  const marks = [];
  const n = x.length;
  const unv = Math.round(fs * 0.005);
  let t = 0;
  let wasVoiced = false;
  while (t < n) {
    const fr = Math.min(f0.length - 1, Math.round(t / HOP));
    const f = f0[fr];
    if (f) {
      const T = fs / f;
      if (!wasVoiced) {
        // Lock onto the strongest peak inside the first period.
        let bi = t, bv = -Infinity;
        for (let i = t; i < Math.min(n, t + T); i++) if (x[i] > bv) {
          bv = x[i];
          bi = i;
        }
        t = bi;
      }
      marks.push({ t, voiced: true });
      const pred = t + T;
      const r = Math.max(1, Math.round(T * 0.12));
      let bi = Math.round(pred), bv = -Infinity;
      for (let i = Math.round(pred) - r; i <= Math.round(pred) + r; i++) if (i < n && x[i] > bv) {
        bv = x[i];
        bi = i;
      }
      t = Math.max(t + 1, bi);
      wasVoiced = true;
    } else {
      marks.push({ t, voiced: false });
      t += unv;
      wasVoiced = false;
    }
  }
  return marks;
}

/**
 * Time-domain PSOLA with a time-varying shift (semitones per HOP frame).
 * Unvoiced material passes through untouched.
 */
export async function psola(x, fs, f0, shift, onProgress) {
  const n = x.length;
  const marks = pitchMarks(x, fs, f0);
  const out = new Float32Array(n);
  if (marks.length < 2) return x.slice();
  const shiftAt = (t) => {
    const p = t / HOP;
    const i = Math.min(shift.length - 1, Math.floor(p));
    const j = Math.min(shift.length - 1, i + 1);
    const fr = p - i;
    return shift[i] * (1 - fr) + shift[j] * fr;
  };
  let ts = marks[0].t;
  let k = 0;
  let steps = 0;
  while (ts < n) {
    while (k + 1 < marks.length && Math.abs(marks[k + 1].t - ts) <= Math.abs(marks[k].t - ts)) k++;
    const m = marks[k];
    const Ta = k + 1 < marks.length ? marks[k + 1].t - m.t : k > 0 ? m.t - marks[k - 1].t : Math.round(fs * 0.005);
    const beta = m.voiced ? Math.pow(2, shiftAt(ts) / 12) : 1;
    const L = Math.max(2, Math.round(Ta));
    const gain = m.voiced ? 1 / beta : 1;
    const dst0 = Math.round(ts);
    for (let j = -L; j <= L; j++) {
      const src = m.t + j;
      const dst = dst0 + j;
      if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
      const w = 0.5 - 0.5 * Math.cos((Math.PI * (j + L)) / L);
      out[dst] += x[src] * w * gain;
    }
    ts += Ta / beta;
    if (++steps % 20000 === 0) {
      onProgress?.(ts / n);
      await tick();
    }
  }
  return out;
}

/** Full correction pass for one take. */
export async function tuneTake(x, fs, pitch, key, style, onProgress) {
  const { shift, target } = correctionCurve(pitch.f0, fs, { ...key, style });
  let moved = 0, voiced = 0, maxShift = 0;
  for (let i = 0; i < shift.length; i++) {
    if (!pitch.f0[i]) continue;
    voiced++;
    const a = Math.abs(shift[i]);
    if (a > 0.1) moved++;
    maxShift = Math.max(maxShift, a);
  }
  if (style === "off" || !voiced) return { out: x, shift, target, moved: 0, maxShift: 0 };
  const out = await psola(x, fs, pitch.f0, shift, onProgress);
  return { out, shift, target, moved: moved / voiced, maxShift };
}
