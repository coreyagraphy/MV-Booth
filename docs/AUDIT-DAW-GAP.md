# MV Booth: DAW gap audit

Audited at `904a426` (MV Booth 2.7.5), 2026-11-11. No code was changed for this audit.

**How it was tested.** `cd tests && npm test`: lint + 13 browser suites, all green (dsp 11, declick 6, daw 24, punch 9, ux 16, song 12, stems 18, fixes 9, booth 38, package 10, makesong 15, tone 8, single 2). Two extra probes were run for this audit against the real app in headless Chromium (results in section 4). "Test" in the Evidence column means one of those suites exercises the feature; a `file:line` means it was confirmed by reading the code only.

**What could not be tested here.** A real microphone, real headphones, Windows, and the MAONO itself: the suites use a simulated mic. The Studio tune backend was installed on Linux (Python 3.13, CPU) and its suite passes (studio: 8 checks); the Windows install from `setup.bat` cannot be run from here.

Status: **Built** (works, tested) · **Partial** · **Missing** · **Broken**. Impact = how much it changes the sound of Corey's vocal. Effort = S (hours), M (a day or two), L (several days).

## 1. The table

### Recording and session

| Area | Feature | Status | Evidence | Impact | Effort |
|---|---|---|---|---|---|
| Record | Input device selection | Built | `js/app.js:241` (`deviceId: { exact }`); booth suite | High | - |
| Record | Browser processing off (echo cancel, noise suppression, AGC) | Built | `js/app.js:242` all three `false` | High | - |
| Record | 48 kHz honored | Partial | `js/app.js:12`: the app runs at whatever rate the **output** device uses; it does not ask for 48 kHz. If Windows playback is at 44.1 kHz, the mic is resampled to 44.1. Nothing on screen says which rate is in use | Med | S |
| Record | Bit depth | Built | Captured and stored as 32-bit float (`js/app.js:207-224`, `:147`); 24-bit only on export | Low | - |
| Record | Input gain | Built | `js/app.js:250`; daw suite | Med | - |
| Record | Input meter: peak + clip hold | Built | `js/app.js:761`, `:800` (2 s hold); booth suite | Med | - |
| Record | Input meter: RMS / LUFS, and a "good level" target | Missing | Peak only on the input; the LUFS readout is on the output (`js/app.js:57`) | Med | S |
| Record | Mic check (noise floor, level, clipping, room sound before a session) | Missing | No such step | **High** | M |
| Record | Latency compensation + Sync test | Built | `js/app.js:364` (clap test), `:394` (loopback); booth suite | High | - |
| Record | Punch in/out, pre-roll, post-roll | Built | `js/app.js:879`; punch suite (9) | Med | - |
| Record | Loop recording (take per pass) | Built | `js/app.js:638`; daw suite | Med | - |
| Record | Count-in, click | Built | `js/app.js:614-619`; daw suite | Med | - |
| Record | Tempo + BPM detection on a beat | Built | `js/app.js:1042`, `:1135`; daw + stems suites | Med | - |
| Record | Key detection of the **beat** | Missing | Key comes from the vocal only (`js/engine.js:39-45`) | Med | M |
| Session | Takes, take lanes, best-take star | Built | daw suite | Med | - |
| Session | Comping | Partial | Split, then swap a take into a clip (daw suite). No swipe comp | Low | M |
| Session | Playlists | Missing | Take lanes cover the need | Low | - |
| Session | Undo / redo | Built | 50 steps (`js/session.js:162-179`); daw suite | Low | - |
| Session | Save, restore, autosave | Built | IndexedDB, flushed on close (`js/app.js:137-144`); fixes suite | Med | - |
| Session | Crash recovery | Partial | Finished takes are saved at once (`js/app.js:961`). A take **in progress** lives in memory until Stop (`js/app.js:256`), so a crash mid-take loses that take | Med | M |

### Editing

