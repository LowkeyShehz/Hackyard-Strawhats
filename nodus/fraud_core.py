"""
Nirman Mitra — fraud detection core (runs on Nodus compute).

Closes the anti-misuse gaps listed in PRD §8:
  * gallery / re-sent selfies      -> perceptual near-duplicate matching (pHash + DINOv2)
  * photo of a photo or a screen   -> recapture score (moire / periodic high-frequency energy)
  * one person, two numbers        -> face embedding clusters across workers (SFace)
  * mock-location apps             -> identical GPS fixes on different days, impossible travel
  * one phone, many workers        -> several workers checking in at one spot within seconds

The model-backed helpers load lazily so the pure-logic checks run (and are tested) on any CPU.
"""

from __future__ import annotations

import base64
import io
import math
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

# Thresholds (tuned for WhatsApp-compressed 1600px selfies; revisit with real data)
PHASH_NEAR_DUP_BITS = 8          # pHash hamming distance at or below this = same picture
EMBED_NEAR_DUP_COSINE = 0.95     # DINOv2 cosine at or above this = same picture, re-encoded/cropped
FACE_SAME_PERSON_COSINE = 0.40   # SFace cosine at or above this = same person (OpenCV suggests 0.363)
RECAPTURE_FLAG_SCORE = 0.6       # recapture score at or above this = likely photo of a screen
IMPOSSIBLE_SPEED_KMH = 120.0     # faster than this between two check-ins is not plausible
STATIC_GPS_MIN_DAYS = 3          # identical fix on this many distinct days = mock location
FARM_RADIUS_M = 15.0             # check-ins this close ...
FARM_WINDOW_S = 90               # ... and this close in time ...
FARM_MIN_WORKERS = 3             # ... from this many workers = one phone checking everyone in


# ─────────────────────────────────────────────────────────
# Encoding helpers
# ─────────────────────────────────────────────────────────

def load_image(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data)).convert("RGB")


def encode_vector(vec: np.ndarray) -> str:
    """float16 + base64 keeps a 512-d embedding under 1.4 KB in DynamoDB."""
    return base64.b64encode(np.asarray(vec, dtype=np.float16).tobytes()).decode()


def decode_vector(text: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(text), dtype=np.float16).astype(np.float32)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / denom) if denom else 0.0


# ─────────────────────────────────────────────────────────
# Image signals
# ─────────────────────────────────────────────────────────

def _dct_matrix(n: int) -> np.ndarray:
    k = np.arange(n)[:, None]
    return np.cos(np.pi * (2 * np.arange(n)[None, :] + 1) * k / (2 * n))


_DCT32 = _dct_matrix(32)


def phash(img: Image.Image) -> str:
    """64-bit perceptual hash (same construction as imagehash.phash: 32x32 DCT, 8x8 low band
    compared to its median), in numpy so workers need no scipy."""
    pixels = np.asarray(img.convert("L").resize((32, 32), Image.LANCZOS), dtype=np.float64)
    low = (_DCT32 @ pixels @ _DCT32.T)[:8, :8]
    bits = (low > np.median(low)).flatten()
    return f"{int(''.join('1' if b else '0' for b in bits), 2):016x}"


