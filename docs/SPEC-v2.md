# MV Booth 2.5: DAW-parity spec

Revision of the "MV BOOTH 2.0 — Engineering Spec" (2026-10-14), checked against what a typical DAW gives a vocal session (Pro Tools, Logic, LUNA, Studio One). Status is what ships in this repo now. **Built** means implemented and covered by the browser test run below.

## 1. DAW parity matrix

### Transport & time
| Feature (typical DAW) | In 2.0 spec | MV Booth 2.1 |
|---|---|---|
| Play / pause (keeps position) / stop (returns to start point) / return to zero | ✓ | **Built**: Space, Enter, Home |
| Bar · beat readout from the audio clock | ✓ | **Built**: `Bar X · Beat Y · BPM · 4/4` |
| Manual tempo + tap tempo + detect from beat | ✓ | **Built**: T taps (average of the last 4, 60–200 clamp) |
| Metronome, accent on beat 1, never printed | ✓ | **Built**: synth click straight to the speakers, level control (C) |
| Count-in 1–2 bars | ✓ | **Built**: scheduled on the audio clock; recording starts on the bar |
| Loop playback over a region | partial | **Built**: drag on the ruler to set it, L toggles, sample-accurate pass scheduling |
| Loop record → one take per pass | ✓ | **Built**: a stopped-early final pass is kept as a take but not put on the track |
| Nudge playhead (beat / bar) | ✓ | **Built**: ← → (Shift = bar) |
| Markers | ✗ | **Built**: M adds; click on the ruler jumps; double-click renames or deletes; Song tab drops named Intro/Verse/Hook/Bridge/Outro markers |
| Guided start-to-finish song workflow | ✗ | **Built (2.4)**: Song tab checklist (10 steps, auto-ticks, highlights the next step) |
| Punch in/out with pre-roll / post-roll | ✗ | **Built (2.2)**: Shift-drag or selection sets the range (red), P arms, 1–2 bar pre-roll, sample-exact latency-compensated capture, 1 bar post-roll, auto-stop, new take + 10 ms crossfades |
| Tempo map / time-signature changes | ✗ | Not built (fixed 4/4, one tempo) |

### Tracks, takes & editing
| Feature | In 2.0 spec | MV Booth 2.1 |
|---|---|---|
| Multitrack with typed tracks (Lead, Double, Ad-lib, Hook, Beat) | ✓ | **Built**: + Track menu |
| Multi-stem beats (track-outs) | ✗ | **Built (2.5)**: import many files at once; one lane + strip per stem with volume, pan, mute, solo; role (full / drums / 808-bass / melody / FX) guessed from the name, editable; old sessions migrate to one "Full beat" stem |
| Record-arm, one track at a time; arming decides the take type | ✓ | **Built**: "Next take is a" removed |
| Mute / solo (solo overrides mute) | ✓ | **Built**: vocal tracks and beat stems share one solo group |
| Take lanes, ★ best, use whole take | ✓ | **Built**: collapsible per track |
| Region comping (a different take per section) | ✗ | **Built**: split, then "Comp" swaps a take into the selected clip |
| Clips: move, trim, split, delete | ✗ | **Built**: explicit tool picker (2.3): Move / Trim / Cut / Fade, keys 1–4, tool cursors, hint line; X cuts at playhead, Delete removes |
| Clip gain and fades | ✗ (metadata only) | **Built**: drag the fade handles on top corners, or set them in the clip inspector |
| Snap to grid | ✓ | **Built**: 1/16 grid; hold Alt to bypass |
| Zoom and scroll | ✓ (0.5–2.2×) | **Built**: −/+/Fit, Ctrl+wheel zooms at the cursor, Shift/sideways wheel scrolls, follows the playhead |
| Non-destructive edits (takes immutable) | ✓ | **Built**: all edits are metadata; audio stays untouched |
| Undo / redo (cap 50, slider drags coalesced) | ✓ | **Built**: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y |
| Crossfades between adjacent clips | ✗ | Partial: automatic 5 ms edge fades; no overlapping crossfade editor |
| Pitch/time editing per note (Melodyne-style) | ✗ | Not built: correction is automatic (Tune tab) |

### Input & monitoring
| Feature | In 2.0 spec | MV Booth 2.1 |
|---|---|---|
| Input gain (−∞…+24 dB) before the recorder | ✓ | **Built** |
| Input meter + clip-hold LED | ✓ | **Built** (2 s hold) |
| Recording clearly visible while it happens | ✗ | **Built (2.3)**: count-in / pre-roll / RECORDING / post-roll banner with time recorded and live input level, red timeline glow, live red waveform on the armed track |
| Direct monitoring post-gain | ✓ | **Built**: round-trip readout, warns over 25 ms |
| Latency trim + auto-calibrate, stored per device | ✓ | **Built**: 4-click loopback, median onset |
| Monitoring through FX (live reverb in headphones) | ✗ | Not built |

