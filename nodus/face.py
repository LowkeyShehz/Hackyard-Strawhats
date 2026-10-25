"""
Face detection and matching with OpenCV's YuNet + SFace models (Apache-2.0, ~38 MB, CPU only).

Replaces Amazon Rekognition: registration stores an SFace embedding of the enrolled selfie, and
each check-in is scored by cosine similarity against it. The same models run on the Render bridge
today and in the Nodus function later, so stored embeddings stay valid when the work moves to
Nodus.
"""

from __future__ import annotations

import os
import urllib.request

import numpy as np

MODEL_DIR = os.environ.get("FACE_MODEL_DIR", os.path.join(os.path.dirname(__file__), "models"))
MODELS = {
    "yunet.onnx": "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "sface.onnx": "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}

# SFace cosine -> 0-100 score on the scale the attendance routing expects (Rekognition-like:
# >= 80 clean, 60-80 review, < 30 reject). OpenCV's suggested same-person threshold is 0.363,
# which maps to 80. Calibrate with real selfies.
SCORE_POINTS = [(0.10, 0.0), (0.20, 30.0), (0.30, 60.0), (0.363, 80.0), (0.50, 95.0), (0.70, 100.0)]
MIN_FACE_SCORE = 0.8          # YuNet detection confidence
MIN_SHARPNESS = 30.0          # 0-100, variance of the Laplacian on the face crop
MIN_BRIGHTNESS, MAX_BRIGHTNESS = 20.0, 90.0

_detector = None
_recognizer = None


def ensure_models() -> None:
    os.makedirs(MODEL_DIR, exist_ok=True)
    for name, url in MODELS.items():
        path = os.path.join(MODEL_DIR, name)
        if not os.path.exists(path) or os.path.getsize(path) < 100_000:
            urllib.request.urlretrieve(url, path)


def _models():
    global _detector, _recognizer
    import cv2
    if _detector is None:
        ensure_models()
        _detector = cv2.FaceDetectorYN.create(os.path.join(MODEL_DIR, "yunet.onnx"), "", (320, 320), MIN_FACE_SCORE)
        _recognizer = cv2.FaceRecognizerSF.create(os.path.join(MODEL_DIR, "sface.onnx"), "")
    return _detector, _recognizer


def _decode(image_bytes: bytes):
    import cv2
    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("not an image")
    # Phone selfies are large; detection is faster and as accurate at ~1000 px
    scale = 1000 / max(img.shape[:2])
    if scale < 1:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    return img


def _quality(img, box) -> dict:
    import cv2
    x, y, w, h = (max(0, int(v)) for v in box[:4])
    crop = cv2.cvtColor(img[y:y + h, x:x + w], cv2.COLOR_BGR2GRAY)
    if crop.size == 0:
        return {"sharpness": 0.0, "brightness": 0.0}
    sharp = float(cv2.Laplacian(crop, cv2.CV_64F).var())
    return {
        "sharpness": round(min(100.0, sharp / 5.0), 1),   # ~500 Laplacian variance = crisp
        "brightness": round(float(crop.mean()) / 255 * 100, 1),
    }


def embed_face(image_bytes: bytes) -> dict:
    """
    Detect faces and embed the largest one.
    returns {"faces": n, "embedding": [128 floats] | None, "quality": {...} | None,
             "problem": None | "no_face" | "multiple_faces" | "low_quality"}
    """
    detector, recognizer = _models()
    img = _decode(image_bytes)
    detector.setInputSize((img.shape[1], img.shape[0]))
    _, faces = detector.detect(img)
    faces = [] if faces is None else list(faces)
    if not faces:
        return {"faces": 0, "embedding": None, "quality": None, "problem": "no_face"}

    faces.sort(key=lambda f: f[2] * f[3], reverse=True)
    largest = faces[0]
    # A second face at least half the size of the main one is a real second person
    others = [f for f in faces[1:] if f[2] * f[3] >= 0.5 * largest[2] * largest[3]]
    quality = _quality(img, largest)
    aligned = recognizer.alignCrop(img, largest)
    embedding = recognizer.feature(aligned).flatten().astype(np.float32)
    embedding /= np.linalg.norm(embedding) + 1e-9

    problem = None
    if others:
        problem = "multiple_faces"
    elif quality["sharpness"] < MIN_SHARPNESS or not (MIN_BRIGHTNESS <= quality["brightness"] <= MAX_BRIGHTNESS):
        problem = "low_quality"
    return {"faces": 1 + len(others), "embedding": embedding.tolist(), "quality": quality, "problem": problem}


def similarity_score(cos: float) -> float:
    """Piecewise-linear map of SFace cosine similarity to a 0-100 match score."""
    if cos <= SCORE_POINTS[0][0]:
        return 0.0
    for (x0, y0), (x1, y1) in zip(SCORE_POINTS, SCORE_POINTS[1:]):
        if cos <= x1:
            return round(y0 + (cos - x0) * (y1 - y0) / (x1 - x0), 1)
    return 100.0


def match_with_embedding(enrolled: list[float], current: dict) -> dict:
    """
    Score an embed_face() result against the enrolled embedding.
    returns {"face_found": bool, "similarity": 0-100, "cosine": float, "faces": n, "quality": {...}}
    """
    if current.get("embedding") is None:
        return {"face_found": False, "similarity": 0.0, "cosine": None, "faces": 0, "quality": None}
    a = np.asarray(enrolled, dtype=np.float32)
    b = np.asarray(current["embedding"], dtype=np.float32)
    cos = float(np.dot(a, b) / ((np.linalg.norm(a) * np.linalg.norm(b)) + 1e-9))
    return {
        "face_found": True,
        "similarity": similarity_score(cos),
        "cosine": round(cos, 4),
        "faces": current["faces"],
        "quality": current["quality"],
    }


def match_face(enrolled: list[float], image_bytes: bytes) -> dict:
    """Compare a check-in selfie with the enrolled embedding (see match_with_embedding)."""
    return match_with_embedding(enrolled, embed_face(image_bytes))
