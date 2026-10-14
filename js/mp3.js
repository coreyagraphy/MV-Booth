// MP3 export: LAME (lamejs, LGPL — see js/vendor/LAME-LICENSE.txt) running in
// a Worker so the UI never freezes. The single-file build inlines the encoder
// source into globalThis.__LAME_SRC; otherwise it is fetched next to this file.

const WORKER = `
onmessage = (e) => {
  const { left, right, sampleRate, kbps } = e.data;
  const enc = new lamejs.Mp3Encoder(2, sampleRate, kbps);
  const toPcm = (f) => { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); o[i] = v < 0 ? v * 32768 : v * 32767; } return o; };
  const L = toPcm(left), R = toPcm(right);
  const parts = [];
  const block = 1152 * 20;
  for (let i = 0; i < L.length; i += block) {
    const buf = enc.encodeBuffer(L.subarray(i, i + block), R.subarray(i, i + block));
    if (buf.length) parts.push(new Uint8Array(buf));
    if ((i / block) % 20 === 0) postMessage({ progress: i / L.length });
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  postMessage({ done: new Blob(parts, { type: "audio/mpeg" }) });
};`;

let lameSrc = null;
async function loadLame() {
  if (lameSrc) return lameSrc;
  lameSrc = globalThis.__LAME_SRC ?? (await (await fetch("js/vendor/lame.min.js")).text());
  return lameSrc;
}

/** Encode a stereo AudioBuffer to a 320 kbps MP3 Blob. */
export async function encodeMp3(buffer, { kbps = 320, onProgress } = {}) {
  const src = await loadLame();
  const url = URL.createObjectURL(new Blob([src, WORKER], { type: "text/javascript" }));
  const w = new Worker(url);
  const left = buffer.getChannelData(0).slice();
  const right = (buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)).slice();
  try {
    return await new Promise((resolve, reject) => {
      w.onmessage = (e) => {
        if (e.data.progress != null) onProgress?.(e.data.progress);
        if (e.data.done) resolve(e.data.done);
      };
      w.onerror = (e) => reject(new Error(e.message || "MP3 encoder failed"));
      w.postMessage({ left, right, sampleRate: buffer.sampleRate, kbps }, [left.buffer, right.buffer]);
    });
  } finally {
    w.terminate();
    URL.revokeObjectURL(url);
  }
}
