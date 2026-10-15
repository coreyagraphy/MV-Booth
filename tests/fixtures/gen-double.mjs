import { readFileSync, writeFileSync } from "node:fs";
import { trackPitch, psola } from "../../js/tune.js";
const b = readFileSync("vocal.wav"); const fs = 48000; const n = (b.length - 44) / 2;
const lead = new Float32Array(n); for (let i = 0; i < n; i++) lead[i] = b.readInt16LE(44 + i * 2) / 32768;
let dbl = new Float32Array(n);
for (const [a, e, sh] of [[0, 3.8, 0.055], [3.8, 7.2, -0.04], [7.2, 12, 0.07]]) for (let i = Math.floor(a * fs); i < e * fs; i++) { const s = i - Math.round(sh * fs); dbl[i] = s >= 0 && s < n ? lead[s] * 0.9 : 0; }
const p = await trackPitch(dbl, fs); dbl = await psola(dbl, fs, p.f0, new Float32Array(p.f0.length).fill(0.35));
const out = Buffer.from(b); for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, dbl[i])) * 32767), 44 + i * 2);
writeFileSync("double.wav", out); console.log("double.wav ok");
