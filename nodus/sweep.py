"""
Nightly fraud sweep (Nodus Job).

Reads recent check-ins and enrolled face embeddings from DynamoDB, runs the batch detectors in
fraud_core.sweep, writes `fraud_flags` onto each affected attendance log, and saves a report to
$NODUS_OUTPUTS_DIR/report.json.

Environment:
  AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   (Nodus secret "nirman-aws")
  ATTENDANCE_TABLE, WORKERS_TABLE
  SWEEP_DAYS      days of check-ins to scan (default 14)
  SWEEP_DRY_RUN   "1" = report only, write nothing
"""

import json
import os
import time
from datetime import datetime, timedelta, timezone

import boto3
from boto3.dynamodb.conditions import Attr

from fraud_core import Checkin, decode_vector, sweep

REGION = os.environ.get("AWS_REGION", "ap-south-1")
ATTENDANCE_TABLE = os.environ.get("ATTENDANCE_TABLE", "NirmanMitra-AttendanceLogs-dev")
WORKERS_TABLE = os.environ.get("WORKERS_TABLE", "NirmanMitra-Workers-dev")
DAYS = int(os.environ.get("SWEEP_DAYS", "14"))
DRY_RUN = os.environ.get("SWEEP_DRY_RUN") == "1"
OUTPUTS = os.environ.get("NODUS_OUTPUTS_DIR", "./outputs")


def scan_all(table, **kwargs):
    items, start = [], None
    while True:
        page = table.scan(**kwargs, **({"ExclusiveStartKey": start} if start else {}))
        items.extend(page.get("Items", []))
        start = page.get("LastEvaluatedKey")
        if not start:
            return items


def to_checkin(item) -> Checkin:
    cell = item.get("gps_cell") or {}
    ts = item.get("timestamp") or item.get("created_at")
    epoch = datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() if ts else 0.0
    return Checkin(
        worker_id=item["worker_id"],
        log_date=item["log_date"],
        timestamp=epoch,
        lat=float(cell["lat"]) if "lat" in cell else None,
        lng=float(cell["lng"]) if "lng" in cell else None,
        gps_hash=item.get("gps_hash"),
        site_id=item.get("site_id"),
    )


def main():
    started = time.time()
    ddb = boto3.resource("dynamodb", region_name=REGION)
    attendance = ddb.Table(ATTENDANCE_TABLE)
    workers = ddb.Table(WORKERS_TABLE)

    since = (datetime.now(timezone.utc) - timedelta(days=DAYS)).date().isoformat()
    logs = scan_all(attendance, FilterExpression=Attr("log_date").gte(since))
    checkins = [to_checkin(i) for i in logs]

    faces = {
        w["worker_id"]: decode_vector(w["face_embedding"])
        for w in scan_all(workers, ProjectionExpression="worker_id, face_embedding")
        if w.get("face_embedding")
    }

    result = sweep(checkins, faces)

    written = 0
    if not DRY_RUN:
        for (worker_id, log_date), reasons in result.flags.items():
            attendance.update_item(
                Key={"worker_id": worker_id, "log_date": log_date},
                UpdateExpression="SET fraud_flags = :f, fraud_swept_at = :t",
                ConditionExpression="attribute_exists(worker_id)",
                ExpressionAttributeValues={":f": reasons, ":t": datetime.now(timezone.utc).isoformat()},
            )
            written += 1

    report = {
        "scanned_checkins": len(checkins),
        "workers_with_faces": len(faces),
        "flagged_logs": len(result.flags),
        "written": written,
        "dry_run": DRY_RUN,
        "since": since,
        "duration_s": round(time.time() - started, 2),
        "flags": [{"worker_id": w, "log_date": d, "reasons": r} for (w, d), r in sorted(result.flags.items())],
    }
    os.makedirs(OUTPUTS, exist_ok=True)
    with open(os.path.join(OUTPUTS, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({k: v for k, v in report.items() if k != "flags"}))


if __name__ == "__main__":
    main()
