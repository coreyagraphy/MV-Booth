# MV Booth

Mental Vision vocal engine. Record voice-overs and rap vocals; the engine tunes, lines up doubles, generates extra doubles, mixes and masters. Everything runs on your machine: no uploads, no accounts, no subscriptions.

## Install on your PC (one time)

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org/en/download) if you don't have it.
2. Put the `mv-booth` folder somewhere permanent, e.g. `Documents\mv-booth`. The shortcut points at this folder, so don't move it afterwards.
3. Double-click **`INSTALL.bat`**. It creates an **MV Booth** shortcut on your Desktop and in the Start menu, with the app icon.
4. Launch **MV Booth**. It opens as its own app window (Edge or Chrome app mode), with no browser tabs or address bar. Pin it to the taskbar from the Start menu.

The shortcut starts a tiny local engine silently. It shuts itself down about two minutes after you close the window. `start.bat` is the manual alternative, with a console window.

Wear headphones while recording so the beat doesn't bleed into the mic.

## Studio tuning backend (optional, best-quality tuning)

A small local Python service does offline pitch correction with **CREPE** (pitch tracking) and the **WORLD** vocoder (formant-preserving resynthesis). It runs only on your PC (`127.0.0.1:8765`), with no cloud and no login.

1. Install **Python 3.11** from python.org (tick "Add to PATH").
2. Double-click **`backend\setup.bat`** once. It installs CPU-only torch, CREPE, pyworld, FastAPI.
   - If pyworld fails to build: install "Desktop development with C++" from the Visual C++ Build Tools and rerun, or `conda install -c conda-forge pyworld`.
3. From then on the **MV Booth** shortcut starts the backend silently with the app. (`backend\start-backend.bat` runs it with a console if you want to watch it.)

In the **Tune** tab, *Studio tune* shows a green dot when the backend is online. Select a take, set retune speed (0 = robot hard-tune), vibrato keep, amount, confidence threshold and formant preserve, then click **Studio-tune selected take**. The result arrives as a new take ("Take 1 · tuned") and replaces the original on the track; the original stays in the take lane, untouched. The report lists every sung region with its confidence. Regions below the threshold are left exactly as recorded. On the take lane, teal marks tuned regions and red marks skipped ones.

## Make a whole song (Song tab)

The **Song** tab is a start-to-finish checklist that ticks itself off as you go and highlights the next step: **Beat → Song sections → Record → Comp → Clean → Tune → Doubles & ad-libs → Mix → Master → Export**. Each step has buttons that do it (import the beat, drop Intro/Verse/Hook markers, add and arm a lead, open Clean, Automix, export WAV/MP3).

## Vocal cleanup (Clean tab)

Per track, applied every time you Automix:

| Control | What it fixes |
| --- | --- |
| **De-noise** | Steady background: fan, AC, hiss, room tone. Higher = cleaner; too high sounds underwater. |
| **Breaths** | Keep / Reduce / Remove the air between lines. |
| **De-esser** | Harsh S, SH, T, Z. Too high sounds lispy. |
| **Pop filter** | The low thump of P and B hitting the mic; only those moments are filtered. |
| **De-click** | Mouth clicks and lip smacks, repaired by least-squares prediction from the audio on both sides. Anything it can't repair cleanly is left untouched. |
| **Hum** | 50 Hz (EU) or 60 Hz (US) electrical hum plus 3 harmonics. |

**Preview: make a cleaned take** renders just the cleanup on the selected take and drops it on the track as "Take 1 · clean" (level-matched), with the raw take kept in the lane to compare. Undo puts the raw take back. **Use on all vocal tracks** copies the settings.

The **Mixer → Master** section sets the final polish Automix applies: **Tone** (neutral / warm / bright / dark), **Width** (0–150 %), **Ceiling** (−0.3, −1 or −2 dBTP).

## Beat stems

Import one beat file, or the stems (track-outs) all at once. Automix keeps the producer's balance between the stems, sets the whole beat bus against your vocal, then treats each stem by its role:

| Role | What Automix does |
| --- | --- |
| **Drums** | Light presence dip, never ducked: the groove keeps its punch. |
| **808 / Bass** | Folded to mono, centred, 25 Hz rumble cut, never ducked. |
| **Melody** | Carved where it crowds your voice and ducked a little deeper while you rap. |
| **FX / Other** | Ducked hardest while you speak. |
| **Full beat** | A two-track beat: carved and ducked as one. |

Tempo is detected from the drums stem. **Export → Stems** writes one file per vocal track and one per beat stem. Sessions from before 2.5 open with their beat as a single "Full beat" stem.

## Session flow (DAW basics)

New to it? Click **? Guide** in the top bar (or press `?`) for a plain-language walkthrough of the tools, mixer, presets and tuning. While you record, a red **RECORDING** bar shows the take time and your input level, and your waveform draws in red on the track.


