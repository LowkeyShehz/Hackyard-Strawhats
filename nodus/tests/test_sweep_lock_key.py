"""sweep.py takes the same Postgres advisory lock as src/utils/postgres.js for a row."""

import json
import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import sweep  # noqa: E402

ROWS = [
    ("NirmanMitra-AttendanceLogs-dev", "DEMO-FRAUD-FARM-1", "2026-10-24"),
    ("t", 'quote"and\\slash', "ಕನ್ನಡ"),
]


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
@pytest.mark.parametrize("row", ROWS)
def test_lock_key_matches_the_node_backend(row):
    # JSON.stringify([tbl, pk, sk]) in Node, as postgres.js computes it
    js = subprocess.run(
        ["node", "-e", "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1])))", json.dumps(list(row))],
        capture_output=True, encoding="utf-8", check=True,
    ).stdout
    assert sweep.lock_key(*row) == js
