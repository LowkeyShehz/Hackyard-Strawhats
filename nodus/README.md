# Nodus workloads: fraud detection

GPU and batch workloads that close the anti-misuse gaps in PRD §8. Everything here runs on
[Nodus Compute](https://www.nodus-compute.ai/docs/).

| File | Runs as | What it does |
|---|---|---|
| `fraud_core.py` | library | All detectors. Pure logic, plus lazily loaded models |
| `app.py` | Nodus Functions app `nirman-fraud` | `analyze_selfie` on every check-in (GPU): pHash + DINOv2 near-duplicate, FaceNet embedding, screen-recapture score |
| `jobs/fraud_sweep.yaml` + `sweep.py` | Nodus Job (nightly) | Static GPS fixes, impossible travel, phone farms, same face under two worker IDs. Writes `fraud_flags` to AttendanceLogs |
| `bridge.py` | small HTTPS service | Lets the Node.js Lambda call `analyze_selfie` (Nodus functions are called from Python) |

## Setup

```bash
pip install nodus-compute
nodus login
cd nodus
nodus deploy app.py
```

Check it with: `python -c "import nodus; print(nodus.Function.from_name('nirman-fraud','ping').remote())"`

## Bridge (Node → Nodus)

```bash
cd nodus
pip install -r requirements.txt
FRAUD_SERVICE_TOKEN=<random> uvicorn bridge:app --host 0.0.0.0 --port 8080
```

Point the backend at it with `FRAUD_SERVICE_URL=https://<host>` and the same `FRAUD_SERVICE_TOKEN`.
Set `FRAUD_LOCAL=1` to run the analysis in-process on CPU when you're offline.

## Nightly sweep

```bash
nodus secret create nirman-aws --from-env-file aws.env
nodus apply -f nodus/jobs/fraud_sweep.yaml
nodus cp job/nirman-fraud-sweep:outputs/report ./report.json
```

For a report without writes, add `SWEEP_DRY_RUN=1` to the manifest env.

## Verify at the event

Some of this is not yet confirmed against the Nodus docs:
- The GPU parameter name on `@app.function`. Jobs use `--gpu L4` / `resources.gpu`.
- Image builds are "currently unavailable" in hosted Nodus. If the function workers lack
  torch/transformers, use the `nodus/pytorch` catalog image or pip-install at worker start.
- Whether deployed functions can be exposed over HTTP directly. If they can, drop `bridge.py`.

## Tests

```bash
pip install numpy pillow pytest
python -m pytest nodus/tests
```

## Privacy

- Selfies are processed only inside our own Nodus function and are never sent to a third-party
  model.
- Attendance logs store a coarse GPS cell (4 dp, about 11 m) and a hash of the exact fix, never
  the raw coordinates.
