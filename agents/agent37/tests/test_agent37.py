"""Agent37 triage and digest logic, with the backend and Nodus LLM faked."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import digest  # noqa: E402
import triage  # noqa: E402

FARM = {"log_id": "W1#2026-10-24", "face_confidence": 92, "geo_confidence": 95,
        "flagged_reason": None, "fraud_flags": ["Checked in with 3 other workers at the same spot within 90s (W2, W3, W4)"]}
EDGE = {"log_id": "W5#2026-10-24", "face_confidence": 91, "geo_confidence": 80,
        "flagged_reason": "GPS near boundary: 300m", "fraud_flags": []}
UNCLEAR = {"log_id": "W6#2026-10-24", "face_confidence": 65, "geo_confidence": 50,
           "flagged_reason": "Face confidence in review range: 65%", "fraud_flags": []}


def test_rules_reject_fraud_approve_minor_and_escalate_unclear():
    assert triage.rule_based_triage(FARM)["recommendation"] == "reject"
    assert triage.rule_based_triage(EDGE)["recommendation"] == "approve"
    assert triage.rule_based_triage(UNCLEAR)["recommendation"] == "needs_human"


def test_parse_recommendation_validates_and_clamps():
    out = triage.parse_recommendation('```json\n{"recommendation":"reject","note":"Phone farm.","confidence":140}\n```')
    assert out == {"recommendation": "reject", "note": "Phone farm.", "confidence": 100}
    with pytest.raises(ValueError):
        triage.parse_recommendation('{"recommendation":"approve_now","note":"x"}')


def test_triage_posts_llm_notes_and_falls_back_to_rules(monkeypatch):
    posted = []

    def fake_api(method, path, body=None, query=None):
        if method == "GET":
            return {"items": [FARM, {**EDGE, "ai_triage": {"recommendation": "approve"}}, UNCLEAR]}
        posted.append((path, body))
        return {}

    calls = iter(['{"recommendation":"reject","note":"Four workers at one spot within 40s.","confidence":88}'])

    def fake_llm(*args, **kwargs):
        try:
            return next(calls)
        except StopIteration:
            raise RuntimeError("Nodus 503")

    monkeypatch.setattr(triage, "api", fake_api)
    monkeypatch.setattr(triage, "llm", fake_llm)
    assert triage.main() == 2, "already-triaged item skipped"
    assert posted[0][0] == "/api/agent/review/W1%232026-10-24/note"
    assert posted[0][1]["note"].startswith("[AI] Four workers")
    assert posted[1][1]["recommendation"] == "needs_human"
    assert posted[1][1]["note"].startswith("[rules]")


def test_digest_template_fallback(monkeypatch, tmp_path):
    stats = {"date": "2026-10-24", "checkins": 12, "by_status": {"auto_approved": 9, "pending_review": 2, "rejected": 1},
             "sites": [{"site_name": "Metro", "checkins": 12, "flagged": 3}], "workers_near_certificate": 4,
             "certificate_threshold": 90}
    flags = {"items": [{"worker_id": "W1", "log_date": "2026-10-24", "fraud_flags": FARM["fraud_flags"], "flagged_reason": None}]}
    monkeypatch.setattr(digest, "api", lambda m, p, body=None, query=None: stats if "daily-stats" in p else flags)
    monkeypatch.setattr(digest, "llm", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.chdir(tmp_path)
    path = digest.main("2026-10-24")
    text = open(path).read()
    assert "**12 check-ins**: 9 verified, 2 waiting for review, 1 rejected." in text
    assert "`W1`" in text and "Metro: 12 check-ins, 3 flagged" in text
    assert "4 workers are within 5 days of their 90-day certificate" in text
