# MV Booth

Mental Vision vocal engine. Record voice-overs and rap vocals; the engine tunes, lines up doubles, generates extra doubles, mixes and masters. Everything runs on your machine: no uploads, no accounts, no subscriptions.

## Install on your PC (one time)

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org/en/download) if you don't have it.
2. Put the `mv-booth` folder somewhere permanent, e.g. `Documents\mv-booth`. The shortcut points at this folder, so don't move it afterwards.
3. Double-click **`INSTALL.bat`**. It creates an **MV Booth** shortcut on your Desktop and in the Start menu, with the app icon.
4. Launch **MV Booth**. It opens as its own app window (Edge or Chrome app mode), with no browser tabs or address bar. Pin it to the taskbar from the Start menu.

The shortcut starts a tiny local engine silently. It shuts itself down about two minutes after you close the window. `start.bat` is the manual alternative, with a console window.

Wear headphones while recording so the beat doesn't bleed into the mic.

## Session flow (DAW basics)

| Step | How |
| --- | --- |
| Beat | Drag an instrumental onto the timeline, or **Booth → Import beat**. Tempo is detected; **Tap** (T) or type it to override. |
| Tracks | **+ Track** → Lead / Double / Ad-lib / Hook. Click the red dot to arm (one at a time). |
| Record | Set **Count-in**, switch **Click** on if you want it (C), press **R**. |
| Loop record | Drag across the ruler to set a loop and press **L**, then record: every pass becomes a take. |
| Comp | Open the take lanes (the `3 ▾` chip), split at the playhead (**X**), select a clip, click **Comp** on the take you want for that section. **★** marks the best take. |
| Edit | Drag clips to move (snaps to 1/16; hold Alt to bypass), drag edges to trim, drag the top corners for fades. The clip inspector sets gain and fade times. |
| Mix | Header sliders or the **Mixer** tab: volume, pan, reverb and delay sends, meters, master fader. Mix direction sets loudness target, reverb type, delay division. |
| Automix | Runs the 8-stage engine. Click a stage in the dock to switch it off. **Cancel** stops it safely. |
| Compare | **B** flips between your rough mix and the engine mix. |
| Export | **Export ▾** (E): master WAV (48/44.1 kHz, 24-bit), MP3 320 kbps, stems, raw takes. |
| Sessions | Session name (top left): new, rename, duplicate, delete to trash (restorable for 30 days). Autosaves constantly. |

### Keyboard
`Space` play/pause · `Enter` stop (back to start point) · `Home` return to zero · `R` record · `L` loop · `C` click · `T` tap tempo · `X` split · `Delete` delete clip · `M` marker · `B` raw/mix · `E` export · `←/→` nudge a beat (Shift = bar) · `+/−` zoom · `F` fit · `Ctrl+Z` undo · `Ctrl+Shift+Z` redo · `Ctrl+S` save. While recording with the prompter open: `↓/↑` move the lyric line.

**Lyrics:** start a line with `[bar 5]` and the prompter highlights it when the playhead reaches bar 5.

## The engine

**Tune → Align → Double → Clean → Tone → Dynamics → Space → Master**

- **Tune:** YIN pitch tracking, automatic key detection, note snapping with retune speed. PSOLA shifting keeps your formants, so you still sound like you. *Hard* is the robotic effect.
- **Align:** recorded doubles and hook stacks are time-warped onto the lead (DTW + WSOLA) and pitch-matched to the lead, like VocAlign.
- **Double:** studio-style AI doubles from the lead: a detuned, drifting L/R pair, plus an optional octave-down layer.
- **Clean:** noise reduction, breath taming, plosive pop filter, gap gating.
- **Tone:** low cut from your pitch, EQ matched to a target vocal curve, dynamic de-esser (harder on doubles).
- **Dynamics:** vocal rider automation, compression, parallel grit in rap mode, phone FX.
- **Space:** role-based level balance, the beat carved under the vocal only while it plays, tempo-synced delay with throws on phrase endings, plate/room with ducking, Haas widening.
- **Master:** bus glue, loudness to target (−14 streaming, −9 club, −16 VO, −23 broadcast), look-ahead limiter iterated until true peak ≤ −1 dBTP (4× oversampled).

The **Engine** tab logs every decision with its numbers, plus what the engine has learned about your voice. `docs/SPEC-v2.md` maps every standard DAW feature to what is built.

### About "training"

No neural network is downloaded, and nothing leaves your PC. The engine uses the same proven signal-processing methods behind classic pitch-correction and alignment tools (YIN, PSOLA, DTW, WSOLA, BS.1770 loudness). It learns from you: after every mix it saves a profile of your voice (tone, pitch range, sibilance, key) and your preferred settings, and short or noisy takes lean on that profile. See `REA.md` for the reverse-engineering ledger.

## Latency, storage, Netlify

- **Latency:** takes are shifted by the reported device latency. If your vocal still lands late or early, nudge **Latency trim** (positive pulls takes earlier).
- **Storage:** takes, the beat and lyrics live in the app's local storage, so they survive restarts. Export anything you want to keep.
- **Offline:** after the first launch the app shell is cached and keeps working offline.
- **Netlify:** **https://mv-booth.netlify.app** (password-protected). Netlify rebuilds on every push to `main`; `build.mjs` publishes only the app, not the installers. To install it as an app with no Node.js: open the link in Edge or Chrome, enter the site password once, then click **Install** in the address bar.
