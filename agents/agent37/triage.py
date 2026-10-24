"""
Review-queue triage (Agent37 scheduled task, every 30 minutes).

For each pending check-in without a triage note: ask the Nodus LLM for a recommendation, falling
back to rules when the LLM is unavailable, and post it as a note. Notes are recommendations only;
the officer still approves or rejects in the dashboard.

  python triage.py            # triage and post notes
  python triage.py --dry-run  # print what would be posted
"""

import json
import sys
from urllib.parse import quote

from nirman_client import api, llm

SYSTEM = """You help a welfare board officer triage construction-worker attendance check-ins that
automatic verification could not approve. Each check-in has face, GPS and voice confidence
(0-100), flags from verification, and fraud flags from a nightly Nodus Compute sweep.

Recommend exactly one of:
  "approve"     - the flags are minor or explained (e.g. near the geofence edge, typed instead of spoken)
  "reject"      - strong fraud evidence (near-duplicate selfie, phone farm, mock GPS, impossible travel,
                  face of another worker, passcode failure)
  "needs_human" - mixed or unclear evidence

Write a note of at most two short sentences an officer can read in five seconds, naming the
evidence. Never invent facts that are not in the data. Reply as JSON:
{"recommendation": "...", "note": "...", "confidence": 0-100}"""

STRONG_FRAUD = ("near-duplicate", "other workers at the same spot", "identical gps fix",
                "impossible travel", "face matches another worker", "passcode", "photo of a screen")


def rule_based_triage(item):
    """Deterministic fallback when the LLM is unavailable."""
    reasons = " | ".join([item.get("flagged_reason") or "", *item.get("fraud_flags", [])]).lower()
    hits = [k for k in STRONG_FRAUD if k in reasons]
    if hits:
        return {"recommendation": "reject", "confidence": 70,
                "note": f"Fraud evidence: {', '.join(hits)}. Recommend reject after a quick look."}
    face, geo = item.get("face_confidence") or 0, item.get("geo_confidence") or 0
    if face >= 80 and geo >= 60:
        return {"recommendation": "approve", "confidence": 60,
                "note": f"Face {face}% and GPS {geo}% look fine; flags are minor ({reasons or 'none'})."}
    return {"recommendation": "needs_human", "confidence": 40,
            "note": f"Mixed signals: face {face}%, GPS {geo}%. Needs an officer's judgement."}


def parse_recommendation(text):
    data = json.loads(text.strip().removeprefix("```json").removesuffix("```").strip())
    if data.get("recommendation") not in ("approve", "reject", "needs_human") or not data.get("note"):
        raise ValueError(f"unusable recommendation: {text[:200]}")
    data["confidence"] = max(0, min(100, int(data.get("confidence") or 0)))
    return data


def triage_item(item):
    facts = {k: item.get(k) for k in (
        "log_date", "site_name", "confidence", "face_confidence", "geo_confidence", "voice_confidence",
        "voice_activity", "flagged_reason", "fraud_flags", "fraud_signals", "is_off_hours", "total_days_logged")}
    try:
        result = parse_recommendation(llm(SYSTEM, json.dumps(facts), json_mode=True, max_tokens=900))
        result["note"] = "[Nodus LLM] " + result["note"]
        return result
    except Exception as err:  # noqa: BLE001 - any LLM failure falls back to rules
        print(f"  LLM unavailable ({err}); using rules", file=sys.stderr)
        result = rule_based_triage(item)
        result["note"] = "[rules] " + result["note"]
        return result


def main(dry_run=False):
    queue = api("GET", "/api/agent/review-queue", query={"limit": 50})["items"]
    todo = [i for i in queue if not i.get("ai_triage")]
    print(f"{len(queue)} pending, {len(todo)} without triage")
    for item in todo:
        result = triage_item(item)
        print(f"- {item['log_id']}: {result['recommendation']} ({result['confidence']}) {result['note']}")
        if not dry_run:
            api("POST", f"/api/agent/review/{quote(item['log_id'], safe='')}/note", body=result)
    return len(todo)


if __name__ == "__main__":
    main(dry_run="--dry-run" in sys.argv)
