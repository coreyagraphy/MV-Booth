"""MV Booth backend: local, stateless audio processing for the browser app.

Run:  python backend/server.py      (listens on http://127.0.0.1:8765)

GET  /health                 → status + which engines loaded
POST /tune  (multipart: file=<WAV>, params=<JSON>)  → {"job": id}
GET  /jobs/{id}              → {"state": queued|running|done|failed, "progress", "message", "report"}
GET  /jobs/{id}/audio        → tuned WAV (when done)

Personal tool: binds to localhost only, no auth. Jobs live in memory and
are dropped after an hour; the session model stays in the browser.
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

VERSION = "1.0.0"
PORT = 8765

app = FastAPI(title="MV Booth backend", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|https://mv-booth\.netlify\.app)$",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.middleware("http")
async def private_network(request: Request, call_next):
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
    cutoff = time.time() - 3600
    with LOCK:
        for k in [k for k, j in JOBS.items() if j["created"] < cutoff]:
            JOBS.pop(k, None)


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


@app.post("/tune")
async def post_tune(file: UploadFile = File(...), params: str = Form("{}")):
    if "error" in ENGINES:
        raise HTTPException(503, f"Tuning engines not loaded: {ENGINES['error']}")
    try:
        data, sr = sf.read(io.BytesIO(await file.read()), dtype="float64", always_2d=True)
    except Exception as e:
        raise HTTPException(400, f"Could not read audio: {e}") from e
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
    POOL.submit(_run_tune, job_id, data.mean(axis=1), sr, p)
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
    return Response(job["result"], media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    if sys.stdout is None:  # pythonw (hidden launch): log to a file instead of a console
        sys.stdout = sys.stderr = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "backend.log"), "a", buffering=1)

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("MVB_PORT", PORT)), log_level="info")
