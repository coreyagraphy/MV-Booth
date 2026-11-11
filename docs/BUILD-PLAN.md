# MV Booth build plan

Follows `docs/AUDIT-DAW-GAP.md` and `docs/AUTO-ENGINEER-DESIGN.md`. Each phase ends with something Corey can record and hear. A phase is finished only when its tests pass and its measurements are written down. Work happens on a branch; nothing goes to `main` (the live site) until Corey says so.

The order differs from the brief in one place: the audit found that the Dynamics stage raises room sound, which is the "hollow chamber" complaint, so that fix comes first.

| Phase | What ships | Why now | Size |
|---|---|---|---|
| 1 | Room-sound fix + mic check | Biggest audible gain; smallest change | S-M |
| 2 | Visible, editable vocal chain | Needed before the engine can be overridden | M |
| 3 | Auto Engineer v1 | The main goal | L |
| 4 | Stronger local de-noise | Only if a model wins on a real take | L |
| 5 | Per-note pitch editor | Fixes the notes automatic tuning gets wrong | L |
| 6 | DAW polish | Only items that help the vocal | per item |

## Phase 1: room-sound fix, mic check, honest setup

**Status: built in 2.8 on branch `claude/phase-1-room-fix`, tests green. Not yet confirmed on a real MAONO take or by ear; not deployed.**

Build:
- Rider never boosts a decaying phrase tail; a downward expander after the compressor; gate depth set from the measured room sound.
- **Mic check** (Booth tab): 10 seconds of silence then one spoken line. Reports noise floor, level, clipping, room sound, and the sample rate in use, with one plain instruction each ("move 2 inches closer", "turn gain down 6 dB", "Windows playback is at 44.1 kHz: set it to 48").
- Request 48 kHz for the audio engine; show the real rate.
- Pin `backend/requirements.txt`; Studio tune status unchanged (already honest).

Tests: a regression test with the audit's roomy fixture: room tail after phrases may rise no more than 3 dB over the raw take (today: 13 dB). Mic check verdicts on quiet / noisy / clipped / roomy fixtures. Existing suites stay green.

Measure: tail-to-voice before vs after, LUFS, true peak.

Needs Corey: one 20-second raw take from the MAONO (Export → Raw takes · WAV) to confirm the fix on his room, and one run of `backend\setup.bat` on his PC.

## Phase 2: visible, editable chain

Build: `js/chains.js` (chain as data, five types); `renderVocal` reads a chain; the "What I did and why" panel with on/off, a control per step, lock and reset; manual EQ points and compressor settings per track; limited reorder.

Tests: a chain with every step off returns the take unchanged (bit-identical apart from level); each override changes the render as stated; locks survive a re-run; undo works on every change.

## Phase 3: Auto Engineer v1

Build: new measurements (resonances, room sound, beat key, vocal pocket); sung-lead, ad-lib and harmony chains; self-check with up to 3 passes and a pass log; named loudness targets; Save as my preset; taste profile.

Tests: fixed test vocal + beat with assertions on LUFS (±0.3), true peak (≤ ceiling), sibilance, noise floor, room tail and vocal-to-beat ratio; a deliberately harsh take must trigger a second pass and pass afterwards; a take that cannot be fixed must report the failure in words.

## Phase 4: stronger de-noise (conditional)

Test DeepFilterNet and RNNoise on Corey's raw takes against the current gate. Adopt only a winner (see the design's test). If adopted: backend endpoint, result returned as a new take, licence recorded in `REA.md`, pinned in `requirements.txt`, CPU works and GPU is used when present. If nothing wins, the phase closes with the measurements and no code.

## Phase 5: per-note pitch editor

Graph view of the detected notes on a track; drag a note up or down, bypass a note, reset. Uses the backend (WORLD) for resynthesis; result is a new take. Tests: an untouched note stays bit-identical; a moved note lands within 5 cents.

## Phase 6: polish, only if it helps the vocal

Candidates from the audit, each decided separately: reference-track compare and tonal match, crash-safe recording (write the take to disk while recording), editable volume rides, crossfade editor. Not planned: user buses, multiband mastering, swipe comping, time stretch.

## After every phase

Report: files changed; before / after measurements (LUFS, true peak, noise floor, sibilance, room tail); test results; what is next; anything needed from Corey. Update `docs/SPEC-v2.md` and `REA.md`.
