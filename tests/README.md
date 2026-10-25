# MV Booth tests

Browser tests drive the real app in headless Chromium with a simulated mic. They run against
their own port (5199), so your real sessions on 5177 are never touched.

```
cd tests
npm install                       # test-only tools: playwright-core, eslint
npx playwright-core install chromium   # once, unless Chrome/Edge is set via CHROME_PATH
npm test                          # lint + all suites except the backend one
npm run test:all                  # also the Studio-tune suite (start the backend first)
node run.mjs stems song           # just some suites
```

| Suite | Covers |
| --- | --- |
| dsp | FFT vs reference DFT, pitch accuracy, LUFS (48 and 44.1 kHz), true peak, de-noise behaviour |
| declick | false-click rate on clean takes, injected clicks found, repair never worse than the click |
| daw | transport, loop record, comp, clips, mixer, prompter, Automix loudness, WAV/MP3 export, sessions |
| punch | punch-in pre/post-roll, sample-exact boundaries, crossfades |
| ux | Space, tools, hints, presets, guide, recording banner |
| song | Song checklist, Clean tab, cleaned take, master tone/width/ceiling |
| stems | multi-stem import, roles, mute/solo, per-stem mix + export, persistence |
| fixes | audit fixes: short ad-lib loudness, clip before 0:00, undo blocked while recording, save on close, duplicate-safe purge |
| booth | Enter/Space never re-press buttons (marker bug), 🎧 Monitor, sync test maths (180 / 320 ms, uneven, too few), track timing nudge, scroll bar, ⇤ Start |
| package | `.mvbooth` round trip: 24-bit precision with peaks above full scale kept, model intact, unused takes dropped, bad files refused, export → open in a fresh browser |
| makesong | Make my song: refusal with nothing recorded, working state, mix + WAV + MP3 from one click, checklist ticks, header one row |
| single | the self-contained `dist/index.html` alone (Netlify single-file upload) |
| studio | Studio tune through the local backend (needs `backend\start-backend.bat`) |

`node bench.mjs` times Automix on a 3-minute song (tiles the fixtures) and the timeline redraw; `PROFILE=1` adds a per-function profile.

Fixtures (synthetic vocal, beat, double, drum/808/keys stems) are generated into `tests/.out/`.

## Tools

`node tools/mix-package.mjs <song.mvbooth> <out-dir> [--preset "Rap · Upfront"] [--fix-timing]` mixes a session package all the way through in the real app (headless, own port): timing analysis vs the beat, Automix, master WAV + MP3, stems, a package of the mix and `REPORT.md`.