### Mixer
| Feature | In 2.0 spec | MV Booth 2.1 |
|---|---|---|
| Per-track volume (−60…+6) and pan | ✓ | **Built**: header slider plus Mixer strips |
| Per-track meters | ✗ | **Built**: live in the Mixer tab, one per vocal track and beat stem |
| Separate reverb and delay sends per track | ✓ | **Built**: also drive the engine mix |
| Reverb types / tempo-synced delay division | ✓ (1.2–2.8 s) | **Built**: Booth 0.35, Room 0.8, Plate 1.6, Hall 2.6 s; delay 1/4, dotted 1/8 (default), 1/8, 1/16 |
| Master fader + limiter | ✓ | **Built**: live −1 dB limiter; exports use the true-peak mastering chain |
| Master tone / width / ceiling | ✗ | **Built (2.4)**: tone tilt (neutral, warm, bright, dark), mid/side width 0–150 %, ceiling −0.3/−1/−2 dBTP |
| Vocal-vs-beat macro | ✓ (±12) | **Built**: ±12 dB, plus the beat fader |
| Insert FX you can tweak (EQ/comp per track) | ✗ | Engine decides; manual inserts not built (FX: Clean / Phone / Wide) |
| Automation lanes (volume/pan over time) | ✗ | Engine writes the vocal-rider automation (shown on the lane); manual automation not built |
| Buses / groups | ✗ | Engine uses a vocal bus internally; user buses not built |

### Engine (Automix pipeline)
| Feature | In 2.0 spec | MV Booth 2.1 |
|---|---|---|
| Ordered stages TUNE → ALIGN → DOUBLE → CLEAN → TONE → DYNAMICS → SPACE → MASTER | ✓ | **Built** |
| Per-stage enable, states queued / active / done / failed / skipped | ✓ | **Built**: click a stage in the dock to switch it off |
| Cancellable; failure never drops audio | ✓ | **Built**: Cancel button; takes are never modified |
| Pitch correction with strength, key/scale, formant keep, vibrato keep | ✓ (WASM or backend) | **Built both ways**: in-browser YIN + PSOLA inside Automix, and **Studio tune (2.2)**: local backend, CREPE + WORLD, per-region confidence, low-confidence regions left untouched, result as a new take |
| Align doubles to the lead | ✓ (quantize) | **Built**: DTW + WSOLA timing, PSOLA pitch-match |
| Double stage: detune, delay, −6 dB, or use the recorded double | ✓ | **Built**: ±9–11 cents, drifting 19–27 ms, optional octave |
| Breath control | ✓ | **Built**: keep / reduce / remove per track (2.4) |
| Vocal cleanup you can set (de-noise, de-ess, pop filter, de-click, hum) | ✗ | **Built (2.4)**: Clean tab per track; preview renders a non-destructive "· clean" take. De-click = isolated-spike detector + least-squares AR interpolation, reverted where it can't predict |
| RAW / MIX A/B | ✓ | **Built**: B key |

### Metering & loudness
| Feature | In 2.0 spec | MV Booth 2.1 |
|---|---|---|
| BS.1770 integrated LUFS on the mixdown | ✓ | **Built**: verified to −3.01 LUFS on the reference sine |
| True peak via 4× oversampling | ✓ | **Built**: verified (sample −3.01 dB → true 0.00 dBTP on the fs/4 test) |
| Master hits loudness target and ≤ −1 dBTP | ✓ | **Built**: iterative limiter; test mix −14.2 LUFS / −1.0 dBTP |
| Live short-term loudness labelled "approx" | ✓ | **Built**: shows "—" in silence, never fake numbers |

### Session & export
| Feature | In 2.0 spec | MV Booth 2.1 |
|---|---|---|
| Named sessions, autosave to IndexedDB, list, duplicate | ✓ | **Built** |
| Delete to trash, recoverable for 30 days | ✓ | **Built** |
| Master WAV 48 kHz / 24-bit | ✓ | **Built**: 48 or 44.1 kHz |
| MP3 320 kbps in a Worker | ✓ | **Built**: lamejs (LGPL, vendored with licence) |
| Stems (one per track) and raw takes | ✓ | **Built**: one per vocal track and one per beat stem |
| Lyric import (.txt), `[bar N]` sync, manual advance | ✓ | **Built**: highlighted line follows the playhead; ↓/↑ advance by hand |

## 2. Decisions on the spec's open questions (updated for 2.2)

1. **Client-side or backend?** Both. The browser still does tracking, editing, Automix and in-browser tuning. A **local** FastAPI backend (`backend/`, 127.0.0.1:8765, no auth, stateless) does the best-quality offline tuning. The session model stays in the browser.
2. **Real-time or offline pitch correction?** Offline post-record on the backend is the quality path. Live tuned monitoring is deliberately not built.
3. **Who builds it?** Built here, iteratively, in the MV-Booth repo.
4. **Target user?** Personal studio tool (single user, no auth). Multi-artist accounts would add auth, sync and billing scope.

## 3. Data model (as built)

```text
session { id, name, mode, settings{…, stages{tune…master}}, lyrics, markers[{t,name}],
          loop{on,start,end}, master{volumeDb},
          beats[{ id, name, kind: full|drums|bass|melody|fx, volumeDb, pan, mute, solo, offset }],
          tracks[{ id, name, type, color, armed, volumeDb, pan, mute, solo, fx, tune, dbl,
                   revSend, dlySend, showTakes,
                   takes[{ id, name, at, duration, best, transcript }],      // immutable audio
                   clips[{ id, takeId, start, end, shift, gainDb, fadeIn, fadeOut }] }] }
```

