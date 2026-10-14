# MV Booth

Mental Vision vocal engine. Record voice-overs and rap vocals; the engine tunes, lines up doubles, generates extra doubles, mixes and masters. Everything runs on your machine: no uploads, no accounts, no subscriptions.

## Install on your PC (one time)

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org/en/download) if you don't have it.
2. Put the `mv-booth` folder somewhere permanent, e.g. `Documents\mv-booth`. The shortcut points at this folder, so don't move it afterwards.
3. Double-click **`INSTALL.bat`**. It creates an **MV Booth** shortcut on your Desktop and in the Start menu, with the app icon.
4. Launch **MV Booth**. It opens as its own app window (Edge or Chrome app mode), with no browser tabs or address bar. Pin it to the taskbar from the Start menu.

The shortcut starts a tiny local engine silently. It shuts itself down about two minutes after you close the window. `start.bat` is the manual alternative, with a console window.

Wear headphones while recording so the beat doesn't bleed into the mic.

## Session flow

| Step | What you do | Keys |
| --- | --- | --- |
| Beat | Drag an instrumental onto the timeline, or **Import beat**. Tempo is detected. | |
| Mic | **Enable mic**, pick your interface. | |
| Role | **Next take is a** Lead / Double / Ad-lib / Hook stack. | |
| Record | Each take lands on its own lane at the playhead. | `R` |
| Lane chips | **TUNE** on/off · **DBL → 2X → 2X+8** AI doubles (leads) · FX Clean / Phone / Wide · M / S | |
| Tune tab | Correction Off / Natural / Tight / Hard, key (auto or set) and scale, double alignment and tightness, pitch view | |
| Automix | Runs the 8-stage engine; the dock lights each stage. | |
| Compare | Instant switch between raw takes and the mix. | `B` |
| Export | Master WAV (24-bit), stems, raw takes. | |

`Space` plays and stops (and ends a take). `Home` returns to the start.

## The engine

**Tune → Align → Double → Clean → Tone → Dynamics → Space → Master**

- **Tune:** YIN pitch tracking, automatic key detection, note snapping with retune speed. PSOLA shifting keeps your formants, so you still sound like you. *Hard* is the robotic effect.
- **Align:** recorded doubles and hook stacks are time-warped onto the lead (DTW + WSOLA) and pitch-matched to the lead, like VocAlign.
- **Double:** studio-style AI doubles from the lead: a detuned, drifting L/R pair, plus an optional octave-down layer.
- **Clean:** noise reduction, breath taming, plosive pop filter, gap gating.
- **Tone:** low cut from your pitch, EQ matched to a target vocal curve, dynamic de-esser (harder on doubles).
- **Dynamics:** vocal rider automation, compression, parallel grit in rap mode, phone FX.
- **Space:** role-based level balance, the beat carved under the vocal only while it plays, tempo-synced delay with throws on phrase endings, plate/room with ducking, Haas widening.
- **Master:** bus glue, loudness to target (−14 streaming, −10 loud, −16 VO, −23 broadcast), look-ahead limiter at −1 dBFS.

The **Engine** tab logs every decision with its numbers, plus what the engine has learned about your voice.

### About "training"

No neural network is downloaded, and nothing leaves your PC. The engine uses the same proven signal-processing methods behind classic pitch-correction and alignment tools (YIN, PSOLA, DTW, WSOLA, BS.1770 loudness). It learns from you: after every mix it saves a profile of your voice (tone, pitch range, sibilance, key) and your preferred settings, and short or noisy takes lean on that profile. See `REA.md` for the reverse-engineering ledger.

## Latency, storage, Netlify

- **Latency:** takes are shifted by the reported device latency. If your vocal still lands late or early, nudge **Latency trim** (positive pulls takes earlier).
- **Storage:** takes, the beat and lyrics live in the app's local storage, so they survive restarts. Export anything you want to keep.
- **Offline:** after the first launch the app shell is cached and keeps working offline.
- **Netlify:** **https://mv-booth.netlify.app** (password-protected). Netlify rebuilds on every push to `main`; `build.mjs` publishes only the app, not the installers. To install it as an app with no Node.js: open the link in Edge or Chrome, enter the site password once, then click **Install** in the address bar.
