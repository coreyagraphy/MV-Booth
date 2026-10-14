// Doubles: (1) line recorded doubles up to the lead — DTW timing alignment +
// WSOLA time-warp + PSOLA pitch-match (the VocAlign move), and (2) generate
// studio-style artificial doubles from the lead (ADT: detune + drifting delay).
import { clamp, fft, hann, tick } from "./dsp.js";
import { HOP, psola, trackPitch } from "./tune.js";

// ---------------------------------------------------------------- features

const NB = 20;
const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
function bandFeatures(x, fs) {
  const N = 2048;
  const win = hann(N);
  const frames = Math.ceil(x.length / HOP);
  const edges = Array.from({ length: NB + 1 }, (_, i) => Math.round((80 * Math.pow(8000 / 80, i / NB) * N) / fs));
  const feat = new Float32Array(frames * NB);
  const energy = new Float32Array(frames);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const start = f * HOP - N / 2;
    for (let i = 0; i < N; i++) {
      re[i] = (x[start + i] || 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let mean = 0;
    let tot = 0;
    for (let b = 0; b < NB; b++) {
      let s = 1e-10;
      for (let k = edges[b]; k <= Math.max(edges[b], edges[b + 1] - 1); k++) s += re[k] * re[k] + im[k] * im[k];
      tot += s;
      const v = Math.log10(s);
      feat[f * NB + b] = v;
      mean += v;
    }
    mean /= NB;
    let norm = 0;
    for (let b = 0; b < NB; b++) {
      feat[f * NB + b] -= mean;
      norm += feat[f * NB + b] ** 2;
    }
    norm = Math.sqrt(norm) || 1;
    for (let b = 0; b < NB; b++) feat[f * NB + b] /= norm;
    energy[f] = 10 * Math.log10(tot / N);
  }
  return { feat, energy, frames };
}

// ---------------------------------------------------------------- DTW

/**
 * Banded DTW. Returns, for each double frame i, the deviation (in frames) of
 * its best-matching lead frame from the nominal diagonal j = i + d0.
 */
function dtwDeviation(D, L, d0, band) {
  const W = 2 * band + 1;
  const n = D.frames;
  const cost = new Float32Array(n * W).fill(Infinity);
  const back = new Int8Array(n * W);
  const dLoud = maxOf(D.energy) - 35;
  const lLoud = maxOf(L.energy) - 35;
  const local = (i, j) => {
    if (j < 0 || j >= L.frames) return 2;
    const a = D.energy[i] > dLoud;
    const b = L.energy[j] > lLoud;
    if (!a && !b) return 0.05;
    if (a !== b) return 1;
    let dot = 0;
    for (let k = 0; k < NB; k++) dot += D.feat[i * NB + k] * L.feat[j * NB + k];
    return 1 - dot;
  };
  for (let i = 0; i < n; i++) {
    for (let jj = 0; jj < W; jj++) {
      const j = i + d0 + jj - band;
      const c = local(i, j) + (0.04 * Math.abs(jj - band)) / band;
      if (i === 0) {
        cost[jj] = c;
        continue;
      }
      const diag = cost[(i - 1) * W + jj];
      const up = jj + 1 < W ? cost[(i - 1) * W + jj + 1] + 0.15 : Infinity; // (i-1, j)
      const left = jj > 0 ? cost[i * W + jj - 1] + 0.15 : Infinity; // (i, j-1)
      let best = diag, from = 0;
      if (up < best) {
        best = up;
        from = 1;
      }
      if (left < best) {
        best = left;
        from = 2;
      }
      cost[i * W + jj] = c + best;
      back[i * W + jj] = from;
    }
  }
  let jj = 0;
  for (let k = 1; k < W; k++) if (cost[(n - 1) * W + k] < cost[(n - 1) * W + jj]) jj = k;
  const dev = new Float32Array(n);
  dev.fill(NaN);
  let i = n - 1;
  while (i >= 0) {
    if (Number.isNaN(dev[i])) dev[i] = jj - band;
    const from = back[i * W + jj];
    if (i === 0) break;
    if (from === 0) i--;
    else if (from === 1) {
      i--;
      jj++;
    } else jj--;
    jj = clamp(jj, 0, W - 1);
  }
  // Smooth the warp so it never wobbles audibly.
  const sm = new Float32Array(n);
  const r = 6;
  for (let k = 0; k < n; k++) {
    let s = 0, c = 0;
    for (let q = Math.max(0, k - r); q <= Math.min(n - 1, k + r); q++) {
      s += dev[q];
      c++;
    }
    sm[k] = s / c;
  }
  return sm;
}

// ---------------------------------------------------------------- WSOLA

/** Time-warp `x` so output frame u reads source frame srcFrame(u). Pitch unchanged. */
async function wsola(x, srcSampleAt) {
  const n = x.length;
  const N = 1024;
  const Hs = 256;
  const win = hann(N);
  const out = new Float32Array(n);
  const wsum = new Float32Array(n);
  const tol = 160;
  let prev = null;
  for (let o = 0, k = 0; o < n; o += Hs, k++) {
    const ideal = Math.round(srcSampleAt(o + N / 2) - N / 2);
    let best = ideal;
    if (prev != null) {
      const nat = prev + Hs;
      let e = 0;
      for (let i = 0; i < 256; i += 4) e += Math.abs(x[nat + i] || 0);
      if (e > 1e-3) {
        let bv = -Infinity;
        for (let d = -tol; d <= tol; d += 2) {
          const s = ideal + d;
          let c = 0;
          for (let i = 0; i < 256; i += 4) c += (x[s + i] || 0) * (x[nat + i] || 0);
          if (c > bv) {
            bv = c;
            best = s;
          }
        }
      }
    }
    for (let i = 0; i < N && o + i < n; i++) {
      out[o + i] += (x[best + i] || 0) * win[i];
      wsum[o + i] += win[i];
    }
    prev = best;
    if (k % 2000 === 0) await tick();
  }
  for (let i = 0; i < n; i++) out[i] /= Math.max(wsum[i], 0.05);
  return out;
}

/**
 * Align a recorded double to the lead in timing and pitch.
 * `lead` = { x (corrected mono), f0Out (pitch after tuning), offset }.
 */
export async function alignDouble(dbl, lead, fs, { tight = 0.9, onProgress } = {}) {
  const hopSec = HOP / fs;
  const D = bandFeatures(dbl.x, fs);
  const L = bandFeatures(lead.x, fs);
  onProgress?.(0.25);
  await tick();
  const d0 = Math.round((dbl.offset - lead.offset) / hopSec);
  const band = Math.round(0.35 / hopSec);
  const dev = dtwDeviation(D, L, d0, band);
  onProgress?.(0.45);
  // Double frame i should sound at local frame out(i) = i + tight*dev(i). Invert.
  const outPos = Array.from(dev, (d, i) => i + tight * d);
  for (let i = 1; i < outPos.length; i++) outPos[i] = Math.max(outPos[i], outPos[i - 1] + 0.25);
  let ptr = 0;
  const srcSampleAt = (s) => {
    const u = s / HOP;
    while (ptr + 1 < outPos.length - 1 && outPos[ptr + 1] < u) ptr++;
    while (ptr > 0 && outPos[ptr] > u) ptr--;
    const a = outPos[ptr], b = outPos[ptr + 1] ?? a + 1;
    const fr = b > a ? (u - a) / (b - a) : 0;
    return (ptr + clamp(fr, -4, 4)) * HOP;
  };
  const timed = await wsola(dbl.x, srcSampleAt);
  onProgress?.(0.7);

  // Pitch-match to the (tuned) lead.
  const p = await trackPitch(timed, fs);
  const shift = new Float32Array(p.f0.length);
  let matched = 0, voiced = 0;
  for (let i = 0; i < p.f0.length; i++) {
    const j = i + d0;
    const fl = j >= 0 && j < lead.f0Out.length ? lead.f0Out[j] : 0;
    if (!p.f0[i]) continue;
    voiced++;
    if (!fl) continue;
    const st = 12 * Math.log2(fl / p.f0[i]);
    if (Math.abs(st) < 2.5) {
      shift[i] = st * 0.92; // keep a hair of natural difference so it thickens
      matched++;
    }
  }
  for (let i = 1; i < shift.length - 1; i++) shift[i] = (shift[i - 1] + shift[i] * 2 + shift[i + 1]) / 4;
  const out = await psola(timed, fs, p.f0, shift);
  onProgress?.(1);
  let moveMs = 0;
  let loud = 0;
  const thr = maxOf(D.energy) - 35;
  for (let i = 0; i < dev.length; i++) if (D.energy[i] > thr) {
    moveMs += Math.abs(dev[i]) * hopSec * 1000 * tight;
    loud++;
  }
  return { out, avgShiftMs: moveMs / Math.max(1, loud), pitchMatched: voiced ? matched / voiced : 0 };
}

// ---------------------------------------------------------------- ADT

function driftingDelay(x, fs, baseMs, depthMs, rateHz, seed) {
  const n = x.length;
  const out = new Float32Array(n);
  let s = seed >>> 0;
  let noise = 0;
  const lp = 1 - Math.exp(-1 / (fs * 0.6));
  for (let i = 0; i < n; i++) {
    if ((i & 63) === 0) {
      s = (s * 1664525 + 1013904223) >>> 0;
      noise += ((s / 4294967296) * 2 - 1 - noise) * lp * 64;
    }
    const t = i / fs;
    const d = ((baseMs + depthMs * Math.sin(2 * Math.PI * rateHz * t + seed) + depthMs * 0.6 * noise) / 1000) * fs;
    const p = i - d;
    const a = Math.floor(p);
    const fr = p - a;
    out[i] = a >= 0 && a + 1 < n ? x[a] * (1 - fr) + x[a + 1] * fr : 0;
  }
  return out;
}

/** Studio-style artificial doubles from a (tuned) lead. */
export async function makeDoubles(x, fs, f0, mode) {
  const constShift = (st) => new Float32Array(f0.length).fill(st);
  const L = driftingDelay(await psola(x, fs, f0, constShift(0.09)), fs, 19, 2.2, 0.31, 11);
  const R = driftingDelay(await psola(x, fs, f0, constShift(-0.11)), fs, 27, 2.6, 0.23, 29);
  const out = [
    { key: "dL", name: "AI double L", pan: -0.78, x: L },
    { key: "dR", name: "AI double R", pan: 0.78, x: R },
  ];
  if (mode === "oct") {
    out.push({ key: "oct", name: "AI octave", pan: 0, x: driftingDelay(await psola(x, fs, f0, constShift(-12)), fs, 8, 0.8, 0.17, 5), role: "octave" });
  }
  return out;
}
