"""MV Booth studio tuner: CREPE pitch tracking + WORLD resynthesis.

Pipeline: take → CREPE f0 + periodicity (confidence) → voiced regions →
key detect (or manual) → per-frame correction curve (note snap, retune
speed, vibrato keep, amount) → WORLD analysis/resynthesis of each confident
region only → crossfade back into the untouched original.

Low-confidence regions are left exactly as recorded: untouched audio beats
artifacts.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pyworld
import torch
import torchcrepe
from scipy.signal import resample_poly

HOP_S = 0.005  # 5 ms analysis frames for both CREPE and WORLD
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
SCALES = {
    "major": [0, 2, 4, 5, 7, 9, 11],
    "minor": [0, 2, 3, 5, 7, 8, 10],
    "harmonicMinor": [0, 2, 3, 5, 7, 8, 11],
    "minorPent": [0, 3, 5, 7, 10],
    "majorPent": [0, 2, 4, 7, 9],
    "chromatic": list(range(12)),
}
KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


@dataclass
class TuneParams:
    key: str | int = "auto"       # "auto" or tonic 0..11
    scale: str = "minor"
    retune_ms: float = 60.0       # 0 = instant hard tune (robot), higher = natural
    vibrato: float = 0.8          # 0 = flatten vibrato, 1 = keep it all
    amount: float = 1.0           # 0..1 how far toward the note
    formant: bool = True          # True = preserve formants (no chipmunk)
    min_confidence: float = 0.5   # regions below this stay untouched
    model: str = "full"           # CREPE capacity: "full" or "tiny"

    @classmethod
    def from_dict(cls, d: dict) -> "TuneParams":
        p = cls()
        for k, v in (d or {}).items():
            if hasattr(p, k) and v is not None:
                setattr(p, k, v)
        if p.key != "auto":
            p.key = int(p.key) % 12
        if p.scale not in SCALES:
            p.scale = "minor"
        p.retune_ms = float(np.clip(float(p.retune_ms), 0, 600))
        p.vibrato = float(np.clip(float(p.vibrato), 0, 1))
        p.amount = float(np.clip(float(p.amount), 0, 1))
        p.min_confidence = float(np.clip(float(p.min_confidence), 0, 1))
        p.formant = bool(p.formant)
        return p


@dataclass
class Region:
    start: float
    end: float
    confidence: float
    tuned: bool
    mean_shift_cents: float = 0.0
    max_shift_cents: float = 0.0
    reason: str = ""


@dataclass
class TuneResult:
    audio: np.ndarray
    sr: int
    key: dict
    regions: list[Region] = field(default_factory=list)

    def report(self) -> dict:
        tuned = [r for r in self.regions if r.tuned]
        sung = sum(r.end - r.start for r in self.regions) or 1e-9
        return {
            "key": self.key,
            "regions": [r.__dict__ for r in self.regions],
            "summary": {
                "regions": len(self.regions),
                "tuned": len(tuned),
                "skipped_low_confidence": sum(1 for r in self.regions if not r.tuned),
                "tuned_seconds": round(sum(r.end - r.start for r in tuned), 2),
                "coverage": round(sum(r.end - r.start for r in tuned) / sung, 3),
                "mean_shift_cents": round(float(np.mean([abs(r.mean_shift_cents) for r in tuned])) if tuned else 0.0, 1),
            },
        }


# ---------------------------------------------------------------- pitch

def track_pitch(x: np.ndarray, sr: int, model: str = "full", device: str = "cpu"):
    """CREPE at 16 kHz, 5 ms hop. Returns (f0 Hz, periodicity 0..1), both per frame."""
    x16 = resample_poly(x, 16000, sr) if sr != 16000 else x
    audio = torch.tensor(x16, dtype=torch.float32)[None]
    hop = int(16000 * HOP_S)
    f0, per = torchcrepe.predict(
        audio, 16000, hop, fmin=55.0, fmax=1100.0, model=model,
        decoder=torchcrepe.decode.viterbi, return_periodicity=True,
        batch_size=1024, device=device, pad=True,
    )
    per = torchcrepe.filter.median(per, 3)
    # Silence gate: CREPE is confident about room tone sometimes; loudness says no.
    db = torchcrepe.loudness.a_weighted(audio, 16000, hop)
    per[db < -60.0] = 0
    f0 = torchcrepe.filter.mean(f0, 3)
    return f0[0].numpy().astype(np.float64), per[0].numpy().astype(np.float64)


def voiced_regions(per: np.ndarray, thresh: float = 0.21, min_len_s: float = 0.08, bridge_s: float = 0.04):
    """Contiguous voiced spans (frame index pairs), bridging tiny gaps."""
    v = per > thresh
    regions, i, n = [], 0, len(v)
    while i < n:
        if not v[i]:
            i += 1
            continue
        j = i
        while j < n and v[j]:
            j += 1
        regions.append([i, j])
        i = j
    merged = []
    for r in regions:
        if merged and (r[0] - merged[-1][1]) * HOP_S <= bridge_s:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [(a, b) for a, b in merged if (b - a) * HOP_S >= min_len_s]


def detect_key(f0: np.ndarray, voiced: np.ndarray) -> dict:
    hist = np.zeros(12)
    for f in f0[voiced]:
        if f <= 0:
            continue
        m = 69 + 12 * math.log2(f / 440.0)
        hist[int(round(m)) % 12] += 1 - min(1.0, abs(m - round(m)) * 1.5)
    best = {"tonic": 0, "scale": "minor", "score": -2.0}
    if hist.sum() <= 0:
        return {**best, "confident": False, "label": "unknown"}
    for t in range(12):
        rot = np.roll(hist, -t)
        for name, prof in (("major", KS_MAJOR), ("minor", KS_MINOR)):
            s = float(np.corrcoef(rot, prof)[0, 1])
            if s > best["score"]:
                best = {"tonic": t, "scale": name, "score": s}
    best["confident"] = bool(best["score"] > 0.5 and hist.sum() > 40)
    best["score"] = round(float(best["score"]), 3)
    best["label"] = f"{NOTE_NAMES[best['tonic']]} {best['scale']}"
    return best


# ---------------------------------------------------------------- correction

def correction_curve(f0: np.ndarray, voiced: np.ndarray, tonic: int, scale: str, p: TuneParams) -> np.ndarray:
    """Semitone shift per frame (0 where unvoiced)."""
    allowed = {(s + tonic) % 12 for s in SCALES[scale]}
    midi = np.full(len(f0), np.nan)
    ok = voiced & (f0 > 0)
    midi[ok] = 69 + 12 * np.log2(f0[ok] / 440.0)
    # Vibrato keep: correct toward the note centre measured over a window that
    # grows with `vibrato` (0 → per-frame, flattens vibrato; 1 → 200 ms centre).
    half = int(round(p.vibrato * 0.1 / HOP_S))
    alpha = 1.0 if p.retune_ms <= 0 else 1 - math.exp(-HOP_S / (p.retune_ms / 1000.0))

    def nearest(m: float) -> int:
        cands = [c for c in range(int(math.floor(m)) - 2, int(math.ceil(m)) + 3) if c % 12 in allowed]
        return min(cands, key=lambda c: abs(m - c))

    shift = np.zeros(len(f0))
    cur, s, gap = None, 0.0, 99
    for i in range(len(f0)):
        if np.isnan(midi[i]):
            gap += 1
            s *= 0.5
            if gap > 8:
                cur = None
            shift[i] = 0.0
            continue
        lo, hi = max(0, i - half), min(len(f0), i + half + 1)
        win = midi[lo:hi]
        centre = float(np.nanmean(win))
        cand = nearest(centre)
        if cur is None or abs(centre - cand) + 0.15 < abs(centre - cur):
            cur = cand
        target = (cur - centre) * p.amount
        if gap > 8:
            s = target if p.retune_ms <= 30 else target * 0.5  # note onset
        gap = 0
        s += (target - s) * alpha
        shift[i] = s
    return shift


# ---------------------------------------------------------------- WORLD

def _warp_envelope(sp: np.ndarray, ratio: np.ndarray) -> np.ndarray:
    """Move the spectral envelope with the pitch (formant preserve OFF)."""
    n = sp.shape[1]
    bins = np.arange(n)
    out = np.empty_like(sp)
    for t in range(sp.shape[0]):
        out[t] = np.interp(bins / ratio[t], bins, sp[t], right=sp[t, -1])
    return out


def world_shift(seg: np.ndarray, sr: int, f0_seg: np.ndarray, shift_seg: np.ndarray, formant: bool) -> np.ndarray:
    x = np.ascontiguousarray(seg, dtype=np.float64)
    fp = HOP_S * 1000.0
    t = np.arange(len(f0_seg)) * HOP_S
    f0r = pyworld.stonemask(x, np.ascontiguousarray(f0_seg), t, sr)  # refine CREPE f0 on the waveform
    f0r[f0_seg <= 0] = 0
    sp = pyworld.cheaptrick(x, f0r, t, sr)
    ap = pyworld.d4c(x, f0r, t, sr)
    ratio = np.power(2.0, shift_seg / 12.0)
    # Excite at the *corrected CREPE pitch* (exact target); the stonemask-refined
    # f0 is only used to analyse the envelope/aperiodicity cleanly.
    f0n = np.where(f0_seg > 0, f0_seg * ratio, 0.0)
    if not formant:
        sp = _warp_envelope(sp, ratio)
    y = pyworld.synthesize(f0n, sp, ap, sr, fp)
    if len(y) < len(x):
        y = np.pad(y, (0, len(x) - len(y)))
    return y[: len(x)]


# ---------------------------------------------------------------- main entry

def tune(x: np.ndarray, sr: int, params: dict | TuneParams, progress=None) -> TuneResult:
    p = params if isinstance(params, TuneParams) else TuneParams.from_dict(params)
    say = progress or (lambda *_: None)
    x = np.asarray(x, dtype=np.float64)
    if x.ndim > 1:
        x = x.mean(axis=1)
    say(0.05, "Tracking pitch (CREPE)")
    f0, per = track_pitch(x, sr, model=p.model)
    n = min(len(f0), int(math.ceil(len(x) / (sr * HOP_S))) + 1)
    f0, per = f0[:n], per[:n]
    spans = voiced_regions(per)
    voiced = np.zeros(n, dtype=bool)
    for a, b in spans:
        voiced[a:b] = True

    say(0.45, "Finding the key")
    if p.key == "auto":
        key = detect_key(f0, voiced)
    else:
        key = {"tonic": int(p.key), "scale": p.scale, "confident": True, "label": f"{NOTE_NAMES[int(p.key)]} {p.scale}", "score": None}
    shift = correction_curve(f0, voiced, key["tonic"], key["scale"] if p.key == "auto" else p.scale, p)

    out = x.copy()
    regions: list[Region] = []
    pad = int(0.05 * sr)
    xf = int(0.02 * sr)  # 20 ms crossfades into/out of the corrected audio
    for k, (a, b) in enumerate(spans):
        say(0.5 + 0.48 * k / max(1, len(spans)), f"Resynthesising region {k + 1}/{len(spans)} (WORLD)")
        conf = float(np.mean(per[a:b]))
        r = Region(start=round(a * HOP_S, 3), end=round(b * HOP_S, 3), confidence=round(conf, 3), tuned=False)
        cents = shift[a:b] * 100
        r.mean_shift_cents = round(float(np.mean(cents)), 1)
        r.max_shift_cents = round(float(np.max(np.abs(cents))) if len(cents) else 0.0, 1)
        if conf < p.min_confidence:
            r.reason = "low confidence: left untouched"
            regions.append(r)
            continue
        if r.max_shift_cents < 3:
            r.reason = "already in tune"
            regions.append(r)
            continue
        s0 = max(0, int(a * HOP_S * sr) - pad)
        s1 = min(len(x), int(b * HOP_S * sr) + pad)
        fa, fb = int(s0 / (sr * HOP_S)), int(math.ceil(s1 / (sr * HOP_S)))
        f0_seg = f0[fa:fb].copy()
        f0_seg[~voiced[fa:fb]] = 0
        f0_seg = np.pad(f0_seg, (0, max(0, int(math.ceil((s1 - s0) / (sr * HOP_S))) + 1 - len(f0_seg))))
        sh_seg = np.pad(shift[fa:fb], (0, len(f0_seg) - len(shift[fa:fb])))
        y = world_shift(x[s0:s1], sr, f0_seg, sh_seg, p.formant)
        # Level-match the vocoder output to the original segment.
        rms_x = math.sqrt(float(np.mean(x[s0:s1] ** 2)) + 1e-12)
        rms_y = math.sqrt(float(np.mean(y ** 2)) + 1e-12)
        y *= min(4.0, rms_x / rms_y)
        w = np.ones(s1 - s0)
        f = min(xf, (s1 - s0) // 2)
        if f > 0:
            ramp = 0.5 - 0.5 * np.cos(np.linspace(0, math.pi, f))
            w[:f] = ramp
            w[-f:] = ramp[::-1]
        out[s0:s1] = out[s0:s1] * (1 - w) + y * w
        r.tuned = True
        r.reason = "tuned"
        regions.append(r)
    say(1.0, "Done")
    peak = float(np.max(np.abs(out))) if len(out) else 0
    if peak > 0.999:
        out *= 0.999 / peak
    return TuneResult(audio=out.astype(np.float32), sr=sr, key=key, regions=regions)
