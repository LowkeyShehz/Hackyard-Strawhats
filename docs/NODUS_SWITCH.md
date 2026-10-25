# Running without Nodus (and without AWS), and switching to Nodus later

The app runs today on Render + Groq + ElevenLabs. Nodus Compute is wired into every AI path and
turns on **by adding keys**, with no code change. Each path falls back to the current one if Nodus
fails.

## What runs where

| Job | Now (no Nodus, no AWS) | After the switch |
|---|---|---|
| Voice-intent check (LLM) | Groq `openai/gpt-oss-120b` | Nodus `nodus/gpt-oss-120b`, with Groq as fallback |
| Voice note to text | ElevenLabs Scribe, then Groq Whisper | Nodus Whisper large v3 first |
| Face enrolment + 1:1 match (was Rekognition) | OpenCV SFace on the **bridge's CPU** | The same SFace model on Nodus (`embed_face`) |
| Selfie fraud check | pHash + recapture on the bridge's CPU | Also DINOv2 near-duplicates on a Nodus GPU |
| Nightly fraud sweep | Render cron `nirman-fraud-sweep` | The Nodus job `nodus/jobs/fraud_sweep.yaml` |
| Agent37 triage and digest | Groq | Nodus |
| ElevenLabs helpline LLM | ElevenLabs' built-in LLM | Custom LLM on Nodus |

Faces use the **same SFace model** on CPU and on Nodus. Workers enrolled before the switch don't
need to re-register.

## Do this now (no AWS)

1. On the Render API service, set:
   - `FACE_PROVIDER=bridge` (already in `render.yaml`)
   - `FRAUD_SERVICE_URL=https://nirman-fraud-bridge.onrender.com`
   - `FRAUD_SERVICE_TOKEN=<random>`
   - `GROQ_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_IDS`
   - Leave `NODUS_API_KEY` **empty**, and delete any `AWS_*` variables.
2. On the bridge service, set the same `FRAUD_SERVICE_TOKEN` and leave `NODUS_API_KEY` empty.
   `GET /health` should report `"backend": "local"`.
3. Register yourself on WhatsApp, then check in. The attendance log should show a real
   `face_confidence`.

If the bridge is down, check-ins go to officer review with "Face check unavailable" rather than
being rejected. `FACE_PROVIDER=none` forces that mode on purpose.

## When Nodus access arrives (about 15 min)

1. `pip install nodus-compute && nodus login`
2. `cd nodus && nodus deploy app.py`. Check the GPU parameter on `analyze_selfie`, and that the
   workers have torch/transformers/opencv (see `nodus/README.md`).
3. Smoke test:
   `python -c "import nodus; print(nodus.Function.from_name('nirman-fraud','ping').remote())"`
4. Render **API** service: set `NODUS_API_KEY`. The LLM and speech-to-text switch to Nodus.
5. Render **bridge** service: set `NODUS_API_KEY`. Faces and fraud checks switch to Nodus.
   `/health` now reports `"backend": "nodus"`, and each response carries `"backend": "nodus"`.
6. Sweep: `nodus secret create nirman-db --from-literal DATABASE_URL=<Render external URL>`, then
   `nodus apply -f nodus/jobs/fraud_sweep.yaml` (Agent37 can trigger it nightly). Suspend the
   Render cron `nirman-fraud-sweep`.
7. Agent37: add `NODUS_API_KEY` to the instance. The ElevenLabs helpline: switch to Custom LLM →
   `https://inference.nodus-compute.ai/v1`, model `nodus/gpt-oss-120b`.

To roll back, remove `NODUS_API_KEY` (or set `FRAUD_BACKEND=local` on the bridge).

## Checks after the switch

- A check-in's server log shows `face sface:nodus` and no `[LLM] nodus failed` lines.
- `nodus` dashboard: function calls and cost appear. Take screenshots for the Nodus prize.
