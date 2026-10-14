# MV Booth 2.1: DAW-parity spec

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
| Markers | ✗ | **Built**: M adds; click on the ruler jumps; double-click renames or deletes |
| Punch in/out with pre-roll | ✗ | Partial: recording starts at the playhead (or loop start) after count-in; auto punch-out not built |
| Tempo map / time-signature changes | ✗ | Not built (fixed 4/4, one tempo) |

### Tracks, takes & editing
| Feature | In 2.0 spec | MV Booth 2.1 |
|---|---|---|
| Multitrack with typed tracks (Lead, Double, Ad-lib, Hook, Beat) | ✓ | **Built**: + Track menu |
| Record-arm, one track at a time; arming decides the take type | ✓ | **Built**: "Next take is a" removed |
| Mute / solo (solo overrides mute) | ✓ | **Built** |
| Take lanes, ★ best, use whole take | ✓ | **Built**: collapsible per track |
| Region comping (a different take per section) | ✗ | **Built**: split, then "Comp" swaps a take into the selected clip |
| Clips: move, trim, split, delete | ✗ | **Built**: drag body / drag edges / X / Delete; overlaps are overwritten playlist-style |
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
| Direct monitoring post-gain | ✓ | **Built**: round-trip readout, warns over 25 ms |
| Latency trim + auto-calibrate, stored per device | ✓ | **Built**: 4-click loopback, median onset |
| Monitoring through FX (live reverb in headphones) | ✗ | Not built |

### Mixer
| Feature | In 2.0 spec | MV Booth 2.1 |
|---|---|---|
| Per-track volume (−60…+6) and pan | ✓ | **Built**: header slider plus Mixer strips |
| Per-track meters | ✗ | **Built**: live in the Mixer tab |
| Separate reverb and delay sends per track | ✓ | **Built**: also drive the engine mix |
| Reverb types / tempo-synced delay division | ✓ (1.2–2.8 s) | **Built**: Booth 0.35, Room 0.8, Plate 1.6, Hall 2.6 s; delay 1/4, dotted 1/8 (default), 1/8, 1/16 |
| Master fader + limiter | ✓ | **Built**: live −1 dB limiter; exports use the true-peak mastering chain |
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
| Pitch correction with strength, key/scale, formant keep, vibrato keep | ✓ (WASM or backend) | **Built client-side**: YIN + PSOLA, Off / Natural / Tight / Hard |
| Align doubles to the lead | ✓ (quantize) | **Built**: DTW + WSOLA timing, PSOLA pitch-match |
| Double stage: detune, delay, −6 dB, or use the recorded double | ✓ | **Built**: ±9–11 cents, drifting 19–27 ms, optional octave |
| Breath control | ✓ | **Built** |
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
| Stems (one per track) and raw takes | ✓ | **Built** |
| Lyric import (.txt), `[bar N]` sync, manual advance | ✓ | **Built**: highlighted line follows the playhead; ↓/↑ advance by hand |

## 2. Decisions on the spec's open questions

1. **Client-side or backend?** All client-side. Tune and align run in the browser already, so §7's backend contract is not needed. Keep it only for a future ML denoise or vocal-isolation stage.
2. **Real-time or offline pitch correction?** Offline: record dry, the engine tunes after. A live tuned monitor needs an AudioWorklet pitch shifter; that's a candidate for 2.2.
3. **Who builds it?** Built here, iteratively, in the MV-Booth repo.
4. **Target user?** Personal studio tool (single user, no auth). Multi-artist accounts would add auth, sync and billing scope.

## 3. Data model (as built)

```text
session { id, name, mode, settings{…, stages{tune…master}}, lyrics, markers[{t,name}],
          loop{on,start,end}, master{volumeDb}, beat{id,name,volumeDb,mute,offset},
          tracks[{ id, name, type, color, armed, volumeDb, pan, mute, solo, fx, tune, dbl,
                   revSend, dlySend, showTakes,
                   takes[{ id, name, at, duration, best, transcript }],      // immutable audio
                   clips[{ id, takeId, start, end, shift, gainDb, fadeIn, fadeOut }] }] }
```

A clip plays take audio at source time `t − shift − take.at` for timeline `t` in `[start, end)`. Moving a clip shifts `start`, `end` and `shift` together. Comping swaps `takeId`. Audio lives in IndexedDB under `audio:<takeId>`.

## 4. Verification

The browser test drives the real UI in headless Chromium with a simulated mic. Twenty-four checks pass with zero page errors:
- beat import + BPM detect, arm, ruler loop drag
- loop record with count-in → 3 takes, undo/redo
- pause keeps position, stop returns to start
- split, comp, snapped clip drag
- mixer fader, bar-synced prompter
- stage-off honoured, Automix −14.2 LUFS / −1.0 dBTP, stage states
- WAV 48 kHz/24-bit, MP3 320
- new/switch session, persistence after reload

## 5. Next (2.2 candidates, by value)

1. Live tuned monitoring (AudioWorklet PSOLA).
2. Volume/pan automation lanes you can draw.
3. Punch-out point and pre-roll.
4. Crossfade editor for comp boundaries.
5. Manual EQ/compressor insert per track, overriding the engine.
