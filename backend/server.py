"""MV Booth backend: local, stateless audio processing for the browser app.

Run:  python backend/server.py      (listens on http://127.0.0.1:8765)

GET  /health                 → status + which engines loaded
POST /tune  (multipart: file=<WAV>, params=<JSON>)  → {"job": id}
GET  /jobs/{id}              → {"state": queued|running|done|failed, "progress", "message", "report"}
GET  /jobs/{id}/audio        → tuned WAV (when done)

Personal tool: binds to localhost only, no auth. Jobs live in memory: a result
is freed once its audio is downloaded, finished jobs are dropped after 10 minutes,
queued/running jobs are never dropped. With --idle-exit (how the MV Booth shortcut
starts it) the process exits after 5 minutes without any request, so it doesn't
keep ~1 GB of torch in memory after the booth closes.
"""
from __future__ import annotations

import io
import json
import os
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

VERSION = "1.1.0"
PORT = 8765
MAX_UPLOAD = 300 * 1024 * 1024  # ~25 min of 48 kHz float stereo; far beyond any single take
FINISHED_TTL = 600
IDLE_EXIT = 300 if "--idle-exit" in sys.argv else 0
LAST_SEEN = time.time()

app = FastAPI(title="MV Booth backend", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|https://mv-booth\.netlify\.app)$",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def private_network(request: Request, call_next):
    global LAST_SEEN
    LAST_SEEN = time.time()
    # Chrome's Private Network Access: lets the https Netlify page reach localhost.
    if request.method == "OPTIONS" and request.headers.get("access-control-request-private-network"):
        resp = Response(status_code=204)
        origin = request.headers.get("origin", "")
        resp.headers.update({
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": request.headers.get("access-control-request-headers", "*"),
            "Access-Control-Allow-Private-Network": "true",
        })
        return resp
    return await call_next(request)


JOBS: dict[str, dict] = {}
LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=1)  # one heavy job at a time keeps the PC responsive
ENGINES: dict[str, str] = {}


def _load_engines():
    try:
        import pyworld  # noqa: F401
        import torch
        import torchcrepe  # noqa: F401

        ENGINES.update({"torch": torch.__version__, "crepe": "torchcrepe", "world": "pyworld"})
    except Exception as e:  # pragma: no cover - shown in /health
        ENGINES["error"] = f"{type(e).__name__}: {e}"


_load_engines()


def _gc():
    cutoff = time.time() - FINISHED_TTL
    with LOCK:
        for k in [k for k, j in JOBS.items() if j["state"] in ("done", "failed") and j.get("finished", j["created"]) < cutoff]:
            JOBS.pop(k, None)


def _housekeeping():
    # Runs even when nobody calls the API, so an idle backend still frees memory (and can exit).
    while True:
        time.sleep(30)
        _gc()
        busy = any(j["state"] in ("queued", "running") for j in list(JOBS.values()))
        if IDLE_EXIT and not busy and time.time() - LAST_SEEN > IDLE_EXIT:
            print("No requests for a while and no jobs: exiting (the MV Booth shortcut restarts me).", flush=True)
            os._exit(0)


threading.Thread(target=_housekeeping, daemon=True).start()


@app.get("/health")
def health():
    return {"ok": "error" not in ENGINES, "version": VERSION, "engines": ENGINES, "jobs": len(JOBS)}


def _run_tune(job_id: str, audio: np.ndarray, sr: int, params: dict):
    from tuner import tune

    job = JOBS[job_id]
    job["state"] = "running"

    def progress(p, msg):
        job["progress"] = round(float(p), 3)
        job["message"] = msg

    try:
        t0 = time.time()
        res = tune(audio, sr, params, progress)
        buf = io.BytesIO()
        sf.write(buf, res.audio, res.sr, format="WAV", subtype="FLOAT")
        job["result"] = buf.getvalue()
        job["report"] = {**res.report(), "seconds": round(time.time() - t0, 2), "params": params}
        job["state"] = "done"
        job["progress"] = 1.0
        job["message"] = "Done"
    except Exception as e:
        traceback.print_exc()
        job["state"] = "failed"
        job["message"] = f"{type(e).__name__}: {e}"
    finally:
        job["finished"] = time.time()


@app.post("/tune")
async def post_tune(file: UploadFile = File(...), params: str = Form("{}")):
    if "error" in ENGINES:
        raise HTTPException(503, f"Tuning engines not loaded: {ENGINES['error']}")
    raw = await file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, "Audio too large: send one take at a time")
    try:
        data, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    except Exception as e:
        raise HTTPException(400, f"Could not read audio: {e}") from e
    del raw
    if len(data) < sr * 0.2:
        raise HTTPException(400, "Audio too short")
    try:
        p = json.loads(params or "{}")
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"Bad params JSON: {e}") from e
    _gc()
    job_id = uuid.uuid4().hex[:12]
    with LOCK:
        JOBS[job_id] = {"state": "queued", "progress": 0.0, "message": "Queued", "created": time.time(), "result": None, "report": None}
    mono = data.mean(axis=1).astype(np.float64)
    del data
    POOL.submit(_run_tune, job_id, mono, sr, p)
    return {"job": job_id}


@app.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    return JSONResponse({k: job[k] for k in ("state", "progress", "message", "report")})


@app.get("/jobs/{job_id}/audio")
def get_audio(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown job")
    if job["state"] != "done":
        raise HTTPException(409, f"Job is {job['state']}")
    if job["result"] is None:
        raise HTTPException(410, "Audio already downloaded")
    body, job["result"] = job["result"], None  # the browser keeps it as a take; free it here
    return Response(body, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    if sys.stdout is None:  # pythonw (hidden launch): log to a file instead of a console
        sys.stdout = sys.stderr = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend.log"), "a", buffering=1)

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("MVB_PORT", PORT)), log_level="info")
