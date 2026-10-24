"""Pure-logic tests for the fraud detectors (no GPU models needed)."""

import io
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import fraud_core as fc  # noqa: E402

DAY = 86400
T0 = 1_761_300_000  # 2025-10-24


def selfie(seed: int) -> bytes:
    rng = np.random.default_rng(seed)
    img = Image.fromarray((rng.random((64, 64, 3)) * 255).astype("uint8")).resize((480, 640))
    draw = ImageDraw.Draw(img)
    draw.ellipse((140, 160, 340, 420), fill=(200, 160, 130))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def recompress(data: bytes, quality: int) -> bytes:
    buf = io.BytesIO()
    Image.open(io.BytesIO(data)).save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def test_resent_selfie_is_a_near_duplicate_but_a_new_one_is_not():
    first = fc.analyze_selfie(selfie(1), [], use_models=False)
    history = [{"date": "2025-10-20", "phash": first["phash"]}]
    again = fc.analyze_selfie(recompress(selfie(1), 60), history, use_models=False)
    assert again["near_duplicate"]["date"] == "2025-10-20"
    assert any("Near-duplicate" in f for f in again["flags"])
    fresh = fc.analyze_selfie(selfie(2), history, use_models=False)
    assert fresh["near_duplicate"] is None


def test_embedding_match_flags_near_duplicate_even_when_phash_differs():
    vec = np.ones(384, dtype=np.float32)
    history = [{"date": "2025-10-21", "phash": "0" * 16, "embedding": fc.encode_vector(vec)}]
    dup = fc.find_near_duplicate("f" * 16, vec * 1.01, history)
    assert dup and "embedding cosine" in dup["reasons"][0]


def test_vector_round_trip_is_close():
    vec = np.random.default_rng(0).standard_normal(512).astype(np.float32)
    assert fc.cosine(vec, fc.decode_vector(fc.encode_vector(vec))) > 0.999


def test_identical_gps_fix_on_three_days_is_flagged():
    checkins = [fc.Checkin("W1", f"2025-10-2{d}", T0 + d * DAY, gps_hash="same") for d in range(3)]
    checkins.append(fc.Checkin("W2", "2025-10-20", T0, gps_hash="a"))
    flags = fc.sweep(checkins).flags
    assert len([k for k in flags if k[0] == "W1"]) == 3
    assert ("W2", "2025-10-20") not in flags


def test_impossible_travel_is_flagged():
    checkins = [
        fc.Checkin("W1", "2025-10-20", T0, lat=12.9716, lng=77.5946),      # Bengaluru
        fc.Checkin("W1", "2025-10-21", T0 + 3600, lat=28.6139, lng=77.2090),  # Delhi, one hour later
    ]
    flags = fc.sweep(checkins).flags
    assert "Impossible travel" in flags[("W1", "2025-10-21")][0]


def test_four_workers_at_one_spot_within_a_minute_is_a_phone_farm():
    farm = [fc.Checkin(f"W{i}", "2025-10-24", T0 + i * 15, lat=12.97160, lng=77.59460 + i * 0.00002) for i in range(4)]
    honest = fc.Checkin("W9", "2025-10-24", T0 + 30, lat=12.9800, lng=77.6000)  # ~1.2 km away
    flags = fc.sweep(farm + [honest]).flags
    for i in range(4):
        assert "3 other workers" in flags[(f"W{i}", "2025-10-24")][0]
    assert ("W9", "2025-10-24") not in flags


def test_same_face_under_two_worker_ids_is_flagged():
    rng = np.random.default_rng(3)
    face = rng.standard_normal(512)
    faces = {"W1": face, "W2": face + rng.normal(0, 0.05, 512), "W3": rng.standard_normal(512)}
    checkins = [fc.Checkin(w, "2025-10-24", T0) for w in faces]
    flags = fc.sweep(checkins, faces).flags
    assert "W2" in flags[("W1", "2025-10-24")][0]
    assert "W1" in flags[("W2", "2025-10-24")][0]
    assert ("W3", "2025-10-24") not in flags


def test_recapture_score_is_bounded():
    score = fc.recapture_score(Image.open(io.BytesIO(selfie(4))).convert("RGB"))
    assert 0.0 <= score <= 1.0
