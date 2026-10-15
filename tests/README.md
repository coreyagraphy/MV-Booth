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
| declick | false-click rate on clean takes, injected clicks found, repair never worse than the click |
| daw | transport, loop record, comp, clips, mixer, prompter, Automix loudness, WAV/MP3 export, sessions |
| punch | punch-in pre/post-roll, sample-exact boundaries, crossfades |
| ux | Space, tools, hints, presets, guide, recording banner |
| song | Song checklist, Clean tab, cleaned take, master tone/width/ceiling |
| stems | multi-stem import, roles, mute/solo, per-stem mix + export, persistence |
| fixes | audit fixes: short ad-lib loudness, clip before 0:00, undo blocked while recording, save on close, duplicate-safe purge |
| single | the self-contained `dist/index.html` alone (Netlify single-file upload) |
| studio | Studio tune through the local backend (needs `backend\start-backend.bat`) |

Fixtures (synthetic vocal, beat, double, drum/808/keys stems) are generated into `tests/.out/`.