| Area | Feature | Status | Evidence | Impact | Effort |
|---|---|---|---|---|---|
| Edit | Split, trim, move, delete, clip gain | Built | daw suite | Low | - |
| Edit | Fades | Built | `js/session.js:89`; ux suite | Low | - |
| Edit | Crossfades | Partial | Automatic 5 ms edge fades and 10 ms punch crossfades (`js/app.js:875`); no overlap crossfade editor | Low | M |
| Edit | Nudge, snap to grid | Built | `js/app.js:699`, `:2088`, `:2154` | Low | - |
| Edit | Time stretch (user-controlled) | Missing | WSOLA exists only inside double alignment (`js/doubles.js:127`) | Low | M |
| Edit | Align doubles / stacks to the lead | Built | DTW + WSOLA (`js/doubles.js:174`); daw suite | Med | - |
| Edit | Align ad-libs to the beat | Missing | Only a manual per-track nudge | Low | M |
| Edit | Per-note pitch editing (graph mode) | Missing | **Confirmed not built.** Tuning is automatic only (`js/tune.js:319`, `backend/tuner.py`) | Med | L |

### Vocal chain (what Automix does to a vocal today)

Order is fixed: Tune → Align → Double → Clean → Tone → Dynamics → Space → Master (`js/engine.js:8-17`). Each stage can be switched off from the dock; none can be reordered. Decisions are listed in the report after a run.

| Pro chain step | Status | What MV Booth does (evidence) | User can see / change | Impact | Effort |
|---|---|---|---|---|---|
| Gate / expander | Partial | Gaps between phrases turned down a fixed 10 dB (rap) or 18 dB (VO), breaths 7 / 12 dB (`js/automix.js:34-35`, `:308`). Room sound right after a word still counts as "voice" and is not gated | On/off with Clean; depth not adjustable | **High** | S |
| High-pass | Built | 24 dB/oct, corner from the lowest sung note (`js/automix.js:280`, `:403`) | Reported, not adjustable | Med | - |
| Subtractive EQ (mud, box) | Built | Cuts only, at fixed 250 and 500 Hz, depth from the measured spectrum (`js/automix.js:286-287`) | Reported, not adjustable | High | - |
| De-esser | Built | Dynamic cut centred on the measured sibilance (`js/automix.js:316`, `:411`) | Amount slider in the Clean tab | High | - |
| De-noise | Built | Spectral gate, skipped on clean takes (`js/dsp.js:307`) | Amount slider | Med | - |
| De-breath, pop filter, de-click, hum | Built | `js/automix.js:184`, `:406`, `js/dsp.js:691`; song + declick suites | Clean tab | Med | - |
| Pitch correction | Built | In browser: YIN + PSOLA. Backend: CREPE + WORLD, low-confidence regions untouched | Style, key, per track on/off | High | - |
| Compressor 1 (fast, peaks) | Built | One compressor, 4:1, 4 ms attack, threshold from measured dynamic range (`js/automix.js:379`, `:414`) | Reported, not adjustable | High | - |
| Compressor 2 (slow, leveling) | Partial | A ±6 dB volume rider does the leveling (`js/automix.js:293`). **It also turns up the quiet tail of each phrase: see section 4** | Shown on the lane, not adjustable | **High** | S |
| Additive EQ (presence, air) | Built | Fixed 3.2 kHz and 10 kHz, amount measured (`js/automix.js:288-289`) | Reported, not adjustable | High | - |
| Saturation | Partial | 12 % parallel tanh "grit" on rap, fixed (`js/automix.js:428`) | No control | Low | S |
| Doubles | Built | Recorded doubles aligned; generated doubles ±9-11 cents | Per track | Med | - |
| Harmony | Missing | Only an octave-down option | - | Low | M |
| Delay (tempo-synced) + throws | Built | `js/automix.js:574`, `:646` | Division, send | Med | - |
| Reverb | Built | Synthetic plate / room / hall / booth, ducked under the lead (`js/automix.js:335`, `:671`) | Type, send, amount | Med | - |
| Parallel compression | Missing | - | - | Low | S |
| Sidechain: beat ducks for the vocal | Built | Level duck + a presence dip only while the vocal speaks, per stem role (`js/automix.js:678-759`); stems suite | Vocal-vs-beat balance only | High | - |
| Volume rides (automation) | Partial | The rider writes them; they cannot be edited | View only | Med | L |
| Manual EQ / compressor per track | Missing | **Confirmed.** Only FX: Clean / Phone / Wide | - | Med | M |
| Vocal types | Partial | Two chains: Rap and Voice-over (`js/automix.js:30-67`), with roles lead / double / ad-lib / hook. **No sung-lead chain** | Mode switch | Med | M |

