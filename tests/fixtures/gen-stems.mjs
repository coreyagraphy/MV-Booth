import { writeFileSync } from "node:fs";
const fs = 48000, N = fs * 12, bpm = 92, beat = 60 / bpm;
let seed = 11; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
function wav(name, chans) {
  const n = chans[0].length, ch = chans.length, b = Buffer.alloc(44 + n * ch * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * ch * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(fs, 24); b.writeUInt32LE(fs * ch * 2, 28);
  b.writeUInt16LE(ch * 2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * ch * 2, 40);
  let o = 44; for (let i = 0; i < n; i++) for (const c of chans) { b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, c[i])) * 32767), o); o += 2; }
  writeFileSync(name, b);
}
const dL = new Float32Array(N), dR = new Float32Array(N), bL = new Float32Array(N), bR = new Float32Array(N), mL = new Float32Array(N), mR = new Float32Array(N);
for (let k = 0; k * beat / 2 < 12; k++) {
  const t0 = k * beat / 2, i0 = Math.floor(t0 * fs);
  const isBeat = k % 2 === 0, n = k / 2;
  if (isBeat && n % 2 === 0) { // kick + 808
    let ph = 0, ph2 = 0;
    for (let i = 0; i < 0.25 * fs && i0 + i < N; i++) { const t = i / fs; ph += 2 * Math.PI * (50 + 90 * Math.exp(-t * 30)) / fs; const v = 0.7 * Math.sin(ph) * Math.exp(-t * 14); dL[i0 + i] += v; dR[i0 + i] += v; }
    for (let i = 0; i < 0.6 * fs && i0 + i < N; i++) { const t = i / fs; ph2 += 2 * Math.PI * (44 + 20 * Math.exp(-t * 20)) / fs; const v = 0.55 * Math.tanh(1.5 * Math.sin(ph2)) * Math.exp(-t * 3); bL[i0 + i] += v; bR[i0 + i] += v * 0.8; }
  }
  if (isBeat && n % 2 === 1) for (let i = 0; i < 0.18 * fs && i0 + i < N; i++) { const t = i / fs, v = (0.45 * rnd() + 0.3 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 22); dL[i0 + i] += v; dR[i0 + i] += v; }
  let hp = 0, lp = 0;
  for (let i = 0; i < 0.05 * fs && i0 + i < N; i++) { const x = rnd(); hp = x - lp; lp += (x - lp) * 0.5; const v = 0.18 * hp * Math.exp(-i / fs * 70); dL[i0 + i] += v * 0.7; dR[i0 + i] += v; }
}
const chords = [[57, 60, 64], [53, 57, 60], [55, 59, 62], [52, 55, 59]];
for (let i = 0; i < N; i++) {
  const t = i / fs, c = chords[Math.floor(t / (beat * 4)) % 4];
  let v = 0; for (const m of c) { const f = 440 * 2 ** ((m - 69) / 12); for (let h = 1; h < 8; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * 1.4); }
  v *= 0.05 * (0.8 + 0.2 * Math.sin(2 * Math.PI * 0.25 * t));
  mL[i] = v; mR[i] = v * 0.6;
}
wav("Drums.wav", [dL, dR]); wav("808.wav", [bL, bR]); wav("Keys.wav", [mL, mR]);
console.log("stems written");
