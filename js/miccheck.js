// Mic check: a 10-second test before recording. The first part is silence, then the artist says a
// line twice with a pause. From that one recording: noise floor, level, clipping and how much of
// the room the mic hears, each with one plain instruction.
import { percentile } from "./dsp.js";

const db = (p) => 10 * Math.log10(Math.max(p, 1e-12));

/**
 * @param x mono recording (after the booth's input gain)
 * @param quietSec how long the artist was asked to stay silent at the start
 * @returns { peakDb, clipped, noiseDb, speechDb, snrDb, roomDb, heard, checks: [{ key, state: "good"|"warn"|"bad", title, text }] }
 */
export function analyseMicCheck(x, fs, { quietSec = 3 } = {}) {
  const hop = Math.round(fs * 0.02);
  const frames = Math.floor(x.length / hop);
  const rms = new Float32Array(frames);
  let peak = 0, hot = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const a = Math.abs(x[i]);
      s += a * a;
      if (a > peak) peak = a;
      if (a >= 0.985) hot++;
    }
    rms[f] = db(s / hop);
  }
  const q0 = Math.round(0.4 / 0.02), q1 = Math.max(q0 + 5, Math.round((quietSec - 0.3) / 0.02));
  const noiseDb = percentile(Array.from(rms.subarray(q0, Math.min(frames, q1))), 0.5);
  const said = Array.from(rms.subarray(Math.min(frames, q1)));
  const speechDb = said.length ? percentile(said, 0.9) : -120;
  const heard = speechDb > noiseDb + 12 && speechDb > -55;
  const peakDb = 20 * Math.log10(Math.max(peak, 1e-6));
  const clipped = hot >= 3;
  const snrDb = speechDb - noiseDb;

  // Room: how far the level has dropped 60–170 ms after the voice stops, relative to the voice.
  // "Stops" = drops out of the body of the voice (6 dB under it): a lower mark would be crossed late
  // on a roomy take, after part of the tail had already gone by, and make it read drier than it is.
  const loudT = speechDb - 6;
  const tails = [];
  for (let f = Math.max(q1, 10); f + 14 < frames; f++) {
    if (!(rms[f] > loudT && rms[f + 1] <= loudT)) continue;
    let quiet = true;
    for (let k = 2; k <= 13 && quiet; k++) quiet = rms[f + k] <= loudT;
    if (!quiet) continue;
    let body = 0, tail = 0;
    for (let k = 0; k < 10; k++) body += Math.pow(10, rms[f - k] / 10);
    for (let k = 3; k <= 8; k++) tail += Math.pow(10, rms[f + k] / 10);
    tails.push(db(tail / 6) - db(body / 10));
    f += 13;
  }
  const roomDb = heard && tails.length ? percentile(tails, 0.5) : NaN;

  const checks = [];
  const r = (v) => Math.round(v);
  if (!heard && noiseDb > -50) {
    checks.push({ key: "level", state: "bad", title: "Couldn't tell your voice from the background", text: "Either you spoke during the quiet part or the room is very loud. Stay silent for the first 3 seconds, then say your line." });
  } else if (!heard) {
    checks.push({ key: "level", state: "bad", title: "Didn't hear you", text: "No voice came through after the quiet part. Check that the right microphone is selected and that it isn't muted, then run the check again." });
  } else if (clipped || peakDb > -1) {
    checks.push({ key: "level", state: "bad", title: "Too hot: clipping", text: "Your loudest words hit the ceiling and distort. Turn the mic's gain down about 8 dB (the knob on the mic, or its level in Windows sound settings), then check again." });
  } else if (peakDb > -4) {
    checks.push({ key: "level", state: "warn", title: `A little hot (peaks ${r(peakDb)} dB)`, text: "One loud word will clip. Turn the gain down about 4 dB." });
  } else if (peakDb < -24) {
    checks.push({ key: "level", state: "bad", title: `Too quiet (peaks ${r(peakDb)} dB)`, text: `Turn the gain up about ${r(-12 - peakDb)} dB, or get closer to the mic. Aim for peaks around −12 to −6 dB.` });
  } else if (peakDb < -18) {
    checks.push({ key: "level", state: "warn", title: `A bit quiet (peaks ${r(peakDb)} dB)`, text: `Turn the gain up about ${r(-12 - peakDb)} dB. Aim for peaks around −12 to −6 dB.` });
  } else {
    checks.push({ key: "level", state: "good", title: `Level is good (peaks ${r(peakDb)} dB)`, text: "Leave the gain where it is." });
  }
  if (heard) {
    if (snrDb >= 45) checks.push({ key: "noise", state: "good", title: `Quiet background (${r(snrDb)} dB under your voice)`, text: "Nothing to fix." });
    else if (snrDb >= 35) checks.push({ key: "noise", state: "warn", title: `Some background noise (${r(snrDb)} dB under your voice)`, text: "De-noise will cover it under a beat. For voice-over, switch off fans or AC and move the mic away from the PC." });
    else checks.push({ key: "noise", state: "bad", title: `Noisy (${r(snrDb)} dB under your voice)`, text: "Switch off fans, AC and anything humming, move the mic away from the PC, and get closer to the mic so your voice is louder than the room." });

    if (!Number.isFinite(roomDb)) checks.push({ key: "room", state: "warn", title: "Room: couldn't measure", text: "Say the line, stop completely for a second, then say it again, so the check can hear what the room does after you stop." });
    else if (roomDb <= -30) checks.push({ key: "room", state: "good", title: `Dry (room ${r(-roomDb)} dB under your voice)`, text: "The mic hears you, not the room. Keep this position." });
    else if (roomDb <= -24) checks.push({ key: "room", state: "warn", title: `Some room sound (${r(-roomDb)} dB under your voice)`, text: "Move about 2 inches closer and speak straight into the end of the mic. Automix will hold the rest down." });
    else checks.push({ key: "room", state: "bad", title: `Roomy (${r(-roomDb)} dB under your voice)`, text: "The mic hears the room almost as much as you: this is what makes a mix sound hollow. Get within 2–3 inches, speak into the end of the mic (not the side), turn the gain down to match, and record facing something soft (a closet of clothes, a blanket behind the mic)." });
  }
  return { peakDb, clipped, noiseDb, speechDb, snrDb, roomDb, heard, checks };
}
