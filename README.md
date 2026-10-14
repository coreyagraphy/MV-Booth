# MV Booth

Private vocal booth for voice-overs and rap vocals. You record, it does the engineering. Everything runs in your browser on your own machine: no uploads, no accounts, no subscriptions.

## Run it

1. Install [Node.js](https://nodejs.org) (any version from 18 up).
2. **Windows:** double-click `start.bat`. **Mac/Linux:** run `./start.sh`.
3. The booth opens at `http://localhost:5177`. Use Chrome or Edge.

Wear headphones while recording, or the beat bleeds into the mic.

## Session flow

| Step | What you do | Keys |
| --- | --- | --- |
| Beat | Drag an instrumental onto the timeline, or **Import beat**. Tempo is auto-detected. Skip this for a dry voice-over. | |
| Mic | **Enable mic** and pick your interface. | |
| Role | Set **Next take is a** to Lead / Double / Ad-lib / Hook stack. | |
| Record | Each take becomes its own lane, starting from the playhead. Click the ruler or a lane to move the playhead. | `R` |
| Lyrics | Write in the **Lyrics** tab. The gutter counts syllables per line, and the prompter scrolls them while you record. | |
| Automix | Mode **Rap** or **Voice-over**, then **Automix**. | |
| Compare | Switch instantly between raw takes and the mix. | `B` |
| Export | Master WAV (24-bit), stems, or raw takes. | |

`Space` plays and stops, and stops a take while recording. `Home` returns to the start.

## What the engine does (reverse-engineered feature map)

| Source tool | Feature | MV Booth implementation |
| --- | --- | --- |
| LUNA 3 / Noiseworks VoiceAssist | Auto volume riding | K-weighted short-term loudness → gain automation (±6 dB rap, ±8 dB VO), drawn on the lane as the orange line |
| | Sibilance control | Per-frame 4.5–10.5 kHz energy ratio → automated dynamic EQ at the voice's own sibilance centre (red ticks on the lane) |
| | Breath + noise reduction | Spectral-gating denoiser (noise profile learned from the quietest frames) + breath detection by spectral flatness → −7/−12 dB |
| Nectar 4 Vocal Assistant | Voice-matched EQ | Measures F0 for the low cut, then compares the long-term spectrum against a target vocal curve and corrects mud/box/presence/air |
| | Auto Level + compression | Gain-staged to −20 dBFS, threshold set from the take's dynamic range, 4:1 rap / 3:1 VO, parallel saturation for rap grit |
| RoEx Automix | Level balance | Every lane loudness-matched by role (doubles −7 LU, ad-libs −5, beat −1 LU under the lead) |
| | Frequency unmasking | Finds where the beat crowds the vocal's presence band and dips it there only while the vocal is active, plus a light duck |
| | Master | Bus glue → loudness normalisation to target → look-ahead brickwall limiter at −1 dBFS, then measured again |
| Moises (in LUNA) | Lyric transcription | Optional live transcription per take (Chrome's speech service, so it sends audio to Google; off by default) |

The Engine tab logs every decision with its numbers so you can see why the mix sounds the way it does. **Vocal vs beat**, **Space** and **Loudness target** let you steer it; run Automix again after changing them.

## Latency

Takes are shifted automatically by the browser's reported input and output latency. If your vocal still lands late or early against the beat, adjust **Latency trim** in the Booth tab. Positive values pull takes earlier.

## Storage

Takes, the beat and your lyrics are saved in the browser's local storage (IndexedDB) for `localhost:5177`, so they survive a refresh. Clearing site data deletes them. Export anything you want to keep.

## Netlify (optional)

You don't need Netlify; the local version does everything. If you want the booth on other devices, create a Netlify site from this repo with no build command. `netlify.toml` handles the rest, including a `noindex` header. Audio still never leaves the browser.
