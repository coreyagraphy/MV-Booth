// 24-bit PCM WAV encoder + download helper.
export function encodeWav(buffer, bits = 24) {
  const ch = buffer.numberOfChannels;
  const n = buffer.length;
  const bps = bits / 8;
  const data = n * ch * bps;
  const out = new DataView(new ArrayBuffer(44 + data));
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + data, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, ch, true);
  out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * ch * bps, true);
  out.setUint16(32, ch * bps, true);
  out.setUint16(34, bits, true);
  str(36, "data");
  out.setUint32(40, data, true);
  const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  const max = 2 ** (bits - 1) - 1;
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.round(Math.max(-1, Math.min(1, chans[c][i])) * max);
      if (bits === 24) {
        out.setUint8(o, v & 0xff);
        out.setUint8(o + 1, (v >> 8) & 0xff);
        out.setUint8(o + 2, (v >> 16) & 0xff);
      } else {
        out.setInt16(o, v, true);
      }
      o += bps;
    }
  }
  return new Blob([out.buffer], { type: "audio/wav" });
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
