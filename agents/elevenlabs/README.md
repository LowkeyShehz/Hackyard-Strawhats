# ElevenLabs: Mitra Helpline agent

A voice agent built on the ElevenLabs Agents platform. Workers can reach it on WhatsApp (voice or
text) or by phone and ask about their own attendance in Kannada, Hindi or English:

> "ನನಗೆ ಎಷ್ಟು ದಿನ ಆಗಿದೆ?" · "Mera certificate kab milega?" · "Why is today's attendance pending?"

ElevenLabs also does the rest of the voice work in Nirman Mitra:
- **TTS:** every WhatsApp reply in every language with a voice, including Kannada (`src/providers/tts.js`)
- **Scribe:** the second link in the speech-to-text chain (`src/providers/stt.js`)

## Agent configuration (ElevenLabs dashboard → Agents)

| Setting | Value |
|---|---|
| Name | Mitra Helpline |
| Languages | Kannada (default), Hindi, English. Turn on language detection |
| Voice | The same voices as `ELEVENLABS_VOICE_IDS`, so the helpline sounds like the WhatsApp replies |
| LLM | **Custom LLM**: base URL `https://inference.nodus-compute.ai/v1`, model `nodus/gpt-oss-120b`, API key stored as an ElevenLabs secret. This runs the helpline's reasoning on Nodus Compute. |
| Tools | `get_my_progress`, from [`progress-tool.json`](progress-tool.json). The caller number comes from the `system__caller_id` dynamic variable, so the LLM can't ask about someone else |
| Knowledge base | `knowledge/schemes-ka.md`, the welfare-scheme summaries kept up to date by the Agent37 ops agent |
| Channels | WhatsApp (connect the Nirman Mitra WhatsApp Business number), plus a phone number for the demo |

Before you set the "Languages" row, confirm in the dashboard which TTS model supports Kannada.
If none does, use Hindi and English on the helpline and keep Kannada on the WhatsApp text path.

### System prompt

```
You are Mitra, the voice helpline of Nirman Mitra, for construction workers.
Speak simply and warmly, in the caller's language (Hindi or English). If the caller speaks Hindi,
reply in simple Hindi. Use short sentences that are easy to understand on a phone call.
Many callers cannot read.

When the caller asks about their days, attendance, review or certificate, call get_my_progress
and answer from it only. Say numbers clearly ("you have 42 days, 48 more to go").
- registered = false: tell them to send "Namaste" on WhatsApp to register.
- days_waiting_for_review > 0: an officer is checking those days; nothing for them to do.
- certificate_eligible: they can ask for their certificate on WhatsApp by saying "certificate".

For welfare schemes, answer only from the knowledge base and say where to apply.
Never ask for or repeat Aadhaar, bank or phone numbers. Never promise money or dates that are
not in the tool result or the knowledge base. If unsure, say an officer will help.
If the caller speaks another language, politely say you can help in Hindi or English.
```

### First message

- kn: "ನಮಸ್ಕಾರ, ನಾನು ಮಿತ್ರ. ನಿಮ್ಮ ಹಾಜರಾತಿ ಅಥವಾ ಪ್ರಮಾಣಪತ್ರದ ಬಗ್ಗೆ ಕೇಳಿ."
- hi: "Namaste, main Mitra hoon. Apni attendance ya certificate ke baare mein poochhiye."
- en: "Hello, I'm Mitra. Ask me about your attendance or your certificate."

The Kannada line needs a native speaker's check before the demo (PRD FR-8).

## Backend

- `POST /api/helpline/progress` (`src/handlers/helplineRoutes.js`). Deploy with the
  `HelplineSecret` parameter and set the same value as the tool's `X-Helpline-Secret` header.
- It returns only the caller's first name, day counts, last check-in status and certificate date.
  It never returns Aadhaar, phone or bank data. Every lookup is audited as `helpline:elevenlabs`.

## Credits

The hackathon Creator plan comes with 131k credits. Template replies are cached in S3 by content
hash (`tts-cache/`), so only new text spends credits. Keep helpline test calls short.
