"""
Daily officer digest (Agent37 scheduled task, 19:00 IST).

Builds a markdown digest from /api/agent/daily-stats and /api/agent/fraud-flags, written by the
Nodus LLM (template fallback), saves it to outputs/digest-<date>.md and prints it. The Agent37
agent then emails or posts it through its Gmail / Slack (Composio) integration; set
SLACK_WEBHOOK_URL to post directly instead.

  python digest.py [YYYY-MM-DD]
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

from nirman_client import api, llm

SYSTEM = """You write a short end-of-day digest for a construction welfare board officer.
Use only the numbers and flags given. Markdown, under 200 words:
1. one-line headline (check-ins, verified, waiting for review)
2. "Needs your attention": the fraud flags grouped by pattern (phone farm, near-duplicate selfie,
   mock GPS, impossible travel, shared face), with worker IDs
3. "Sites": one line per site
4. "Coming up": workers close to their certificate
No greetings, no speculation."""


def ist_today():
    return (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).date().isoformat()


def template_digest(stats, flags):
    s = stats["by_status"]
    verified = s.get("auto_approved", 0) + s.get("approved", 0)
    lines = [
        f"# Nirman Mitra: {stats['date']}",
        f"**{stats['checkins']} check-ins**: {verified} verified, {s.get('pending_review', 0)} waiting for review, "
        f"{s.get('rejected', 0)} rejected.",
        "",
        "## Needs your attention",
    ]
    lines += [f"- `{f['worker_id']}` ({f['log_date']}): {'; '.join(f['fraud_flags']) or f['flagged_reason']}"
              for f in flags["items"][:15]] or ["- No fraud flags today."]
    lines += ["", "## Sites"]
    lines += [f"- {x['site_name']}: {x['checkins']} check-ins, {x['flagged']} flagged" for x in stats["sites"]] or ["- No check-ins."]
    lines += ["", "## Coming up",
              f"- {stats['workers_near_certificate']} workers are within 5 days of their {stats['certificate_threshold']}-day certificate."]
    return "\n".join(lines)


def build_digest(date):
    stats = api("GET", "/api/agent/daily-stats", query={"date": date})
    flags = api("GET", "/api/agent/fraud-flags", query={"days": 1})
    try:
        body = llm(SYSTEM, json.dumps({"stats": stats, "fraud_flags": flags["items"][:30]}), max_tokens=1200)
        return body.strip() + "\n\n_Written by the Agent37 ops agent._"
    except Exception as err:  # noqa: BLE001 - fall back to the template
        print(f"LLM unavailable ({err}); using template", file=sys.stderr)
        return template_digest(stats, flags)


def post_to_slack(text):
    url = os.environ.get("SLACK_WEBHOOK_URL")
    if not url:
        return
    req = urllib.request.Request(url, data=json.dumps({"text": text}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=15).read()


def main(date=None):
    date = date or ist_today()
    digest = build_digest(date)
    os.makedirs("outputs", exist_ok=True)
    path = os.path.join("outputs", f"digest-{date}.md")
    with open(path, "w") as f:
        f.write(digest)
    post_to_slack(digest)
    print(digest)
    print(f"\nSaved {path}", file=sys.stderr)
    return path


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else None)