def phash_distance(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def recapture_score(img: Image.Image) -> float:
    """
    0..1 score that the selfie is a photo of a screen or print. Screens add a periodic pixel grid
    that shows up as isolated peaks in the high-frequency band of the spectrum; a real camera
    frame has a smooth fall-off. Heuristic, not a trained liveness model.
    """
    gray = np.asarray(img.convert("L").resize((512, 512)), dtype=np.float32)
    gray -= gray.mean()
    spectrum = np.abs(np.fft.fftshift(np.fft.fft2(gray)))
    h, w = spectrum.shape
    yy, xx = np.ogrid[:h, :w]
    radius = np.hypot(yy - h / 2, xx - w / 2)
    band = spectrum[(radius > 0.25 * h) & (radius < 0.48 * h)]
    if band.size == 0 or band.mean() == 0:
        return 0.0
    peakiness = float(np.percentile(band, 99.9) / (np.median(band) + 1e-6))
    # Starting calibration: scores rise once the 99.9th-percentile peak is well above the median.
    # Calibrate on a few real camera selfies and screen photos at the event.
    return float(min(1.0, max(0.0, (peakiness - 15.0) / 35.0)))


_models: dict = {}


def _device():
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"


def image_embedding(img: Image.Image) -> np.ndarray:
    """DINOv2-small CLS embedding: robust to re-compression, crops and colour shifts."""
    import torch
    from transformers import AutoImageProcessor, AutoModel
    if "dino" not in _models:
        _models["dino"] = (
            AutoImageProcessor.from_pretrained("facebook/dinov2-small"),
            AutoModel.from_pretrained("facebook/dinov2-small").to(_device()).eval(),
        )
    processor, model = _models["dino"]
    with torch.no_grad():
        inputs = processor(images=img, return_tensors="pt").to(_device())
        cls = model(**inputs).last_hidden_state[:, 0][0]
    vec = cls.cpu().numpy()
    return vec / (np.linalg.norm(vec) + 1e-9)


def face_embedding(image_bytes: bytes) -> np.ndarray | None:
    """SFace embedding of the largest face (see face.py), or None when no face is found. The
    same model enrols workers, so these embeddings compare directly with the enrolled one."""
    from face import embed_face
    vec = embed_face(image_bytes)["embedding"]
    return np.asarray(vec, dtype=np.float32) if vec is not None else None


# ─────────────────────────────────────────────────────────
# Real-time selfie analysis
# ─────────────────────────────────────────────────────────

def find_near_duplicate(selfie_phash: str, selfie_embedding: np.ndarray | None, history: list[dict]) -> dict | None:
    """
    Compare one selfie against the worker's previous selfies.
    history items: {"date": "YYYY-MM-DD", "phash": hex, "embedding": base64 float16 (optional)}
    """
    best = None
    for past in history:
        reasons = []
        bits = phash_distance(selfie_phash, past["phash"]) if past.get("phash") else 64
        if bits <= PHASH_NEAR_DUP_BITS:
            reasons.append(f"phash distance {bits}")
        sim = None
        if selfie_embedding is not None and past.get("embedding"):
            sim = cosine(selfie_embedding, decode_vector(past["embedding"]))
            if sim >= EMBED_NEAR_DUP_COSINE:
                reasons.append(f"embedding cosine {sim:.3f}")
        if reasons and (best is None or (sim or 0) > (best["similarity"] or 0)):
            best = {"date": past["date"], "similarity": sim, "phash_distance": bits, "reasons": reasons}
    return best


def analyze_selfie(image_bytes: bytes, history: list[dict], use_models: bool = True,
                   image_embeddings: bool = False) -> dict:
    """
    use_models:       run the SFace face model (CPU, ~40 ms)
    image_embeddings: also run DINOv2 for crop/re-encode-robust near-duplicates (GPU, Nodus)
    """
    img = load_image(image_bytes)
    selfie_phash = phash(img)
    emb = image_embedding(img) if use_models and image_embeddings else None
    face = face_embedding(image_bytes) if use_models else None
    score = recapture_score(img)
    dup = find_near_duplicate(selfie_phash, emb, history)

    flags = []
    if dup:
        flags.append(f"Near-duplicate of selfie from {dup['date']} ({', '.join(dup['reasons'])})")
    if score >= RECAPTURE_FLAG_SCORE:
        flags.append(f"Possible photo of a screen (recapture score {score:.2f})")
    return {
        "phash": selfie_phash,
        "embedding": encode_vector(emb) if emb is not None else None,
        "face_embedding": encode_vector(face) if face is not None else None,
        "recapture_score": round(score, 3),
        "near_duplicate": dup,
        "flags": flags,
    }


# ─────────────────────────────────────────────────────────
# Batch sweep over many check-ins
# ─────────────────────────────────────────────────────────

@dataclass
class Checkin:
    worker_id: str
    log_date: str
    timestamp: float              # epoch seconds
    lat: float | None = None      # gps_cell (4 dp, ~11 m)
    lng: float | None = None
    gps_hash: str | None = None   # sha256 of the full-precision fix
    site_id: str | None = None


@dataclass
class SweepResult:
    flags: dict = field(default_factory=lambda: defaultdict(list))   # (worker_id, log_date) -> [str]

    def add(self, worker_id: str, log_date: str, reason: str):
        bucket = self.flags[(worker_id, log_date)]
        if reason not in bucket:
            bucket.append(reason)


def haversine_m(lat1, lng1, lat2, lng2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def detect_static_gps(checkins: list[Checkin], result: SweepResult):
    """Real GPS jitters by metres every day; the exact same fix on several days is a mock app."""
    by_worker_fix = defaultdict(set)
    for c in checkins:
        if c.gps_hash:
            by_worker_fix[(c.worker_id, c.gps_hash)].add(c.log_date)
    for (worker_id, _), days in by_worker_fix.items():
        if len(days) >= STATIC_GPS_MIN_DAYS:
            for day in days:
                result.add(worker_id, day, f"Identical GPS fix on {len(days)} different days (possible mock location)")


def detect_impossible_travel(checkins: list[Checkin], result: SweepResult):
    by_worker = defaultdict(list)
    for c in checkins:
        if c.lat is not None and c.lng is not None:
            by_worker[c.worker_id].append(c)
    for worker_id, items in by_worker.items():
        items.sort(key=lambda c: c.timestamp)
        for prev, cur in zip(items, items[1:]):
            hours = (cur.timestamp - prev.timestamp) / 3600
            if hours <= 0:
                continue
            kmh = haversine_m(prev.lat, prev.lng, cur.lat, cur.lng) / 1000 / hours
            if kmh > IMPOSSIBLE_SPEED_KMH:
                result.add(worker_id, cur.log_date, f"Impossible travel since {prev.log_date}: {kmh:.0f} km/h")


def detect_phone_farms(checkins: list[Checkin], result: SweepResult):
    """Several workers checking in from the same spot within seconds = one phone, many SIMs."""
    located = sorted((c for c in checkins if c.lat is not None and c.lng is not None), key=lambda c: c.timestamp)
    for i, anchor in enumerate(located):
        group = {anchor.worker_id: anchor}
        for other in located[i + 1:]:
            if other.timestamp - anchor.timestamp > FARM_WINDOW_S:
                break
            if other.worker_id not in group and haversine_m(anchor.lat, anchor.lng, other.lat, other.lng) <= FARM_RADIUS_M:
                group[other.worker_id] = other
        if len(group) >= FARM_MIN_WORKERS:
            ids = sorted(group)
            for c in group.values():
                peers = ", ".join(w for w in ids if w != c.worker_id)
                result.add(c.worker_id, c.log_date,
                           f"Checked in with {len(ids) - 1} other workers at the same spot within {FARM_WINDOW_S}s ({peers})")


def detect_shared_faces(face_embeddings: dict[str, np.ndarray], latest_log: dict[str, str], result: SweepResult):
    """One person registered under several numbers: different worker IDs, same face."""
    ids = sorted(face_embeddings)
    if len(ids) < 2:
        return
    matrix = np.stack([face_embeddings[w] / (np.linalg.norm(face_embeddings[w]) + 1e-9) for w in ids])
    sims = matrix @ matrix.T
    for a in range(len(ids)):
        for b in range(a + 1, len(ids)):
            if sims[a, b] >= FACE_SAME_PERSON_COSINE:
                for me, other in ((ids[a], ids[b]), (ids[b], ids[a])):
                    if me in latest_log:
                        result.add(me, latest_log[me], f"Face matches another worker ({other}, cosine {sims[a, b]:.2f})")


def sweep(checkins: list[Checkin], face_embeddings: dict[str, np.ndarray] | None = None) -> SweepResult:
    result = SweepResult()
    detect_static_gps(checkins, result)
    detect_impossible_travel(checkins, result)
    detect_phone_farms(checkins, result)
    if face_embeddings:
        latest = {}
        for c in sorted(checkins, key=lambda c: c.timestamp):
            latest[c.worker_id] = c.log_date
        detect_shared_faces(face_embeddings, latest, result)
    return result
