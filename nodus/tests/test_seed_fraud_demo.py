"""The fraud demo seed (scripts/seed-fraud-demo.mjs) trips each sweep detector, and nothing else.

Fails when a threshold change in fraud_core.py stops a demo scenario from being flagged.
"""

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import fraud_core as fc  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
SEED_SCRIPT = os.path.join(ROOT, "scripts", "seed-fraud-demo.mjs")

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="needs node to build the seed")

EXPECTED_REASON = {
    "farm": "other workers at the same spot",
    "static": "Identical GPS fix on 3 different days",
    "travel": "Impossible travel",
    "face": "Face matches another worker",
}


def seed():
    out = subprocess.run(["node", SEED_SCRIPT, "--json"], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def as_checkin(log) -> fc.Checkin:
    # Same mapping as sweep.to_checkin (which needs boto3 to import)
    ts = datetime.fromisoformat(log["timestamp"].replace("Z", "+00:00")).timestamp()
    return fc.Checkin(
        worker_id=log["worker_id"], log_date=log["log_date"], timestamp=ts,
        lat=log["gps_cell"]["lat"], lng=log["gps_cell"]["lng"],
        gps_hash=log["gps_hash"], site_id=log["site_id"],
    )


def test_sweep_flags_exactly_the_seeded_scenarios():
    data = seed()
    logs = sorted(data["logs"], key=lambda l: l["timestamp"])
    faces = {w["worker_id"]: fc.decode_vector(w["face_embedding"]) for w in data["workers"] if w.get("face_embedding")}

    result = fc.sweep([as_checkin(l) for l in logs], faces)

    # The first leg of the impossible trip is the genuine check-in; only the second is flagged
    travel = [l for l in logs if l["demo_scenario"] == "travel"]
    expected = {(l["worker_id"], l["log_date"]): l["demo_scenario"] for l in logs if l is not travel[0]}
    assert set(result.flags) == set(expected)
    assert len(expected) == 10

    # Each log is flagged only by its own scenario's detector (a farm member can carry more than
    # one farm reason: detect_phone_farms reports the group from each anchor check-in)
    for key, scenario in expected.items():
        reasons = result.flags[key]
        assert all(EXPECTED_REASON[scenario] in r for r in reasons), (key, reasons)