### Mixing

| Area | Feature | Status | Evidence | Impact | Effort |
|---|---|---|---|---|---|
| Mix | Tracks, faders, pan, mute, solo, meters | Built | daw + stems suites | Med | - |
| Mix | Reverb and delay sends per track | Built | `js/automix.js:640-645` | Med | - |
| Mix | Beat stems by role | Built | stems suite (18) | Med | - |
| Mix | Buses, groups | Missing | One internal vocal + beat bus | Low | L |
| Mix | Automation lanes | Missing | See volume rides | Low | L |
| Mix | Reference-track compare | Missing | B compares raw vs mix only (`js/app.js:701`) | Med | M |
| Mix | Gain staging | Built | Every vocal levelled to a LUFS target, beat set relative to the lead (`js/automix.js:604`, `:701`) | High | - |

### Mastering

| Area | Feature | Status | Evidence | Impact | Effort |
|---|---|---|---|---|---|
| Master | Loudness targets | Built | −14, −16, −9 via presets and the Target control (`js/app.js:2303-2308`, `:2975`). Not labelled by service (Spotify / Apple / YouTube) | Med | S |
| Master | True-peak limiting | Built | Iterates until ≤ ceiling and within 0.2 LU (`js/automix.js:813-830`); measured in section 4 | High | - |
| Master | Tone, width, ceiling | Built | `js/automix.js:781-808`; song suite | Low | - |
| Master | Glue compression | Built | 1.8:1 (`js/automix.js:774`) | Low | - |
| Master | Multiband compression | Missing | - | Low | M |
| Master | Tonal balance vs a reference | Missing | - | Med | M |
| Master | Self-check and retry | Partial | The master re-measures LUFS and true peak and retries up to 10 times. Nothing checks sibilance, noise floor, room sound or vocal-to-beat level after the render | **High** | M |
| Master | Dither on 16-bit export | Not needed | There is no 16-bit export; WAV is 24-bit (`js/wav.js:2`) | Low | - |

### Export

| Area | Feature | Status | Evidence | Impact | Effort |
|---|---|---|---|---|---|
| Export | WAV 48 / 44.1 kHz, 24-bit | Built | Measured, section 4 | High | - |
| Export | MP3 320 | Built | Measured, section 4 | High | - |
| Export | Stems, raw takes | Built | stems suite; stems are pre-master by design (`js/app.js:1538`) | Low | - |
| Export | `.mvbooth` package | Built | package suite (10) | Low | - |

### Studio tune backend

| Area | Feature | Status | Evidence | Impact | Effort |
|---|---|---|---|---|---|
| Backend | CREPE + WORLD tuning, low-confidence regions untouched | Built | `backend/tuner.py:44`, `:273`; studio suite (8 checks) passes against a live backend (`/health`: torch, torchcrepe, pyworld) | High | - |
| Backend | Honest offline status in the UI | Built | `js/app.js:1379-1391`: shows "offline" with what to run, and disables the button | Med | - |
| Backend | Clean install from `setup.bat` on Windows, Python 3.11 | Unverified | Cannot be run from here. The script picks 3.12 → 3.11 → 3.10 and explains a pyworld build failure (`backend/setup.bat`). Needs one run on Corey's PC | Med | S |
| Backend | Pinned dependencies | Partial | `backend/requirements.txt` uses `>=`, not exact versions, so a future install can pull different code | Low | S |
| Backend | GPU when present | Missing | `setup.bat` installs CPU-only PyTorch | Low | S |

## 2. Top 10 gaps, ranked by how much they improve the sound of the vocal

