# Hosting on Render with Neon (no card, no AWS, no Nodus)

Render runs the API, the face bridge and the dashboard. Neon holds the data (Postgres) and the
files (S3-compatible storage), so nothing is lost when a free Render service restarts or sleeps.

Tested end to end: onboarding, check-in, officer review and approval with `DB_BACKEND=postgres`
on a Neon pooled connection and `STORAGE_BACKEND=s3` on Neon storage.

## Neon (once)
1. Create a project. Copy the **pooled** connection string (Connect → Postgres) as `DATABASE_URL`.
2. Storage → create an access key. Note the endpoint, key ID and secret.
3. Create the three buckets (the S3 API works with `forcePathStyle`; the app sets it whenever
   `AWS_ENDPOINT_URL_S3` is set):
   `nirman-mitra-media-raw`, `nirman-mitra-media-processed`, `nirman-mitra-certificates`.
4. Put Render in the **same region as Neon** (Singapore for `ap-southeast-1`); each message makes
   several database calls, so distance shows up as reply time.

## Render: face bridge (Web Service, Python)
- Root directory `nodus`
- Build `pip install -r requirements-bridge.txt && pip install --no-deps rapidocr-onnxruntime && python -c "import face; face.ensure_models()"`
- Start `uvicorn bridge:app --host 0.0.0.0 --port $PORT`
- Health check `/health`
- Env: `PYTHON_VERSION=3.12.7`, `FRAUD_SERVICE_TOKEN=<random>`

## Render: API (Web Service, Node)
- Root directory: repo root
- Build `npm ci --omit=dev`
- Start `node src/server.js`
- Health check `/health`
- Env:
  ```
  NODE_VERSION=22
  ENVIRONMENT=dev
  DB_BACKEND=postgres
  DATABASE_URL=<Neon pooled string>
  STORAGE_BACKEND=s3
  AWS_ENDPOINT_URL_S3=<Neon storage endpoint>
  AWS_ACCESS_KEY_ID=<Neon key id>
  AWS_SECRET_ACCESS_KEY=<Neon secret>
  AWS_REGION=ap-southeast-1
  OCR_PROVIDER=bridge
  TTS_FALLBACK=none
  BACKGROUND_WEBHOOK=true
  CERTIFICATE_THRESHOLD=3
  FACE_PROVIDER=bridge
  FRAUD_SERVICE_URL=<bridge URL>
  FRAUD_SERVICE_TOKEN=<same as the bridge>
  LLM_PROVIDER=groq
  LLM_MODEL=openai/gpt-oss-120b
  STT_PROVIDERS=elevenlabs,groq
  GROQ_API_KEY=...
  ELEVENLABS_API_KEY=...
  ELEVENLABS_VOICE_IDS={"hi":"...","en":"...","kn":"..."}
  WHATSAPP_API_TOKEN=...  WHATSAPP_PHONE_NUMBER_ID=...  WHATSAPP_VERIFY_TOKEN=...  WHATSAPP_APP_SECRET=...
  JWT_SECRET=...  JWT_REFRESH_SECRET=...  (32+ random characters each)
  ADMIN_SEED_SECRET=...  GPS_HASH_KEY=...
  PORTAL_URL=<dashboard URL>
  ```
  No `NODUS_API_KEY`, no `STORAGE_DIR`, no disk. Add `AGENT_API_KEY_HASH`, `HELPLINE_SECRET`
  and `DEMO_PHONE_NUMBERS` only when you use them.

## Render: dashboard (Static Site)
- Root directory `admin-dashboard`, build `npm ci && npm run build`, publish `dist`
- Env `VITE_API_URL=<API URL>`
- Rewrite `/*` → `/index.html`

## Then
- Meta callback `https://<api>/webhook/whatsapp`, subscribe to `messages`.
- `POST /api/auth/seed` once, log in to the dashboard, add the IIT Guwahati site under Sites.
- Free services sleep after ~15 minutes idle: open both `/health` URLs before the demo.
- The fraud sweep can run from a laptop:
  `cd nodus && DATABASE_URL=<Neon string> python sweep.py`

## Never commit
The Neon connection string and storage keys are secrets. They belong in Render's environment
settings, not in the repo. Rotate them after the hackathon.