| Step | How |
| --- | --- |
| Beat | Drag an instrumental onto the timeline, or **Booth → Import beat / stems**. Tempo is detected; **Tap** (T) or type it to override. |
| Beat stems | Got the track-outs? Select or drag all of them at once (drums, 808, keys…). Each stem gets its own lane, fader, pan, mute and solo, and a **role** (Full beat / Drums / 808 / Bass / Melody / FX) guessed from the file name: check it in the lane's drop-down. |
| Tracks | **+ Track** → Lead / Double / Ad-lib / Hook. Click the red dot to arm (one at a time). |
| Record | Set **Count-in**, switch **Click** on if you want it (C), press **R**. |
| Loop record | Drag across the ruler to set a loop and press **L**, then record: every pass becomes a take. |
| Comp | Open the take lanes (the `3 ▾` chip), split at the playhead (**X**), select a clip, click **Comp** on the take you want for that section. **★** marks the best take. |
| Punch-in | Shift-drag on the ruler (or select, then **Punch ← selection**), press **P**, arm a track, press **R**. Playback starts 1–2 bars early (pre-roll), recording runs exactly from punch-in to punch-out, playback continues one bar (post-roll), and it stops itself. The punch lands as a new take with 10 ms crossfades at both edges. |
| Edit tools | Pick a tool in the toolbar (or keys **1–4**): **✥ Move** drags clips, **⇤ Trim** drags clip ends, **✂ Cut** splits where you click, **◢ Fade** drags fade-ins/outs. The hint line under the toolbar always says what the current tool does, and explains anything you hover. |
| Mix | Header sliders or the **Mixer** tab: volume, pan, reverb and delay sends, meters, master fader. Mix direction sets loudness target, reverb type, delay division. |
| Automix | Runs the 8-stage engine. Click a stage in the dock to switch it off. **Cancel** stops it safely. |
| Compare | **B** flips between your rough mix and the engine mix. |
| Export | **Export ▾** (E): master WAV (48/44.1 kHz, 24-bit), MP3 320 kbps, stems, raw takes. |
| Sessions | Session name (top left): new, rename, duplicate, delete to trash (restorable for 30 days). Autosaves constantly. |

### Keyboard
`Space` play / pause / pick up where you paused (works even right after clicking a button) · `Enter` stop (back to start point) · `Home` return to zero · `R` record · `L` loop · `P` punch · `C` click · `T` tap tempo · `X` split · `Delete` delete clip · `M` marker · `B` raw/mix · `E` export · `←/→` nudge a beat (Shift = bar) · `+/−` zoom · `F` fit · `Ctrl+Z` undo · `Ctrl+Shift+Z` redo · `Ctrl+S` save · `1–4` tools · `?` guide. While recording with the prompter open: `↓/↑` move the lyric line.

**Lyrics:** start a line with `[bar 5]` and the prompter highlights it when the playhead reaches bar 5.

## The engine

**Tune → Align → Double → Clean → Tone → Dynamics → Space → Master**

- **Tune:** YIN pitch tracking, automatic key detection, note snapping with retune speed. PSOLA shifting keeps your formants, so you still sound like you. *Hard* is the robotic effect.
- **Align:** recorded doubles and hook stacks are time-warped onto the lead (DTW + WSOLA) and pitch-matched to the lead, like VocAlign.
- **Double:** studio-style AI doubles from the lead: a detuned, drifting L/R pair, plus an optional octave-down layer.
- **Clean:** de-click, hum notches, noise reduction, breath keep/reduce/remove, plosive pop filter, gap gating (all set per track in the Clean tab).
- **Tone:** low cut from your pitch, EQ matched to a target vocal curve, dynamic de-esser (harder on doubles).
- **Dynamics:** vocal rider automation, compression, parallel grit in rap mode, phone FX.
- **Space:** role-based level balance, beat stems handled by role (drums keep punch, 808 mono, melody carved and ducked) only while the vocal plays, tempo-synced delay with throws on phrase endings, plate/room with ducking, Haas widening.
- **Master:** tone tilt, stereo width, bus glue, loudness to target (−14 streaming, −9 club, −16 VO, −23 broadcast), look-ahead limiter iterated until true peak is at or below the ceiling you pick (default −1 dBTP, 4× oversampled).

The **Engine** tab logs every decision with its numbers, plus what the engine has learned about your voice. `docs/SPEC-v2.md` maps every standard DAW feature to what is built.

### About "training"

No neural network is downloaded, and nothing leaves your PC. The engine uses the same proven signal-processing methods behind classic pitch-correction and alignment tools (YIN, PSOLA, DTW, WSOLA, BS.1770 loudness). It learns from you: after every mix it saves a profile of your voice (tone, pitch range, sibilance, key) and your preferred settings, and short or noisy takes lean on that profile. See `REA.md` for the reverse-engineering ledger.

## Tests

`cd tests && npm install && npm test` runs lint and every browser suite against a private port (your sessions are never touched). See `tests/README.md`.

## Latency, storage, Netlify

- **Latency:** takes are shifted by the reported device latency. If your vocal still lands late or early, nudge **Latency trim** (positive pulls takes earlier).
- **Storage:** takes, the beat and lyrics live in the app's local storage, so they survive restarts. Export anything you want to keep.
- **Offline:** after the first launch the app shell is cached and keeps working offline.
- **Netlify:** **https://mv-booth.netlify.app** (password-protected). Netlify rebuilds on every push to `main`; `build.mjs` publishes only the app, not the installers. To install it as an app with no Node.js: open the link in Edge or Chrome, enter the site password once, then click **Install** in the address bar.
