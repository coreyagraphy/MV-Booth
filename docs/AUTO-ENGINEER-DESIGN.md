# Auto Engineer: design

Status: design only. Nothing in this document is built yet. It follows `docs/AUDIT-DAW-GAP.md`.

## What it is

One button that analyses the takes and the beat, builds a vocal chain, mixes, masters, checks its own result, and shows every decision so Corey can change it. It replaces today's Automix internals; **Make my song** and **B** (raw vs mix) keep working the same way.

It is an evolution of the current engine, not a rewrite. Today the engine already measures the voice and sets most parameters from those measurements. What changes:

| Today | Auto Engineer |
|---|---|
| Decisions are made inside the render code and only printed afterwards | Decisions become a **chain object** (JSON) that is built first, shown, editable, then rendered |
| Two chains (Rap, Voice-over) | Five: Rap lead, Rap ad-lib, Sung lead, Harmony / double, Voice-over / podcast |
| Fixed EQ frequencies | EQ frequencies searched for in the voice and against the beat |
| Self-check covers loudness and true peak | Self-check also covers sibilance, noise floor, room sound and vocal-to-beat level, and retries |
| Six fixed presets | Plus "Save as my preset" and a taste profile that learns from Corey's overrides |

## Pipeline

```text
analyse takes ─┐
               ├─> build chain (JSON) ─> render ─> measure result ─> pass? ─> done
analyse beat ──┘         ^                                │ no (max 3 passes)
                         └──────── adjust chain ──────────┘
```

### 1. Analysis

Per take (most of this exists in `analyseVocal`, `js/automix.js:91`):

| Measurement | Exists | Used for |
|---|---|---|
| Noise floor, SNR | yes | De-noise amount, gate floor |
| Sibilance centre and strength | yes | De-esser frequency and depth |
| Plosives, breaths, clicks | yes | Pop filter, breath level, de-click |
| Dynamic range, active level | yes | Compressor threshold, rider range |
| Pitch range, key, pitch stability | partly (no stability score) | High-pass corner, tune strength, sung vs rap suggestion |
| Band spectrum | yes (8 bands) | Tone EQ |
| Resonances (narrow peaks, 1/6 octave) | **new** | Where to cut mud / box / harshness instead of fixed 250 / 500 Hz |
| Room sound (decay after phrase ends) | **new** | Expander depth, de-reverb on/off, mic-position advice |

Per beat: BPM (exists), loudness (exists), band spectrum (exists), **key (new)**, **vocal pocket (new)**: the 1-4 kHz band where the beat is densest while the vocal is present.

### 2. Chain as data

A chain is a list of steps with plain names. Example (values are filled in by the analysis):

```json
{
  "type": "rap-lead",
  "steps": [
    { "id": "lowcut",   "name": "Low cut",        "hz": 92,  "why": "lowest note is 128 Hz" },
    { "id": "denoise",  "name": "De-noise",       "amount": 0.4, "why": "noise floor 38 dB under the voice" },
    { "id": "expander", "name": "Room control",   "depthDb": 9, "why": "room tail 24 dB under the voice" },
    { "id": "cut",      "name": "Cut boxiness",   "hz": 310, "db": -3, "q": 2.0, "why": "peak at 310 Hz, also where the beat's bass sits" },
    { "id": "deess",    "name": "De-ess",         "hz": 6800, "maxDb": 7 },
    { "id": "comp",     "name": "Peak compressor","ratio": 4, "thresholdDb": -24, "attackMs": 4, "releaseMs": 80 },
    { "id": "level",    "name": "Level rider",    "rangeDb": 4 },
    { "id": "boost",    "name": "Presence",       "hz": 3400, "db": 2 },
    { "id": "air",      "name": "Air",            "hz": 10000, "db": 1.5 },
    { "id": "grit",     "name": "Saturation",     "amount": 0.12 },
    { "id": "reverb",   "name": "Plate reverb",   "seconds": 1.1, "sendDb": -17 },
    { "id": "delay",    "name": "Echo",           "division": "1/8.", "sendDb": -24 }
  ]
}
```

Each step carries `on`, its values, `why` (the sentence shown in the panel), and `locked` (true once Corey has changed it, so a re-run keeps his value). The five chain types are five templates of this shape in one new module, `js/chains.js`; `renderVocal` is changed to read a chain instead of deciding internally. Step order is editable within what makes sense (EQ and compressor can swap; the limiter stays last).

Differences between types, in short:

