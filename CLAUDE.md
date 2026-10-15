# MV Booth

Music project only: Corey Ellis's private vocal booth (Mental Vision). It records voice-overs and rap vocals with autonomous tuning, doubling, mixing and mastering.
It has nothing to do with Helix CRM or any CRM work. Never put it in, or link it to, the helix-crm repo.

- Personal use; runs locally. `INSTALL.bat` creates Desktop/Start-menu shortcuts → `launch.vbs` → `serve.mjs` (localhost:5177, app-mode window, auto-exit).
- No npm runtime deps: vanilla JS + Web Audio (lamejs is vendored). PWA (`manifest.webmanifest`, `sw.js`); bump `CACHE` in `sw.js` when shell files change.
- `build.mjs` (Netlify build) bundles CSS + all JS modules into a self-contained `dist/index.html`, so even a single-file upload works. Keep module imports/exports in the simple forms it rewrites.
- Modules: `js/dsp.js` primitives (LUFS, true peak, limiter) · `js/session.js` tracks→takes→clips model, comping, undo, sessions · `js/metro.js` click/count-in/tap · `js/mp3.js` + `js/vendor/lame.min.js` (LGPL) MP3 worker · `js/tune.js` YIN/key/PSOLA · `js/doubles.js` DTW+WSOLA alignment, ADT doubles · `js/automix.js` vocal chain + mix/master · `js/engine.js` 8-stage orchestration + voice learning · `js/app.js` UI.
- Backend: `backend/` FastAPI on 127.0.0.1:8765 (`server.py` jobs API, `tuner.py` CREPE + WORLD). Personal, local, no auth, stateless; never touch the original take (results come back as new takes). Low-confidence regions stay untuned.
- Tests: `tests/` (test-only devDeps; the app stays dependency-free). `cd tests && npm install && npm test` runs lint + every browser suite on port 5199, so real sessions on 5177 are untouched. Add a check there when you fix a bug.
- Spec: `docs/SPEC-v2.md` is the DAW-parity matrix; update it when features land.
- Design: Mental Vision system (graphite glass, orange #ff7a1a + teal #12e0d0, Unbounded/Space Grotesk/JetBrains Mono, cinematic easing).
- Methodology: REA (github.com/morluto/rea). Keep `REA.md` ledger current when features change.