1. **The Dynamics stage turns up room sound.** Measured: on a take with mild room reflections, the sound right after each phrase comes out 13 dB louder (relative to the voice) than it went in. This matches the "closed chamber, hollow" mixes. Fix: stop the rider boosting decaying tails, add a proper expander after the compressor. Effort S.
2. **No mic check before recording.** Nothing measures the noise floor, level and room sound of the MAONO in the room and says "move closer / turn the gain down" before a take is wasted. Effort M.
3. **Self-check after the render covers only loudness and peak.** Sibilance, noise floor, room sound and vocal-to-beat level in 1-4 kHz are never re-measured, so a bad mix ships with a green status. Effort M.
4. **No sung-lead chain.** Singing gets the rap chain (fast 4:1 compression, grit, short plate). Effort M.
5. **Chain settings are visible but not editable.** EQ points, compressor and gate cannot be overridden when the engine guesses wrong. Effort M.
6. **EQ uses fixed frequencies.** Mud, box, presence and air are always 250 / 500 / 3200 / 10000 Hz; the real problem frequency of this voice and this beat is not searched for. Effort M.
7. **Stronger de-noise / de-reverb.** The spectral gate handles steady hiss; it cannot remove room reflections or changing noise. A local model (DeepFilterNet class) is the candidate; unproven until tested on a real take. Effort L.
8. **No way to save a mix Corey likes as his own preset.** The six presets are fixed; only the voice spectrum is learned. Effort S.
9. **No reference-track compare / tonal match.** Effort M.
10. **Per-note pitch editor.** Automatic tuning is right most of the time; when it is wrong there is no way to fix one note. Effort L.

Lower value for the vocal's sound (DAW polish): buses, automation lanes, crossfade editor, swipe comping, time stretch, multiband mastering.

## 3. What works well and must not be touched

- Recording path: browser processing off, sample-accurate latency compensation, Sync test, punch with crossfades, loop takes.
- Takes are immutable; every process makes a new take; undo covers every edit.
- Loudness and true-peak measurement and the mastering loop (verified to target on every export format).
- Beat stems by role, with ducking only while the vocal is present.
- Cut-only low-mid EQ and no air cut on rap (the 2.7.3 / 2.7.4 fixes, guarded by the tone suite).
- Double alignment (DTW + WSOLA) and the single-recorded-double placement.
- Session storage, `.mvbooth` package, update notice, single-file build.

## 4. Measurements made for this audit

**Room sound through the chain.** Test vocal convolved with a small-room response (RT60 0.45 s), no beat, tuning and doubles off. Number = level in the 150 ms after each phrase ends, relative to the phrase (higher = roomier).

| Take | Raw | Mix, all stages | Mix, Space off | Mix, Space + Dynamics off |
|---|---|---|---|---|
| Dry | −36.3 dB | −27.3 | −29.6 | −37.9 |
| Mild room (reflections 14 dB under the voice) | −27.8 | −14.4 | −14.5 | −24.1 |
| Roomy (8 dB under) | −23.3 | −10.0 | −10.1 | −19.4 |

Reading: reverb (Space) adds almost nothing. The Dynamics stage adds about 9 dB on its own, and about 13 dB in total over the raw take. Cause in code: a frame of decaying room sound still counts as "active", so the rider turns it **up** by as much as 6 dB (`js/automix.js:303`), and the compressor's release adds the rest. Limit of this test: the vocal and the room are synthetic. A raw take from the MAONO is needed to confirm the size of the effect on Corey's recordings.

**Exports.** One master, exported four ways, decoded and re-measured.

| Export | Sample rate / bits | Integrated loudness | True peak |
|---|---|---|---|
| WAV 48 kHz | 48000 / 24 | −14.26 LUFS | −1.06 dBTP |
| MP3 48 kHz | 320 kbps | −14.28 | −1.05 |
| WAV 44.1 kHz | 44100 / 24 | −14.00 | −1.05 |
| MP3 44.1 kHz | 320 kbps | −14.04 | −1.03 |

All on target (−14) and under the −1 dBTP ceiling.

## 5. Broken

Nothing is broken in the sense of failing or crashing: every suite passes with zero page errors. One thing behaves wrongly for the sound: gap 1 above (Dynamics raises room sound). One thing is unverified rather than broken: the backend install on Windows from `setup.bat`.