A clip plays take audio at source time `t − shift − take.at` for timeline `t` in `[start, end)`. Moving a clip shifts `start`, `end` and `shift` together. Comping swaps `takeId`. Audio lives in IndexedDB under `audio:<takeId>`.

## 4. Verification (2.1 suite; 2.2 adds the punch and studio-tune suites; 2.4 the song/clean suite; 2.5 the stems suite)

All suites now live in `tests/` and run with `cd tests && npm install && npm test` (lint + declick, daw, punch, ux, song, stems, fixes, single; `npm run test:all` adds the backend studio suite). 2.5.2 adds the `dsp` suite (FFT vs a reference DFT, pitch accuracy, LUFS at 48 and 44.1 kHz, true peak, de-noise behaviour) and `tests/bench.mjs` (3-minute song timing). 2.5.1 adds the `fixes` suite (9 checks) for the audit fixes: short ad-lib loudness, a clip starting before 0:00, undo refused while recording, save flushed on close, duplicate-safe purge.

The browser test drives the real UI in headless Chromium with a simulated mic. Twenty-four checks pass with zero page errors:
- beat import + BPM detect, arm, ruler loop drag
- loop record with count-in → 3 takes, undo/redo
- pause keeps position, stop returns to start
- split, comp, snapped clip drag
- mixer fader, bar-synced prompter
- stage-off honoured, Automix −14.2 LUFS / −1.0 dBTP, stage states
- WAV 48 kHz/24-bit, MP3 320
- new/switch session, persistence after reload

2.5 stems suite (18 checks): three stems imported in one go with roles guessed, BPM from the drums, role change + undo, mute leaves a stem out of the mix, report treats each stem by role, master −14.2 LUFS / −1.0 dBTP, stem export = vocal + 3 beat stems with the 808 folded to exact mono, solo, one mixer strip per stem, remove + undo, persistence after reload.

2.4 song/clean suite (12 checks): checklist order and next-step highlight, section markers, clean settings stored per track, cleaned take added with clips swapped and the raw take bit-identical, report lines for breaths / pop / de-click / hum, undo, master tone/width/ceiling applied (−14.2 LUFS, −2.0 dBTP with a −2 ceiling). De-click bench: 0 false triggers on two clean 12 s vocals; 20–23 of 30 injected clicks repaired (the rest are left alone because a repair would move the audio more than the click); median repair +8.5 to +9.2 dB.

### Performance (2.5.2, 3-minute song, lead + recorded double + AI doubles + beat, headless Chromium)

| | Before | After |
|---|---|---|
| Automix, natural tune + AI doubles | 92 s | 68 s |
| Automix, tune/align/doubles off | 53 s | 40 s |
| Full UI re-render | 18 ms | 13 ms |

How: twiddle-outer FFT loop order (−25–30 %, bit-identical); two real frames per complex FFT in pitch tracking (3 → 2 transforms per frame, identical f0), de-noise (2× faster, ≤1e-7 difference) and vocal analysis; fused K-weighting; the engine's YIN pitch reused for the low-cut decision; waveforms drawn as one path with one glow; canvases resized only when their size changes; hidden side panels rebuilt when opened. Rejected: reusing the double's pitch after alignment (5 s faster but alignment got worse: 9 → 13 cents, ±5 ms).

## 5. Backend contract (as built, 2.2)

```text
GET  /health                      → { ok, version, engines{torch,crepe,world} | error }
POST /tune  multipart file=<WAV>, params=<JSON>
     params: key ("auto"|0-11), scale, retune_ms (0=hard), vibrato (0..1 keep), amount (0..1),
             formant (bool), min_confidence (0..1), model ("full"|"tiny")
     → { job }
GET  /jobs/{id}                   → { state: queued|running|done|failed, progress, message, report }
GET  /jobs/{id}/audio             → tuned WAV (float32, same length and rate as the input)
report: { key{label,tonic,scale,confident}, regions[{start,end,confidence,tuned,mean_shift_cents,reason}], summary }
```

CORS allows localhost and https://mv-booth.netlify.app, including Chrome's Private Network Access preflight, so the installed web app can reach the local backend.

**Measured (synthetic voice, three notes −40/+30/−25 ¢ with vibrato):** Natural lands within ±1.2 ¢ and keeps the vibrato (σ ≈ 12 ¢ in and out). Hard (retune 0) requests exactly 0.00 ¢ and WORLD's harvest tracker measures −0.04…−0.01 ¢. Auto-key finds A minor. A noise burst comes back bit-identical. A 12 s take takes about 18 s on CPU.

## 6. Next (candidates, by value)

1. Volume/pan automation lanes you can draw.
2. Crossfade editor for comp boundaries.
3. Manual EQ/compressor insert per track, overriding the engine.
4. Backend vocal isolation / ML denoise stages on the same job API.
