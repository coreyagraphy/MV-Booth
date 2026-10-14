# MV Booth

Music project only: Corey Ellis's private vocal booth (Mental Vision). It records voice-overs and rap vocals with autonomous tuning, doubling, mixing and mastering.
It has nothing to do with Helix CRM or any CRM work. Never put it in, or link it to, the helix-crm repo.

- Personal use; runs locally. `INSTALL.bat` creates Desktop/Start-menu shortcuts → `launch.vbs` → `serve.mjs` (localhost:5177, app-mode window, auto-exit).
- Zero dependencies: vanilla JS + Web Audio. PWA (`manifest.webmanifest`, `sw.js`); bump `CACHE` in `sw.js` when shell files change.
- Modules: `js/dsp.js` primitives · `js/tune.js` YIN/key/PSOLA · `js/doubles.js` DTW+WSOLA alignment, ADT doubles · `js/automix.js` vocal chain + mix/master · `js/engine.js` 8-stage orchestration + voice learning · `js/app.js` UI.
- Design: Mental Vision system (graphite glass, orange #ff7a1a + teal #12e0d0, Unbounded/Space Grotesk/JetBrains Mono, cinematic easing).
- Methodology: REA (github.com/morluto/rea). Keep `REA.md` ledger current when features change.
