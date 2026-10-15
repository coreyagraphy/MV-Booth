import { readFileSync } from "node:fs";
const { declick } = await import(new URL("../../js/dsp.js", import.meta.url));
function wav(path) { const b = readFileSync(path); let o = 12, fs = 48000, ch = 1, bits = 16, fmt = 1, data;
  while (o < b.length) { const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === "fmt ") { fmt = b.readUInt16LE(o + 8); ch = b.readUInt16LE(o + 10); fs = b.readUInt32LE(o + 12); bits = b.readUInt16LE(o + 22); }
    if (id === "data") data = b.subarray(o + 8, o + 8 + sz); o += 8 + sz + (sz & 1); }
  const N = data.length / (bits / 8) / ch, x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = fmt === 3 ? data.readFloatLE(i * ch * 4) : bits === 16 ? data.readInt16LE(i * ch * 2) / 32768 : data.readInt32LE(i * ch * 4) / 2147483648;
  return { x, fs }; }
const ok = (n, c, x = "") => console.log(`${c ? "PASS" : "FAIL"} ${n} ${x}`);
for (const f of ["vocal.wav", "double.wav"]) {
  const { x, fs } = wav(`${process.cwd()}/${f}`);
  const clean = declick(x, fs).clicks;
  const y = x.slice(); const pos = [];
  for (let k = 0; k < 30; k++) { const i = Math.floor((k + 0.5) / 30 * (x.length - 1000)); pos.push(i); const amp = 0.05 * (k % 2 ? 1 : -1);
    y[i] += amp; y[i + 1] -= amp * 0.6; y[i + 2] += amp * 0.25; }
  const r = declick(y, fs);
  ok(`${f}: no false clicks on a clean take`, clean <= 2, String(clean));
  ok(`${f}: repairs most injected clicks`, r.clicks >= 18, `${r.clicks}/30 (the rest are left untouched when a repair would be worse)`);
  let e = 0; for (const i of pos) for (let k = -60; k < 63; k++) e = Math.max(e, Math.abs(r.out[i + k] - x[i + k]));
  ok(`${f}: never moves audio more than a click`, e < 0.12, `max deviation ${e.toFixed(3)}`);
}
