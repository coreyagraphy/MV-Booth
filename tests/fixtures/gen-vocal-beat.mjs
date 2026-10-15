import { writeFileSync } from "node:fs";
const fs = 48000;
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
function wav(name, chans) {
  const n = chans[0].length, ch = chans.length, b = Buffer.alloc(44 + n * ch * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * ch * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(fs, 24); b.writeUInt32LE(fs * ch * 2, 28);
  b.writeUInt16LE(ch * 2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * ch * 2, 40);
  let o = 44; for (let i = 0; i < n; i++) for (const c of chans) { b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, c[i])) * 32767), o); o += 2; }
  writeFileSync(name, b);
}
// vocal: 12 s of phrases with level swings, sibilants, breaths, hiss
const V = new Float32Array(fs * 12);
const phrases = [[0.3, 1.6, 0.35], [2.2, 3.4, 0.08], [4.0, 5.8, 0.5], [6.5, 7.6, 0.12], [8.3, 10.5, 0.3]];
let ph = 0;
for (const [a, b, amp] of phrases) {
  for (let i = Math.floor(a * fs); i < b * fs; i++) {
    const t = i / fs, u = (t - a) / (b - a);
    const f0 = 120 + 30 * Math.sin(2 * Math.PI * 1.3 * t) + 8 * Math.sin(2 * Math.PI * 5.5 * t);
    ph += (2 * Math.PI * f0) / fs;
    let s = 0;
    for (let h = 1; h < 30; h++) { const f = f0 * h; const form = Math.exp(-((f - 700) ** 2) / 2e5) + 0.6 * Math.exp(-((f - 1200) ** 2) / 3e5) + 0.25 * Math.exp(-((f - 2600) ** 2) / 6e5) + 0.02; s += Math.sin(ph * h) * form / Math.sqrt(h); }
    const env = Math.min(1, u * 20, (1 - u) * 20) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 3 * t) ** 2);
    V[i] += amp * env * s * 0.5;
  }
  // sibilant burst at phrase start + breath before phrase
  let hp = 0, lp = 0;
  for (let i = Math.floor(a * fs); i < (a + 0.09) * fs; i++) { const n = rnd(); hp = n - lp; lp += (n - lp) * 0.35; V[i] += amp * 1.6 * hp * Math.sin(Math.PI * (i / fs - a) / 0.09); }
  for (let i = Math.max(0, Math.floor((a - 0.4) * fs)); i < (a - 0.05) * fs; i++) V[i] += 0.012 * rnd() * Math.sin(Math.PI * (i / fs - a + 0.4) / 0.35);
}
for (let i = 0; i < V.length; i++) V[i] += 0.0025 * rnd();
wav("vocal.wav", [V]);
// beat: 92 BPM, 16 s stereo
const B = [new Float32Array(fs * 16), new Float32Array(fs * 16)];
const beat = 60 / 92;
for (let k = 0; k * beat < 16; k++) {
  const s0 = Math.floor(k * beat * fs);
  for (let j = 0; j < fs * 0.4 && s0 + j < B[0].length; j++) {
    const t = j / fs; let v = 0;
    if (k % 2 === 0) v += Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-t * 30)) * t) * Math.exp(-t * 7) * 0.8;
    else v += (rnd() * 0.5 + Math.sin(2 * Math.PI * 190 * t) * 0.3) * Math.exp(-t * 18);
    v += 0.25 * Math.sin(2 * Math.PI * 41.2 * t) * Math.exp(-t * 2);
    B[0][s0 + j] += v; B[1][s0 + j] += v;
  }
  for (const half of [0, 0.5]) { const h0 = Math.floor((k + half) * beat * fs); for (let j = 0; j < fs * 0.05 && h0 + j < B[0].length; j++) { const v = rnd() * 0.15 * Math.exp(-j / 300); B[0][h0 + j] += v * 0.7; B[1][h0 + j] += v; } }
}
// synth pad in presence range to create masking
for (let i = 0; i < B[0].length; i++) { const t = i / fs; const v = 0.05 * (Math.sin(2 * Math.PI * 1100 * t) + Math.sin(2 * Math.PI * 1650 * t) + 0.6 * Math.sin(2 * Math.PI * 2475 * t)); B[0][i] += v; B[1][i] += v * 0.9; }
wav("beat.wav", B);
console.log("ok");
