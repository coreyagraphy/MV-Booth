// Numeric guards for the DSP fast paths (FFT, packed-FFT pitch tracking and de-noise, LUFS, true peak).
const D = await import(new URL("../../js/dsp.js", import.meta.url));
const T = await import(new URL("../../js/tune.js", import.meta.url));
const ok = (n, c, x = "") => console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`);
let seed = 5; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;

for (const N of [8, 64, 1024]) {
  const xr = Float64Array.from({ length: N }, rnd), xi = Float64Array.from({ length: N }, rnd);
  const re = xr.slice(), im = xi.slice();
  D.fft(re, im);
  let err = 0;
  for (let k = 0; k < N; k++) {
    let sr = 0, si = 0;
    for (let n = 0; n < N; n++) { const a = (-2 * Math.PI * k * n) / N; sr += xr[n] * Math.cos(a) - xi[n] * Math.sin(a); si += xr[n] * Math.sin(a) + xi[n] * Math.cos(a); }
    err = Math.max(err, Math.abs(sr - re[k]), Math.abs(si - im[k]));
  }
  D.fft(re, im, true);
  let rt = 0; for (let n = 0; n < N; n++) rt = Math.max(rt, Math.abs(re[n] - xr[n]), Math.abs(im[n] - xi[n]));
  ok(`FFT ${N} matches a reference DFT and round-trips`, err < 1e-9 && rt < 1e-12, `dft ${err.toExponential(1)} rt ${rt.toExponential(1)}`);
}

const fs = 48000;
const tone = (f, sec, amp = 0.5) => Float32Array.from({ length: Math.round(fs * sec) }, (_, i) => amp * (Math.sin((2 * Math.PI * f * i) / fs) + 0.3 * Math.sin((4 * Math.PI * f * i) / fs)));
for (const f of [98, 220, 440]) {
  const p = await T.trackPitch(tone(f, 1.5), fs);
  const mid = [...p.f0.slice(20, -20)];
  const v = mid.filter(Boolean);
  const cents = v.length ? Math.max(...v.map((x) => Math.abs(1200 * Math.log2(x / f)))) : Infinity;
  ok(`pitch tracking ${f} Hz`, v.length > mid.length * 0.95 && cents < 2, `max error ${cents.toFixed(2)} cents`);
}

const sine = Float32Array.from({ length: fs * 5 }, (_, i) => Math.sin((2 * Math.PI * 997 * i) / fs));
ok("LUFS: 0 dBFS 997 Hz sine = −3.01 (BS.1770)", Math.abs(D.integratedLoudness([sine], fs) + 3.01) < 0.02, D.integratedLoudness([sine], fs).toFixed(3));
const s441 = Float32Array.from({ length: 44100 * 5 }, (_, i) => Math.sin((2 * Math.PI * 997 * i) / 44100));
ok("LUFS at 44.1 kHz", Math.abs(D.integratedLoudness([s441], 44100) + 3.01) < 0.05, D.integratedLoudness([s441], 44100).toFixed(3));
const q = Float32Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin((Math.PI / 2) * i + Math.PI / 4));
// Samples sit at ±0.354 (−9.03 dBFS); the waveform between them peaks at 0.5 (−6.02 dBTP).
ok("true peak finds the inter-sample peak (fs/4)", Math.abs(D.linToDb(D.truePeak([q])) + 6.02) < 0.2 && D.linToDb(D.samplePeak([q])) < -8.9, `sample ${D.linToDb(D.samplePeak([q])).toFixed(2)} dBFS, true ${D.linToDb(D.truePeak([q])).toFixed(2)} dBTP`);

// De-noise: phrases of tone over steady hiss; the gaps must get quieter, the tone must survive.
const len = fs * 8, x = new Float32Array(len), clean = new Float32Array(len);
for (let i = 0; i < len; i++) { const on = Math.floor(i / fs) % 2 === 0; clean[i] = on ? 0.3 * Math.sin((2 * Math.PI * 300 * i) / fs) : 0; x[i] = clean[i] + 0.01 * rnd(); }
const r = await D.denoise(x, fs, { floorDb: -20 });
const rmsDb = (a, s, e) => { s = Math.round(s); e = Math.round(e); let t = 0; for (let i = s; i < e; i++) t += a[i] * a[i]; return 10 * Math.log10(t / (e - s)); };
const gapIn = rmsDb(x, fs * 1.2, fs * 1.8), gapOut = rmsDb(r.out, fs * 1.2, fs * 1.8);
const toneIn = rmsDb(x, fs * 2.2, fs * 2.8), toneOut = rmsDb(r.out, fs * 2.2, fs * 2.8);
ok("de-noise lowers the hiss in gaps", r.applied && gapOut < gapIn - 6, `${gapIn.toFixed(1)} → ${gapOut.toFixed(1)} dB`);
ok("de-noise keeps the tone", Math.abs(toneOut - toneIn) < 0.5, `${toneIn.toFixed(2)} → ${toneOut.toFixed(2)} dB`);
