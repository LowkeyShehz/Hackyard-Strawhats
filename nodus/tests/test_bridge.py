"""Face + fraud bridge: auth, backend selection (local now, Nodus once a key is set) and the
fallback to local when Nodus fails. The face model itself is faked here; test_face_models.py
runs the real one when the models are downloaded."""

import base64
import importlib
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from fastapi.testclient import TestClient  # noqa: E402

EMB = [0.1] * 128
AUTH = {"Authorization": "Bearer tok"}
IMG = base64.b64encode(b"jpeg").decode()


def load_bridge(monkeypatch, **env):
    for key in ("FRAUD_BACKEND", "FRAUD_LOCAL", "NODUS_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("FRAUD_SERVICE_TOKEN", "tok")
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    import face
    monkeypatch.setattr(face, "_models", lambda: None)
    monkeypatch.setattr(face, "embed_face", lambda data: {"faces": 1, "embedding": EMB, "quality": {"sharpness": 80, "brightness": 50}, "problem": None})
    import bridge
    return importlib.reload(bridge)


def test_backend_is_local_without_a_nodus_key_and_nodus_with_one(monkeypatch):
    assert load_bridge(monkeypatch).BACKEND == "local"
    assert load_bridge(monkeypatch, NODUS_API_KEY="nk").BACKEND == "nodus"
    assert load_bridge(monkeypatch, NODUS_API_KEY="nk", FRAUD_BACKEND="local").BACKEND == "local"


def test_requests_need_the_token(monkeypatch):
    client = TestClient(load_bridge(monkeypatch).app)
    assert client.post("/face-embed", json={"image_b64": IMG}).status_code == 401
    assert client.post("/face-embed", json={"image_b64": IMG}, headers={"Authorization": "Bearer no"}).status_code == 401


def test_local_embed_and_match_round_trip(monkeypatch):
    client = TestClient(load_bridge(monkeypatch).app)
    enrolled = client.post("/face-embed", json={"image_b64": IMG}, headers=AUTH).json()
    assert enrolled["backend"] == "local" and enrolled["problem"] is None
    assert isinstance(enrolled["embedding_b64"], str)
    match = client.post("/face-match", json={"image_b64": IMG, "enrolled_embedding": enrolled["embedding_b64"]}, headers=AUTH).json()
    assert match["face_found"] is True and match["similarity"] == 100.0 and match["backend"] == "local"


def test_nodus_failure_falls_back_to_local(monkeypatch):
    bridge = load_bridge(monkeypatch, NODUS_API_KEY="nk")

    class Broken:
        def remote(self, *args):
            raise RuntimeError("no credits")

    monkeypatch.setitem(sys.modules, "nodus", types.SimpleNamespace(Function=types.SimpleNamespace(from_name=lambda app, fn: Broken())))
    out = TestClient(bridge.app).post("/face-embed", json={"image_b64": IMG}, headers=AUTH).json()
    assert out["backend"] == "local" and out["embedding_b64"]


def test_nodus_result_is_used_when_it_works(monkeypatch):
    bridge = load_bridge(monkeypatch, NODUS_API_KEY="nk")

    class Works:
        def remote(self, *args):
            return {"faces": 1, "embedding": EMB, "quality": None, "problem": None}

    monkeypatch.setitem(sys.modules, "nodus", types.SimpleNamespace(Function=types.SimpleNamespace(from_name=lambda app, fn: Works())))
    out = TestClient(bridge.app).post("/face-embed", json={"image_b64": IMG}, headers=AUTH).json()
    assert out["backend"] == "nodus"


def test_similarity_score_mapping():
    import face
    assert face.similarity_score(0.05) == 0.0
    assert face.similarity_score(0.363) == 80.0
    assert face.similarity_score(0.30) == 60.0
    assert face.similarity_score(0.9) == 100.0
    with pytest.raises(Exception):
        face._decode(b"not an image")
