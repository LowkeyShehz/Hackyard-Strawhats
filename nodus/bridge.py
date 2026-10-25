"""
Face + fraud service for the Node.js backend (runs on Render).

    POST /face-embed       {"image_b64"}                          -> enrolment embedding (replaces Rekognition IndexFaces)
    POST /face-match       {"image_b64", "enrolled_embedding"}    -> 0-100 match score (replaces Rekognition CompareFaces)
    POST /analyze-selfie   {"image_b64", "history"}               -> near-duplicate / recapture fraud signals
    GET  /health

Backend (FRAUD_BACKEND):
  local  the models run in this process on CPU (OpenCV SFace + pHash + recapture). Works today.
  nodus  the same functions run on Nodus Compute (adds DINOv2 near-duplicates on GPU); any Nodus
         failure falls back to local, so a Nodus outage never breaks check-ins.
  unset  nodus when NODUS_API_KEY is set, else local. Adding the key is the whole switch-over.

Both backends use the same SFace model, so embeddings stored before the switch stay valid.

Auth: every request must carry `Authorization: Bearer $FRAUD_SERVICE_TOKEN`.
Run:  uvicorn bridge:app --host 0.0.0.0 --port 8080   (from the nodus/ directory)
"""

import base64
import hmac
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

TOKEN = os.environ.get("FRAUD_SERVICE_TOKEN", "")
MAX_IMAGE_B64 = 8 * 1024 * 1024


def _backend() -> str:
    explicit = os.environ.get("FRAUD_BACKEND", "").strip().lower()
    if os.environ.get("FRAUD_LOCAL") == "1":
        return "local"
    if explicit in ("local", "nodus"):
        return explicit
    return "nodus" if os.environ.get("NODUS_API_KEY") else "local"


BACKEND = _backend()
log = logging.getLogger("bridge")
_remote = {}


@asynccontextmanager
async def _lifespan(_app):
    # Load the face models before the first check-in arrives
    try:
        from face import _models
        _models()
    except Exception as err:  # noqa: BLE001
        log.warning("Face models not loaded at startup: %s", err)
    yield


app = FastAPI(title="nirman-fraud-bridge", lifespan=_lifespan)


class ImageRequest(BaseModel):
    image_b64: str


class MatchRequest(BaseModel):
    image_b64: str
    enrolled_embedding: list[float] | str   # floats, or base64 float16 as /face-embed returns


class SelfieRequest(BaseModel):
    image_b64: str
    history: list = []


def _check(authorization: str | None, image_b64: str):
    if not TOKEN:
        raise HTTPException(503, "FRAUD_SERVICE_TOKEN is not configured")
    supplied = (authorization or "").removeprefix("Bearer ")
    if not hmac.compare_digest(supplied, TOKEN):
        raise HTTPException(401, "unauthorized")
    if len(image_b64) > MAX_IMAGE_B64:
        raise HTTPException(413, "image too large")


def _on_nodus(name: str, local, *args):
    """Run a Nodus function, or the local implementation (also the fallback when Nodus fails)."""
    if BACKEND == "nodus":
        try:
            if name not in _remote:
                import nodus
                _remote[name] = nodus.Function.from_name("nirman-fraud", name)
            result = _remote[name].remote(*args)
            return {**result, "backend": "nodus"}
        except Exception as err:  # noqa: BLE001 - never fail a check-in because Nodus is down
            log.warning("Nodus %s failed, running locally: %s", name, err)
    return {**local(*args), "backend": "local"}


def _local_embed(image_b64):
    from face import embed_face
    return embed_face(base64.b64decode(image_b64))


def _local_analyze(image_b64, history):
    from fraud_core import analyze_selfie
    return analyze_selfie(base64.b64decode(image_b64), history, use_models=True, image_embeddings=False)


@app.get("/health")
def health():
    return {"ok": True, "backend": BACKEND}


def _with_b64(result: dict) -> dict:
    """Add the compact base64 float16 form the backend stores (fraud_core.encode_vector)."""
    from fraud_core import encode_vector
    emb = result.get("embedding")
    return {**result, "embedding_b64": encode_vector(emb) if emb is not None else None}


@app.post("/face-embed")
def face_embed(req: ImageRequest, authorization: str | None = Header(default=None)):
    _check(authorization, req.image_b64)
    return _with_b64(_on_nodus("embed_face", _local_embed, req.image_b64))


@app.post("/face-match")
def face_match(req: MatchRequest, authorization: str | None = Header(default=None)):
    _check(authorization, req.image_b64)
    from face import match_with_embedding
    from fraud_core import decode_vector
    enrolled = req.enrolled_embedding
    if isinstance(enrolled, str):
        enrolled = decode_vector(enrolled).tolist()
    current = _on_nodus("embed_face", _local_embed, req.image_b64)
    return {**match_with_embedding(enrolled, current), "backend": current["backend"]}


@app.post("/analyze-selfie")
def analyze_selfie(req: SelfieRequest, authorization: str | None = Header(default=None)):
    _check(authorization, req.image_b64)
    return _on_nodus("analyze_selfie", _local_analyze, req.image_b64, req.history[-30:])