| Type | Compression | Rider | Tuning default | Space |
|---|---|---|---|---|
| Rap lead | 4:1 fast | ±4 dB | natural | short plate, dotted echo throws |
| Rap ad-lib | 4:1 fast | ±6 dB | natural | more reverb and echo, panned |
| Sung lead | 2.5:1 slower attack, then a second slow leveler | ±3 dB | natural, vibrato kept | longer plate, quarter echo |
| Harmony / double | 4:1, stronger de-ess | ±6 dB | tight to the lead | less direct, more reverb |
| Voice-over / podcast | 3:1 | ±8 dB | off | almost dry |

### 3. Mixing against the beat

Kept from today: vocal levelled to a LUFS target, beat set relative to it, per-stem ducking and presence dip while the vocal is present. New: the dip is placed at the measured vocal pocket and sized by the measured vocal-to-beat ratio in 1-4 kHz, instead of the current rule of thumb.

### 4. Mastering

Kept: loudness normalise, true-peak limiter, iterate to target. Targets get plain names: **Streaming −14**, **YouTube −14**, **Apple / podcast −16**, **Loud −9**. The panel always shows the integrated LUFS and true peak that were actually hit.

### 5. Self-check and retry

After each render, measure and compare:

| Check | Pass when | If it fails |
|---|---|---|
| Integrated loudness | within 0.3 LU of target | (existing loop) |
| True peak | ≤ ceiling | (existing loop) |
| Sibilance (4.5-10 kHz in S frames vs voiced frames) | not more than +3 dB over the voice's own profile | de-ess depth +2 dB |
| Noise floor in gaps | ≥ 45 dB under the vocal | expander depth +3 dB |
| Room sound (tail after phrase ends) | not raised more than 3 dB over the raw take | rider range −2 dB, expander +3 dB |
| Vocal-to-beat, 1-4 kHz, while the vocal is present | +1 to +5 dB (rap), +8 or more (VO) | beat dip or balance ±1 dB |

Up to 3 passes. Every pass is logged in the panel ("Pass 2: S sounds were 4 dB hot, de-esser deepened to 9 dB"). If a check still fails after the last pass, the panel says so in plain words instead of showing a green result.

### 6. "What I did and why" panel

Replaces today's text report. One row per step: name, value, the reason, an on/off switch and a control to change it. Changing a control marks the mix out of date and locks that step. A **Reset to auto** button per step and for the whole chain.

### 7. Learning Corey's taste

- **Save as my preset**: stores the current chain (with locks) and mix settings under a name, in the browser's local storage on his PC.
- **Taste profile**: each time Corey overrides a step and then saves or exports, the difference from the automatic value is recorded per chain type (for example "presence: +1.5 dB on average"). After three sessions that agree, the automatic value starts from his preference. Shown and resettable in the Voice profile panel. Nothing leaves the PC.

## Open-source candidates

None of these is adopted. Each one has to win a test on a real take from the MAONO before it goes in. Licences below are from memory and **must be checked against each project's repository** when the candidate is tested; the checked licence is then recorded in `REA.md`.

| Stage | Candidate | Licence (to verify) | Where it would run | Test it has to pass |
|---|---|---|---|---|
| De-noise / de-reverb | DeepFilterNet 3 | MIT / Apache-2.0 | Backend (Python) | Lowers room tail and noise by ≥ 6 dB more than the current gate with no audible damage to consonants, on Corey's raw take |
| De-noise | RNNoise | BSD-3 | Browser (WASM) or backend | Same test; 48 kHz only fits. Expected to lose to DeepFilterNet |
| Pitch tracking | CREPE (current) | MIT | Backend | Baseline |
| Pitch tracking | RMVPE-class | MIT (verify the weights too) | Backend | Replace CREPE only if note error is lower on a rap take with a beat bleeding in |
| Beat with vocals on it | HTDemucs | MIT | Backend | Optional. Splits a two-track beat into drums / bass / other so stem roles work. Slow on CPU; only worth it if Corey uses such beats |
| Loudness | pyloudnorm | MIT | Tests only | Used to cross-check the app's own BS.1770 meter, not shipped |
| DSP | pedalboard (Spotify) | **GPL-3.0** | - | Not preferred: licence, and the browser engine already has these processors |
| Reference mastering | matchering | **GPL-3.0** | - | Not adopted. The idea (match loudness and tonal balance to a reference) is simple enough to write natively |
| Automatic mixing research | Published intelligent-mixing work (masking-based EQ, target-curve mixing) | papers | Browser | Method only; no code dependency |

Decision for the core: stay in the browser in plain JavaScript, as `CLAUDE.md` requires. The backend stays optional and is used only where a model is clearly better (studio tuning today; de-noise if DeepFilterNet wins).

## Rules this design keeps

His voice stays his voice (no cloning or conversion). Local only. Raw takes are never overwritten. Browser echo cancellation, noise suppression and auto gain stay off. No live tuned monitoring. No new runtime npm dependencies.
