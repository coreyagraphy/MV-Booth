// Session package (.mvbooth): one file that carries a whole session (model + the audio it uses), so a
// song can move between browsers or machines and be mixed exactly as it was recorded.
//
// Layout before gzip:  "MVBOOTH\x01" · uint32 LE header length · header JSON (UTF-8) · audio
// Audio: for each header.audio entry in order, each channel as 24-bit little-endian PCM (planar), divided
// by the entry's `scale` (its peak when above 1.0: the app works in float, so takes can exceed full
// scale and must not be clipped on the way out).
// 24-bit is far below any microphone's noise floor, and gzip (built into the browser) trims the rest.

const MAGIC = "MVBOOTH\x01";

/** Audio ids a session actually needs: every beat stem and every take a clip plays. */
export function usedAudioIds(session) {
  const ids = new Set((session.beats || []).map((b) => b.id));
  for (const t of session.tracks || []) for (const c of t.clips || []) ids.add(c.takeId);
  return [...ids];
}

/**
 * Pack a session. `audio` maps id → { sampleRate, channels: Float32Array[] }. Takes no clip uses are
 * dropped from the session too, so the package opens without missing audio.
 * Returns a gzip Blob.
 */
export async function packSession(session, audio) {
  const s = structuredClone(session);
  const ids = usedAudioIds(s).filter((id) => audio.has(id));
  const keep = new Set(ids);
  for (const t of s.tracks) {
    t.takes = t.takes.filter((k) => keep.has(k.id));
    t.clips = t.clips.filter((c) => keep.has(c.takeId));
  }
  s.beats = (s.beats || []).filter((b) => keep.has(b.id));
  const entries = ids.map((id) => {
    const a = audio.get(id);
    let peak = 0;
    for (const ch of a.channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    return { id, sampleRate: a.sampleRate, channels: a.channels.length, length: a.channels[0].length, scale: Math.max(1, peak) };
  });
  const header = new TextEncoder().encode(JSON.stringify({ format: 1, app: "MV Booth", created: Date.now(), session: s, audio: entries }));
  const parts = [new TextEncoder().encode(MAGIC), new Uint8Array(new Uint32Array([header.length]).buffer), header];
  for (const e of entries) {
    const k = 8388607 / e.scale;
    for (const ch of audio.get(e.id).channels) {
      const out = new Uint8Array(ch.length * 3);
      for (let i = 0, o = 0; i < ch.length; i++, o += 3) {
        const v = Math.round(Math.max(-8388607, Math.min(8388607, ch[i] * k)));
        out[o] = v & 0xff;
        out[o + 1] = (v >> 8) & 0xff;
        out[o + 2] = (v >> 16) & 0xff;
      }
      parts.push(out);
    }
  }
  return new Response(new Blob(parts).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

/** Unpack a .mvbooth file (Blob/ArrayBuffer). Returns { session, audio: Map id → { sampleRate, channels } }. */
export async function unpackSession(file) {
  const blob = file instanceof Blob ? file : new Blob([file]);
  let buf;
  try {
    buf = new Uint8Array(await new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  } catch {
    throw new Error("not an MV Booth session package (expected a .mvbooth file from Export → Session package)");
  }
  if (new TextDecoder().decode(buf.subarray(0, 8)) !== MAGIC) throw new Error("not an MV Booth session package (expected a .mvbooth file from Export → Session package)");
  const hlen = new DataView(buf.buffer, buf.byteOffset + 8, 4).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + hlen)));
  if (header.format !== 1) throw new Error(`package format ${header.format} is newer than this MV Booth`);
  let o = 12 + hlen;
  const audio = new Map();
  for (const e of header.audio) {
    const k = (e.scale || 1) / 8388607;
    const channels = [];
    for (let c = 0; c < e.channels; c++) {
      const ch = new Float32Array(e.length);
      for (let i = 0; i < e.length; i++, o += 3) {
        let v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
        if (v & 0x800000) v -= 0x1000000;
        ch[i] = v * k;
      }
      channels.push(ch);
    }
    audio.set(e.id, { sampleRate: e.sampleRate, channels });
  }
  if (o !== buf.length) throw new Error("package is damaged (size mismatch)");
  return { session: header.session, audio };
}
