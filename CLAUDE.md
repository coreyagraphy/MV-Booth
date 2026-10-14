# MV Booth

Music project only: a private vocal booth for recording voice-overs and rap vocals with autonomous mixing.
It has nothing to do with Helix CRM or any CRM work. Never put it in, or link it to, the helix-crm repo.

- Owner: Corey Ellis (Mental Vision / Coreyagraphy). For personal use only.
- Runs locally (`start.bat` / `start.sh` → http://localhost:5177). Netlify is optional (base dir = repo root).
- Zero dependencies, vanilla JS + Web Audio. DSP lives in `js/dsp.js`, mix engine in `js/automix.js`, UI in `js/app.js`.
