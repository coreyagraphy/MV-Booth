// Metronome (synth click, scheduled on the audio clock), count-in maths and
// tap tempo. Clicks go straight to the speakers, never into takes or bounces.

export class Metronome {
  constructor(ctx) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    this.nodes = [];
  }
  set level(v) {
    this.out.gain.value = v;
  }
  /** Schedule one click at audio-clock time `when`. */
  click(when, accent) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(accent ? 0.9 : 0.55, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0008, when + 0.05);
    o.connect(g).connect(this.out);
    o.start(when);
    o.stop(when + 0.06);
    this.nodes.push(o);
    o.onended = () => (this.nodes = this.nodes.filter((n) => n !== o));
  }
  /**
   * Clicks for every beat whose timeline position lies in [posFrom, posTo),
   * where timeline position `posAnchor` sounds at audio time `tAnchor`.
   */
  schedule(bpm, posFrom, posTo, posAnchor, tAnchor) {
    if (!bpm) return;
    const beat = 60 / bpm;
    for (let b = Math.ceil(posFrom / beat - 1e-6); b * beat < posTo - 1e-6; b++) {
      const when = tAnchor + (b * beat - posAnchor);
      if (when >= this.ctx.currentTime - 0.005) this.click(Math.max(when, this.ctx.currentTime), ((b % 4) + 4) % 4 === 0);
    }
  }
  stop() {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already done */
      }
    }
    this.nodes = [];
  }
}

export const barSeconds = (bpm) => (bpm ? (60 / bpm) * 4 : 2);

export function barBeat(pos, bpm) {
  if (!bpm) return null;
  const beat = 60 / bpm;
  const b = Math.floor(pos / beat + 1e-6);
  return { bar: Math.floor(b / 4) + 1, beat: (((b % 4) + 4) % 4) + 1 };
}

export function snapTime(t, bpm, division = 1) {
  if (!bpm) return Math.round(t * 10) / 10;
  const g = (60 / bpm) / division;
  return Math.round(t / g) * g;
}

export class TapTempo {
  constructor() {
    this.taps = [];
  }
  /** Returns BPM after 2+ taps (average of the last 4 intervals), else 0. */
  tap(now = performance.now()) {
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    this.taps = this.taps.slice(-5);
    if (this.taps.length < 2) return 0;
    const iv = [];
    for (let i = 1; i < this.taps.length; i++) iv.push(this.taps[i] - this.taps[i - 1]);
    const bpm = 60000 / (iv.reduce((a, b) => a + b, 0) / iv.length);
    return Math.round(Math.min(200, Math.max(60, bpm)));
  }
}

/**
 * Sync test analysis. `data` was recorded from the first click on; clicks are `gap` s apart, the
 * first `lead` are warm-up. Returns the median delay from each measured click to the artist's clap
 * (= how late a take sung on the beat really lands), or an error the artist can act on.
 */
export function measureSync(data, fs, { gap, lead, n }) {
  // Onset = first big jump in the sample-to-sample difference (claps and "t" are broadband).
  const d = new Float32Array(data.length);
  for (let i = 1; i < data.length; i++) d[i] = Math.abs(data[i] - data[i - 1]);
  // Noise floor: median of the whole recording (claps are short, so they barely move it).
  const sample = [];
  for (let i = 0; i < d.length; i += 13) sample.push(d[i]);
  sample.sort((x, y) => x - y);
  const floor = Math.max(0.003, (sample[sample.length >> 1] || 0) * 8);
  const offs = [];
  for (let k = lead; k < lead + n; k++) {
    const a = Math.max(0, Math.round((k * gap - 0.2) * fs));
    const b = Math.min(d.length, Math.round((k * gap + gap - 0.2) * fs));
    let mx = 0;
    for (let i = a; i < b; i++) mx = Math.max(mx, d[i]);
    if (mx < floor) continue;
    for (let i = a; i < b; i++) {
      if (d[i] > mx * 0.3) {
        offs.push(i / fs - k * gap);
        break;
      }
    }
  }
  if (offs.length < Math.ceil(n / 2)) return { error: `only heard ${offs.length} of ${n} claps. Clap louder (or closer to the mic) and try again.`, heard: offs.length };
  offs.sort((x, y) => x - y);
  const q = (p) => offs[Math.min(offs.length - 1, Math.floor(p * offs.length))];
  const spread = q(0.75) - q(0.25);
  if (spread > 0.06) return { error: `claps were uneven (±${Math.round(spread * 500)} ms). Try again, steady and right on the click.`, heard: offs.length };
  return { latency: q(0.5), spread, heard: offs.length };
}
