"""
HTTP bridge between the Node.js webhook and the Nodus functions.

Nodus functions are called from Python (`Function.from_name(...).remote()`), so this small service
exposes them over HTTPS for the Lambda backend:

    POST /analyze-selfie   {"image_b64": "...", "history": [...]}   ->  analyze_selfie result
    GET  /health

Auth: every request must carry `Authorization: Bearer $FRAUD_SERVICE_TOKEN`.
Run:  uvicorn bridge:app --host 0.0.0.0 --port 8080   (from the nodus/ directory)
Set FRAUD_LOCAL=1 to run the analysis in-process instead of on Nodus (CPU, for offline dev).
"""

import base64
import hmac
import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

TOKEN = os.environ.get("FRAUD_SERVICE_TOKEN", "")
LOCAL = os.environ.get("FRAUD_LOCAL") == "1"
MAX_IMAGE_B64 = 8 * 1024 * 1024

app = FastAPI(title="nirman-fraud-bridge")
_remote = None


class SelfieRequest(BaseModel):
    image_b64: str
    history: list = []


def _check_auth(authorization: str | None):
    if not TOKEN:
        raise HTTPException(503, "FRAUD_SERVICE_TOKEN is not configured")
    supplied = (authorization or "").removeprefix("Bearer ")
    if not hmac.compare_digest(supplied, TOKEN):
        raise HTTPException(401, "unauthorized")


def _analyze(image_b64: str, history: list) -> dict:
    global _remote
    if LOCAL:
        from fraud_core import analyze_selfie
        return analyze_selfie(base64.b64decode(image_b64), history)
    if _remote is None:
        import nodus
        _remote = nodus.Function.from_name("nirman-fraud", "analyze_selfie")
    return _remote.remote(image_b64, history)


@app.get("/health")
def health():
    return {"ok": True, "mode": "local" if LOCAL else "nodus"}


@app.post("/analyze-selfie")
def analyze_selfie(req: SelfieRequest, authorization: str | None = Header(default=None)):
    _check_auth(authorization)
    if len(req.image_b64) > MAX_IMAGE_B64:
        raise HTTPException(413, "image too large")
    return _analyze(req.image_b64, req.history[-30:])
