# Hackyard Build 2026 — Sponsor Integration Plan

Nirman Mitra extended with **Nodus Compute** (priority), **ElevenLabs** and **Agent37**.
Each sponsor closes a real gap in the baseline rather than being bolted on.

| Sponsor | Gap it closes | Prize eligibility |
|---|---|---|
| **Nodus Compute** | PRD §8 anti-fraud gaps (near-duplicate selfies, one person/two numbers, mock GPS, phone farms) need GPU/ML compute; LLM + STT also move onto Nodus inference | Built on Nodus at IIT Guwahati, 24–25 Oct 2026; teams of 2–4 |
| **ElevenLabs** | Polly has no Kannada voice, so Kannada workers got text-only replies — breaks "Zero Literacy" | "Best Project Built with ElevenLabs" |
| **Agent37** | Officers have no proactive help: review triage, daily digests, scheme knowledge | Verified use: instance ID + dashboard screenshot via the [form](https://forms.gle/nmJxUubMJj6ZEKaY7), same email as the Build 2026 application |

## Architecture

```
WhatsApp ─► Webhook Lambda
              ├─ providers/stt.js  ─► Nodus whisper-large-v3 → ElevenLabs Scribe → Groq
              ├─ providers/llm.js  ─► Nodus inference (nodus/gpt-oss-120b) → Groq
              ├─ providers/tts.js  ─► ElevenLabs (incl. Kannada) → Polly (hi/en)
              ├─ Nodus Function analyze_selfie (GPU) → near-duplicate + face-dedupe flags
              └─ DynamoDB / S3
                     ▲
Nodus Job fraud_sweep (nightly) ── fraud flags ──┘
Agent37 Ops Agent ── scoped API key ──► /api/agent/* (read queue, add triage notes, daily stats)
ElevenLabs "Mitra Helpline" agent ── server tools ──► /api/helpline/*
```

## Modules (one commit each)

1. **Nodus LLM provider** — `src/providers/llm.js` gains `nodus` (OpenAI-compatible,
   `https://inference.nodus-compute.ai/v1`) with automatic fallback to Groq.
2. **STT provider chain** — `src/providers/stt.js`: Nodus Whisper → ElevenLabs Scribe → Groq.
3. **ElevenLabs TTS** — `src/providers/tts.js`: per-language voices (Kannada included),
   Polly fallback for hi/en.
4. **Nodus fraud workloads** — `nodus/` Python: `analyze_selfie` GPU function and
   `fraud_sweep` nightly job (GPS fingerprints, phone farms, face clusters).
5. **Fraud signals in scoring** — attendance decision consumes Nodus flags; flags shown in the
   review queue.
6. **Agent API** — `agent` role with a hashed API key, `/api/agent/*` routes, audited,
   recommendation-only (never approves/rejects).
7. **Agent37 Ops Agent** — `agents/agent37/`: triage + daily digest scripts and setup guide.
8. **ElevenLabs helpline** — `/api/helpline/*` server tools + agent config (custom LLM = Nodus).
9. **Dashboard** — fraud-signal and AI-triage chips in the review queue.

## Privacy rules (PRD §5 still applies)

- No Aadhaar image or number is ever sent to any sponsor service.
- Selfies go only to our own Nodus function, never to a third-party LLM.
- Agents see masked phone numbers only and every agent action is audit-logged.
- No voice cloning of workers.

## Demo (3 min)

1. Kannada worker sends a voice note → spoken Kannada reply (ElevenLabs).
2. Gallery selfie reused → Nodus function flags the near-duplicate live.
3. Nightly Nodus job exposes a 4-worker phone farm (Nodus console + cost on screen).
4. Agent37 triage note appears in the review queue → officer bulk-rejects.
5. Worker asks the helpline "how many days do I have?" → answered via Nodus LLM.

## Environment

```
NODUS_API_KEY=            # scope inference:invoke
LLM_PROVIDER=nodus        # falls back to groq when GROQ_API_KEY is set
LLM_MODEL=nodus/gpt-oss-120b
STT_PROVIDERS=nodus,elevenlabs,groq
TTS_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_IDS=     # JSON, e.g. {"hi":"...","kn":"...","en":"..."}
AGENT_API_KEY_HASH=       # sha256 of the key given to the Agent37 instance
```
