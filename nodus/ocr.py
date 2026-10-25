"""
Document OCR with RapidOCR (PaddleOCR models on ONNX Runtime, CPU).

Reads Aadhaar cards and bank passbooks far better than Tesseract: it finds each line of text
wherever it sits, and corrects sideways or upside-down lines itself. The image stays on this
server; nothing is sent to a third party.
"""

from __future__ import annotations

import io
import threading

import numpy as np
from PIL import Image, ImageOps

MAX_SIDE = 1600   # larger photos are scaled down; phone cameras give 4000 px we do not need

_engine = None
# One engine shared by the bridge's request threads, used one image at a time
_lock = threading.Lock()


def available() -> bool:
    """Whether RapidOCR is installed (the bridge still serves faces without it)."""
    import importlib.util
    return importlib.util.find_spec("rapidocr_onnxruntime") is not None


def _get_engine():
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _engine = RapidOCR()
    return _engine


def _load(image_bytes: bytes) -> np.ndarray:
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes))).convert("RGB")
    scale = MAX_SIDE / max(img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    return np.asarray(img)[:, :, ::-1]  # RapidOCR takes BGR, like OpenCV


def read_text(image_bytes: bytes) -> dict:
    """
    returns {"lines": [{"text", "score"}], "text": "line\\nline", "confidence": 0-100}
    Lines come back top to bottom by position in the photo; confidence is the mean line score.
    """
    image = _load(image_bytes)
    with _lock:
        result, _ = _get_engine()(image)
    lines = [{"text": str(text).strip(), "score": round(float(score), 3)} for _, text, score in (result or []) if str(text).strip()]
    confidence = round(100 * sum(l["score"] for l in lines) / len(lines), 1) if lines else 0.0
    return {"lines": lines, "text": "\n".join(l["text"] for l in lines), "confidence": confidence}
