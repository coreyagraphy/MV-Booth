// Pure DSP primitives: FFT, biquads, BS.1770 loudness, spectral noise
// reduction, a look-ahead limiter, and analysis helpers. No DOM, no Web Audio,
// so every function here also runs (and is tested) under Node.

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (x) => 20 * Math.log10(Math.max(x, 1e-12));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Yield to the event loop so long jobs keep the UI responsive. */
export const tick = () => new Promise((r) => setTimeout(r, 0));

export function percentile(values, p) {
  if (!values.length) return NaN;
  const s = Float64Array.from(values).sort();
  const idx = clamp((s.length - 1) * p, 0, s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// ---------------------------------------------------------------- FFT

const fftTables = new Map();

function tables(n) {
  let t = fftTables.get(n);
  if (t) return t;
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  fftTables.set(n, t);
  return t;
}

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of 2. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  const { rev, cos, sin } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const wr = cos[k];
        const wi = inverse ? -sin[k] : sin[k];
        const a = i + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

const hannCache = new Map();
export function hann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    hannCache.set(n, w);
  }
  return w;
}

// ---------------------------------------------------------------- biquads

/** RBJ cookbook coefficients, normalised so a0 = 1. */
export function biquad(type, f0, fs, q = Math.SQRT1_2, gainDb = 0) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const c = Math.cos(w0);
  const s = Math.sin(w0);
  const alpha = s / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case "highpass":
      [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * c, 1 - alpha];
      break;
    case "lowpass":
      [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * c, 1 - alpha];
      break;
    case "bandpass":
      [b0, b1, b2] = [alpha, 0, -alpha];
      [a0, a1, a2] = [1 + alpha, -2 * c, 1 - alpha];
      break;
    case "peaking":
      [b0, b1, b2] = [1 + alpha * A, -2 * c, 1 - alpha * A];
      [a0, a1, a2] = [1 + alpha / A, -2 * c, 1 - alpha / A];
      break;
    default:
      throw new Error(`unknown biquad ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function filter(x, co) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const v = co.b0 * xi + co.b1 * x1 + co.b2 * x2 - co.a1 * y1 - co.a2 * y2;
    x2 = x1;
    x1 = xi;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

// ---------------------------------------------------------------- loudness

/** ITU-R BS.1770-4 K-weighting (same formulation as pyloudnorm). */
function kWeighting(fs) {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  const Q1 = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q1 + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q1 + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q1 + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q1 + K * K) / a0,
  };
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q2 + K * K) / a0 };
  return [shelf, hp];
}

export function kWeight(x, fs) {
  const [a, b] = kWeighting(fs);
  return filter(filter(x, a), b);
}

/** Integrated loudness (LUFS) of one or more channels. */
export function integratedLoudness(channels, fs) {
  const weighted = channels.map((c) => kWeight(c, fs));
  const block = Math.round(0.4 * fs);
  const hop = Math.round(0.1 * fs);
  const len = weighted[0].length;
  if (len < block) return -Infinity;
  const z = [];
  for (let start = 0; start + block <= len; start += hop) {
    let sum = 0;
    for (const w of weighted) {
      let ms = 0;
      for (let i = start; i < start + block; i++) ms += w[i] * w[i];
      sum += ms / block;
    }
    z.push(sum);
  }
  const lk = (ms) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
  const abs = z.filter((ms) => lk(ms) > -70);
  if (!abs.length) return -Infinity;
  const relGate = lk(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const rel = abs.filter((ms) => lk(ms) > relGate);
  return lk(rel.reduce((a, b) => a + b, 0) / rel.length);
}

/** Short-term K-weighted loudness envelope, one value per `hop` samples. */
/**
 * Integrated loudness that still answers for clips under 0.4 s (a one-word ad-lib): falls back to
 * ungated K-weighted loudness. −Infinity only for true silence; callers treat that as "no change".
 */
export function loudnessOf(channels, fs) {
  const lufs = integratedLoudness(channels, fs);
  if (Number.isFinite(lufs)) return lufs;
  let sum = 0;
  for (const c of channels) {
    const w = kWeight(c, fs);
    let ms = 0;
    for (let i = 0; i < w.length; i++) ms += w[i] * w[i];
    sum += ms / Math.max(1, w.length);
  }
  const lk = -0.691 + 10 * Math.log10(Math.max(sum, 1e-12));
  return lk > -70 ? lk : -Infinity;
}
export function loudnessEnvelope(x, fs, hop, windowSec = 0.3) {
  const w = kWeight(x, fs);
  const frames = Math.ceil(x.length / hop);
  const half = Math.round((windowSec * fs) / 2);
  const cum = new Float64Array(w.length + 1);
  for (let i = 0; i < w.length; i++) cum[i + 1] = cum[i] + w[i] * w[i];
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const c = f * hop + hop / 2;
    const a = clamp(Math.round(c - half), 0, w.length);
    const b = clamp(Math.round(c + half), 0, w.length);
    out[f] = b > a ? -0.691 + 10 * Math.log10(Math.max((cum[b] - cum[a]) / (b - a), 1e-12)) : -120;
  }
  return out;
}

export function samplePeak(channels) {
  let p = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]));
  return p;
}

// ---------------------------------------------------------------- framing

export function frameRmsDb(x, hop, win = hop * 2) {
  const frames = Math.ceil(x.length / hop);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    const end = Math.min(x.length, start + win);
    let s = 0;
    for (let i = start; i < end; i++) s += x[i] * x[i];
    out[f] = 10 * Math.log10(Math.max(s / Math.max(1, end - start), 1e-12));
  }
  return out;
}

// ---------------------------------------------------------------- noise reduction

/**
 * Spectral-gating noise reduction. Learns a noise profile from the quietest
 * frames, then applies a smoothed Wiener-style mask. Returns
 * `{ out, snrDb, applied, reductionDb }`.
 */
export async function denoise(x, fs, { floorDb = -14, onProgress } = {}) {
  const N = 2048;
  const H = N / 4;
  const win = hann(N);
  const rms = frameRmsDb(x, H, N);
  const noiseDb = percentile(rms, 0.1);
  const speechDb = percentile(rms, 0.95);
  const snrDb = speechDb - noiseDb;
  if (!(snrDb < 48) || x.length < N * 4) {
    return { out: x, snrDb, applied: false, reductionDb: 0 };
  }
  const alpha = snrDb < 20 ? 2.2 : snrDb < 32 ? 1.7 : 1.3;
  const floor = dbToLin(floorDb);

  // Noise profile: mean power spectrum of the quietest 10% of frames.
  const bins = N / 2 + 1;
  const profile = new Float64Array(bins);
  const quietCut = percentile(rms, 0.1) + 0.5;
  let count = 0;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let f = 0; f < rms.length; f++) {
    if (rms[f] > quietCut) continue;
    const start = f * H;
    for (let i = 0; i < N; i++) {
      re[i] = (x[start + i] || 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) profile[k] += re[k] * re[k] + im[k] * im[k];
    count++;
  }
  for (let k = 0; k < bins; k++) profile[k] /= Math.max(1, count);

  const out = new Float32Array(x.length + N);
  const prev = new Float64Array(bins).fill(1);
  const gain = new Float64Array(bins);
  const frames = Math.ceil(x.length / H);
  let removedSum = 0;
  for (let f = 0; f < frames; f++) {
    const start = f * H;
    for (let i = 0; i < N; i++) {
      re[i] = (x[start + i] || 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k] + 1e-20;
      const g = Math.max(floor, (p - alpha * profile[k]) / p);
      // Open instantly, close slowly: keeps consonant attacks, kills musical noise.
      gain[k] = g > prev[k] ? g : prev[k] * 0.65 + g * 0.35;
    }
    let frameGain = 0;
    for (let k = 0; k < bins; k++) {
      const g = (gain[Math.max(0, k - 1)] + gain[k] + gain[Math.min(bins - 1, k + 1)]) / 3;
      prev[k] = gain[k];
      re[k] *= g;
      im[k] *= g;
      if (k > 0 && k < N / 2) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
      frameGain += g;
    }
    removedSum += frameGain / bins;
    fft(re, im, true);
    for (let i = 0; i < N; i++) out[start + i] += (re[i] * win[i]) / 1.5;
    if (onProgress && f % 2000 === 0) {
      onProgress(f / frames);
      await tick();
    }
  }
  const reductionDb = -linToDb(removedSum / frames);
  return { out: out.subarray(0, x.length), snrDb, applied: true, reductionDb };
}

// ---------------------------------------------------------------- spectrum

export const BANDS = [120, 250, 500, 1000, 2000, 3200, 6000, 10000];

/** Long-term average spectrum in octave-ish bands (dB), from selected frames. */
export function bandSpectrum(x, fs, frameSelector, hop = 2048) {
  const N = 4096;
  const win = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const power = new Float64Array(N / 2 + 1);
  let used = 0;
  for (let start = 0; start + N <= x.length; start += hop) {
    if (frameSelector && !frameSelector(start)) continue;
    for (let i = 0; i < N; i++) {
      re[i] = x[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
    used++;
  }
  const out = {};
  for (const fc of BANDS) {
    const lo = Math.floor(((fc / Math.SQRT2) * N) / fs);
    const hi = Math.min(N / 2, Math.ceil((fc * Math.SQRT2 * N) / fs));
    let s = 0;
    for (let k = lo; k <= hi; k++) s += power[k];
    out[fc] = 10 * Math.log10(Math.max(s / Math.max(1, used), 1e-20));
  }
  return { bands: out, frames: used };
}

// ---------------------------------------------------------------- pitch / tempo

/** Normalised-autocorrelation F0 on one frame; returns 0 when unvoiced. */
export function frameF0(x, start, fs, N = 2048) {
  const re = new Float64Array(N * 2);
  const im = new Float64Array(N * 2);
  const win = hann(N);
  for (let i = 0; i < N; i++) re[i] = (x[start + i] || 0) * win[i];
  fft(re, im);
  for (let k = 0; k < N * 2; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k];
    im[k] = 0;
  }
  fft(re, im, true);
  const r0 = re[0];
  if (r0 <= 1e-9) return 0;
  const minLag = Math.floor(fs / 420);
  const maxLag = Math.min(N - 1, Math.ceil(fs / 60));
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = re[lag] / r0;
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  return best > 0.45 ? fs / bestLag : 0;
}

/** Onset-autocorrelation tempo estimate, folded into 70–180 BPM. */
export function estimateBpm(x, fs) {
  const N = 1024;
  const H = 512;
  const win = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prev = new Float64Array(N / 2);
  const limit = Math.min(x.length, fs * 90);
  const flux = [];
  for (let start = 0; start + N <= limit; start += H) {
    for (let i = 0; i < N; i++) {
      re[i] = x[start + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(N / 2);
    let f = 0;
    for (let k = 1; k < N / 2; k++) {
      mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      f += Math.max(0, mag[k] - prev[k]);
    }
    prev = mag;
    flux.push(f);
  }
  if (flux.length < 64) return 0;
  const mean = flux.reduce((a, b) => a + b, 0) / flux.length;
  const o = flux.map((v) => Math.max(0, v - mean));
  const fps = fs / H;
  let best = 0;
  let bestBpm = 0;
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    for (const mult of [1, 2, 4]) {
      const L = lag * mult;
      const l0 = Math.floor(L);
      const fr = L - l0;
      for (let i = 0; i + l0 + 1 < o.length; i++) s += o[i] * (o[i + l0] * (1 - fr) + o[i + l0 + 1] * fr) / mult;
    }
    if (s > best) {
      best = s;
      bestBpm = bpm;
    }
  }
  return Math.round(bestBpm);
}

// ---------------------------------------------------------------- limiter

/**
 * Look-ahead brickwall limiter (hold-min + box smoothing, slow release).
 * Mutates nothing; returns new channels and the maximum gain reduction in dB.
 */
export function limit(channels, fs, ceilingDb = -1, lookaheadMs = 5, releaseMs = 120) {
  const n = channels[0].length;
  const L = Math.max(1, Math.round((lookaheadMs / 1000) * fs));
  const ceil = dbToLin(ceilingDb);
  const req = new Float32Array(n + L);
  req.fill(1);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of channels) p = Math.max(p, Math.abs(c[i]));
    req[i] = p > ceil ? ceil / p : 1;
  }
  // hold[i] = min(req[i-L .. i]) via monotonic deque
  const hold = new Float32Array(n + L);
  const dq = new Int32Array(n + L);
  let head = 0, tail = 0;
  for (let i = 0; i < n + L; i++) {
    while (tail > head && req[dq[tail - 1]] >= req[i]) tail--;
    dq[tail++] = i;
    if (dq[head] < i - L) head++;
    hold[i] = req[dq[head]];
  }
  const rel = Math.exp(-1 / ((releaseMs / 1000) * fs));
  const out = channels.map(() => new Float32Array(n));
  let sum = L; // treat the samples before t=0 as needing no reduction
  let g = 1;
  let minG = 1;
  for (let i = 0; i < n + L; i++) {
    sum += hold[i] - (i >= L ? hold[i - L] : 1);
    const s = Math.min(sum / L, hold[i]);
    g = s < g ? s : g + (s - g) * (1 - rel);
    const j = i - L;
    if (j >= 0) {
      minG = Math.min(minG, g);
      for (let c = 0; c < channels.length; c++) {
        out[c][j] = clamp(channels[c][j] * g, -ceil, ceil);
      }
    }
  }
  return { channels: out, maxReductionDb: -linToDb(minG) };
}

// ---------------------------------------------------------------- curves

/** One-pole smoothing in dB with separate rise/fall coefficients. */
export function smoothCurve(curve, rise, fall) {
  const out = new Float32Array(curve.length);
  let v = curve[0] || 0;
  for (let i = 0; i < curve.length; i++) {
    const t = curve[i];
    v += (t - v) * (t > v ? rise : fall);
    out[i] = v;
  }
  return out;
}

/** Forward-looking max so gates open before the consonant, not after. */
export function lookaheadMax(curve, frames) {
  const out = new Float32Array(curve.length);
  for (let i = 0; i < curve.length; i++) {
    let m = curve[i];
    for (let j = 1; j <= frames && i + j < curve.length; j++) m = Math.max(m, curve[i + j]);
    out[i] = m;
  }
  return out;
}

// ---------------------------------------------------------------- true peak

/**
 * True peak (linear) via 4× windowed-sinc oversampling, BS.1770 style.
 * Only samples near the sample peak are interpolated, which keeps it fast.
 */
export function truePeak(channels) {
  const taps = 12;
  const phases = [0.25, 0.5, 0.75].map((frac) => {
    const h = [];
    for (let k = -taps + 1; k <= taps; k++) {
      const x = k - frac;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (taps + 1));
      h.push(((Math.sin(Math.PI * x) / (Math.PI * x)) || 1) * w);
    }
    return h;
  });
  const sp = samplePeak(channels);
  const near = sp * 0.5;
  let tp = sp;
  for (const c of channels) {
    for (let n = taps; n < c.length - taps; n++) {
      if (Math.abs(c[n]) < near && Math.abs(c[n + 1]) < near) continue;
      for (const h of phases) {
        let v = 0;
        for (let k = -taps + 1, j = 0; k <= taps; k++, j++) v += c[n + k] * h[j];
        const a = Math.abs(v);
        if (a > tp) tp = a;
      }
    }
  }
  return tp;
}

// ---------------------------------------------------------------- de-click

/**
 * Remove mouth clicks / digital ticks: isolated spikes in the first difference
 * (much sharper than anything a voice does) are replaced by a cubic bridge.
 * Consonant transients last several ms and are left alone.
 */
// Autocorrelation (lags 0..order) of x[a, b), added into R.
function acorr(x, a, b, order, R) {
  for (let k = 0; k <= order; k++) for (let i = a + k; i < b; i++) R[k] += x[i] * x[i - k];
}
// Levinson–Durbin: prediction-error filter a[0..order] (a[0] = 1) from autocorrelation R.
function levinson(R, order) {
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let err = R[0] * 1.0001;
  if (err <= 1e-12) return null;
  for (let m = 1; m <= order; m++) {
    let acc = R[m];
    for (let k = 1; k < m; k++) acc += a[k] * R[m - k];
    const kk = -acc / err;
    const prev = a.slice();
    for (let k = 1; k < m; k++) a[k] = prev[k] + kk * prev[m - k];
    a[m] = kk;
    err *= 1 - kk * kk;
    if (err <= 1e-12) break;
  }
  return a;
}
// Least-squares AR interpolation (Janssen et al.): fill out(a0, a1) with the samples that make the
// whole stretch most predictable from the clean audio on both sides.
function bridgeAR(out, a0, a1, fs) {
  const P = 32, ctxN = Math.round(0.02 * fs);
  const R = new Float64Array(P + 1);
  acorr(out, Math.max(P, a0 - ctxN), a0 + 1, P, R);
  acorr(out, a1 + P, Math.min(out.length, a1 + ctxN), P, R);
  const A = levinson(R, P);
  const L = a1 - a0 - 1;
  if (!A || L < 1) return;
  const bk = new Float64Array(P + 1);
  for (let k = 0; k <= P; k++) for (let j = 0; j + k <= P; j++) bk[k] += A[j] * A[j + k];
  // Symmetric Toeplitz system M·u = −(known part), solved by Gaussian elimination.
  const M = new Float64Array(L * L), rhs = new Float64Array(L);
  for (let i = 0; i < L; i++) {
    const m = a0 + 1 + i;
    for (let k = -P; k <= P; k++) {
      const q = m + k, w = bk[Math.abs(k)];
      if (q > a0 && q < a1) M[i * L + (q - a0 - 1)] = w;
      else if (q >= 0 && q < out.length) rhs[i] -= w * out[q];
    }
  }
  for (let c = 0; c < L; c++) {
    const piv = M[c * L + c] || 1e-12;
    for (let r = c + 1; r < Math.min(L, c + P + 1); r++) {
      const f = M[r * L + c] / piv;
      if (!f) continue;
      for (let k = c; k < Math.min(L, c + 2 * P + 1); k++) M[r * L + k] -= f * M[c * L + k];
      rhs[r] -= f * rhs[c];
    }
  }
  for (let c = L - 1; c >= 0; c--) {
    let s = rhs[c];
    for (let k = c + 1; k < Math.min(L, c + 2 * P + 1); k++) s -= M[c * L + k] * out[a0 + 1 + k];
    out[a0 + 1 + c] = s / (M[c * L + c] || 1e-12);
  }
}
export function declick(x, fs) {
  const n = x.length;
  const out = x.slice();
  // High-passed residual: a click is a short broadband spike, a voice is smooth from sample to sample.
  const r = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) r[i] = x[i] - 0.5 * (x[i - 1] + x[i + 1]);
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + r[i] * r[i];
  const W = Math.round(0.01 * fs); // ±10 ms reference window
  const ex = Math.round(0.001 * fs); // the click itself is excluded from its reference
  const maxLen = Math.round(0.002 * fs);
  const pad = Math.max(2, Math.round(0.0002 * fs));
  const isoLo = Math.round(0.0015 * fs), isoHi = Math.round(0.012 * fs);
  let clicks = 0;
  // Start/stop far enough in that the reference window and the ±12 ms periodicity check stay inside the take.
  const edge = Math.max(W, isoHi + 1);
  for (let i = edge; i < n - edge; i++) {
    const a = Math.abs(r[i]);
    if (a < 2e-3) continue; // below −54 dBFS nobody hears it
    const e = cs[i + W] - cs[i - W] - (cs[i + ex] - cs[i - ex]);
    const rms = Math.sqrt(e / (2 * W - 2 * ex));
    if (a < rms * 10) continue;
    // Glottal pulses repeat every 2–12 ms; a click stands alone.
    let periodic = false;
    for (let k = isoLo; k <= isoHi && !periodic; k++) periodic = Math.abs(r[i - k]) > a * 0.45 || Math.abs(r[i + k]) > a * 0.45;
    if (periodic) continue;
    let j = i;
    while (j < n - edge && j - i <= maxLen && Math.abs(r[j + 1]) > rms * 4) j++;
    if (j - i > maxLen) {
      i = j; // a real transient (consonant onset), not a click
      continue;
    }
    const a0 = Math.max(1, i - pad);
    const a1 = Math.min(n - 2, j + pad);
    let peak = 0;
    for (let k = i; k <= j; k++) peak = Math.max(peak, Math.abs(r[k]));
    const keep = out.slice(a0, a1 + 1);
    bridgeAR(out, a0, a1, fs);
    // Never move the audio more than the click itself: inside loud singing the model can't predict well.
    let moved = 0;
    for (let k = a0; k <= a1; k++) moved = Math.max(moved, Math.abs(out[k] - keep[k - a0]));
    if (moved > peak * 1.0) {
      out.set(keep, a0);
      i = a1;
      continue;
    }
    clicks++;
    i = a1 + isoLo;
  }
  return { out, clicks };
}
