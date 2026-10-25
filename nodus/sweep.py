"""
Nightly fraud sweep (Nodus Job).

Reads recent check-ins and enrolled face embeddings, runs the batch detectors in
fraud_core.sweep, writes `fraud_flags` onto each affected attendance log, and saves a report to
$NODUS_OUTPUTS_DIR/report.json.

Data source: Postgres when DATABASE_URL is set (the app on Render with DB_BACKEND=postgres: rows
of the `items` table, see src/utils/postgres.js), DynamoDB otherwise.

Environment:
  DATABASE_URL                                           (Nodus secret "nirman-db"), or
  AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   (Nodus secret "nirman-aws")
  ATTENDANCE_TABLE, WORKERS_TABLE
  SWEEP_DAYS      days of check-ins to scan (default 14)
  SWEEP_DRY_RUN   "1" = report only, write nothing
"""

import json
import os
import time
from datetime import datetime, timedelta, timezone

from fraud_core import Checkin, decode_vector, sweep

REGION = os.environ.get("AWS_REGION", "ap-south-1")
ATTENDANCE_TABLE = os.environ.get("ATTENDANCE_TABLE", "NirmanMitra-AttendanceLogs-dev")
WORKERS_TABLE = os.environ.get("WORKERS_TABLE", "NirmanMitra-Workers-dev")
DAYS = int(os.environ.get("SWEEP_DAYS", "14"))
DRY_RUN = os.environ.get("SWEEP_DRY_RUN") == "1"
DATABASE_URL = os.environ.get("DATABASE_URL", "")
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


def lock_key(tbl: str, pk: str, sk: str) -> str:
    """The advisory-lock key src/utils/postgres.js takes for a row: JSON.stringify([tbl, pk, sk])"""
    return json.dumps([tbl, pk, sk], separators=(",", ":"), ensure_ascii=False)


class DynamoStore:
    def __init__(self):
        import boto3
        from boto3.dynamodb.conditions import Attr

        self.attr = Attr
        ddb = boto3.resource("dynamodb", region_name=REGION)
        self.attendance = ddb.Table(ATTENDANCE_TABLE)
        self.workers = ddb.Table(WORKERS_TABLE)

    def logs_since(self, since):
        return scan_all(self.attendance, FilterExpression=self.attr("log_date").gte(since))

    def workers_with_faces(self):
        return scan_all(self.workers, ProjectionExpression="worker_id, face_embedding")

    def write_flags(self, worker_id, log_date, reasons, swept_at):
        self.attendance.update_item(
            Key={"worker_id": worker_id, "log_date": log_date},
            UpdateExpression="SET fraud_flags = :f, fraud_swept_at = :t",
            ConditionExpression="attribute_exists(worker_id)",
            ExpressionAttributeValues={":f": reasons, ":t": swept_at},
        )


class PostgresStore:
    def __init__(self, url):
        import psycopg

        self.conn = psycopg.connect(url)

    def logs_since(self, since):
        rows = self.conn.execute(
            "SELECT data FROM items WHERE tbl = %s AND data->>'log_date' >= %s", (ATTENDANCE_TABLE, since)
        )
        return [r[0] for r in rows]

    def workers_with_faces(self):
        rows = self.conn.execute("SELECT data FROM items WHERE tbl = %s AND data ? 'face_embedding'", (WORKERS_TABLE,))
        return [r[0] for r in rows]

    def write_flags(self, worker_id, log_date, reasons, swept_at):
        # Same per-row advisory lock as the app's writes, so a concurrent check-in update and the
        # flags cannot overwrite each other
        with self.conn.transaction():
            self.conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (lock_key(ATTENDANCE_TABLE, worker_id, log_date),),
            )
            self.conn.execute(
                "UPDATE items SET data = data || jsonb_build_object('fraud_flags', %s::jsonb, 'fraud_swept_at', %s::text) "
                "WHERE tbl = %s AND pk = %s AND sk = %s",
                (json.dumps(reasons, ensure_ascii=False), swept_at, ATTENDANCE_TABLE, worker_id, log_date),
            )


def main():
    started = time.time()
    store = PostgresStore(DATABASE_URL) if DATABASE_URL else DynamoStore()

    since = (datetime.now(timezone.utc) - timedelta(days=DAYS)).date().isoformat()
    logs = store.logs_since(since)
    checkins = [to_checkin(i) for i in logs]

    faces = {
        w["worker_id"]: decode_vector(w["face_embedding"])
        for w in store.workers_with_faces()
        if w.get("face_embedding")
    }

    result = sweep(checkins, faces)

    written = 0
    if not DRY_RUN:
        swept_at = datetime.now(timezone.utc).isoformat()
        for (worker_id, log_date), reasons in result.flags.items():
            store.write_flags(worker_id, log_date, reasons, swept_at)
            written += 1

    report = {
        "scanned_checkins": len(checkins),
        "workers_with_faces": len(faces),
        "flagged_logs": len(result.flags),
        "written": written,
        "dry_run": DRY_RUN,
        "source": "postgres" if DATABASE_URL else "dynamodb",
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
