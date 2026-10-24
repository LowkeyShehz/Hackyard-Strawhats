"""
Nirman Mitra fraud functions on Nodus.

Deploy:   nodus deploy nodus/app.py
Call:     nodus.Function.from_name("nirman-fraud", "analyze_selfie").remote(image_b64, history)

analyze_selfie runs on every check-in (GPU: DINOv2 + FaceNet). The batch sweep runs as a Job
(see jobs/fraud_sweep.yaml) because it scans every check-in and can run for minutes.
"""

import base64

import nodus

from fraud_core import analyze_selfie as _analyze_selfie

app = nodus.App("nirman-fraud")

# Keep one warm worker during the demo so the first check-in does not pay model load time.
# GPU selection for functions: confirm the parameter name in the Nodus SDK reference at the
# event (jobs use `--gpu L4` / `resources.gpu`).
@app.function(gpu="L4", memory="8Gi", min_workers=1, max_workers=2, max_cost=5)
def analyze_selfie(image_b64: str, history: list) -> dict:
    """
    image_b64: the check-in selfie, base64
    history:   the worker's recent selfies [{"date", "phash", "embedding"}]
    returns:   {"phash", "embedding", "face_embedding", "recapture_score", "near_duplicate", "flags"}
    """
    return _analyze_selfie(base64.b64decode(image_b64), history)


@app.function(cpu=1, memory="1Gi", max_cost=1)
def ping() -> str:
    return "pong"
