# Nirman Mitra: Product Requirements Document

**Team:** StrawHats · **Event:** Build for Billions · **Status:** Draft v1

---

## 1. Summary

**Problem.** Construction workers in India qualify for state welfare benefits only if they can prove days of work (typically 90 days in a year). That proof usually depends on a contractor's signature, which many workers cannot obtain.

**Product.** Nirman Mitra ("builder's friend") is a voice-first WhatsApp assistant that lets a worker build that proof themselves:

1. The worker checks in daily with a selfie, their location and a short voice note.
2. Each check-in is verified automatically.
3. When enough days are verified, the worker receives a **digitally signed work credential** with a QR code.
4. A welfare board officer scans the QR and verifies the signature **in the browser, without contacting our server**, then approves the claim.

**Positioning.**

- Aadhaar proves who you are, UPI moves money, and DigiLocker holds documents. Nothing proves what work you did.
- Nirman Mitra is a proof-of-work layer built on open credential standards and explicit consent.

---## 2. Users

| User | Needs | Constraints |
| --- | --- | --- |
| **Construction worker** | Build verifiable proof of work days without a contractor; understand their progress; receive a credential | Low literacy, basic Android phone, WhatsApp already installed, intermittent network, prefers voice and their own language |
| **Welfare board officer** | Trust a worker's claim quickly; see the attendance summary behind it; approve or reject | Needs to verify at a counter or in the field; cannot depend on a vendor's server being up |
| **Program admin** | Monitor registrations and check-ins, review low-confidence check-ins, keep an audit trail | Must not see more personal data than needed |

---

## 3. The core user story (demo path)

1. **Consent.** A worker messages the bot and receives a short purpose notice **in Kannada** with an **"I agree"** button. Consent is recorded with a timestamp.
2. **Onboarding.** The worker says their name, photographs their Aadhaar card (only the last 4 digits are kept) and sends a selfie for enrollment.
3. **Daily check-in.** The worker sends a selfie, shares their location with the WhatsApp location button, and records a voice note about the day's work. The bot replies within seconds: verified, or sent for review.
4. **Credential.** On reaching the threshold (3 days in demo mode, 90 in production), the worker receives a **signed credential with a real QR code** on WhatsApp.
5. **Verification.** An officer opens the portal and scans the QR. The **signature is checked in the browser** against our published public key. The officer sees the attendance summary and taps **Approve**. The approval and every officer view are written to the audit log.

A task is in scope only if it makes this story work better.

---

## 4. Functional requirements

### FR-1 Consent (WhatsApp)

- Before any data is collected, send a purpose notice in the worker's language (Kannada, Hindi or English) with an interactive **I agree** reply button.
- Store a consent record: worker ID, notice version, language, timestamp, channel.
- Without consent, the bot collects no documents, images or voice.

### FR-2 Onboarding

- Detect the language from the first message; the worker can change it later.
- Capture the name by voice or text.
- **Aadhaar:**
  - OCR the card photo (Amazon Textract) and validate the number with the Verhoeff checksum.
  - **Store only the last 4 digits.** The full number is used in memory for validation and then discarded.
- **Face:** index the enrollment selfie (Amazon Rekognition) for later 1:1 comparison.
- **Image quality:** if a document image is poor, guide the worker by voice to retake it (up to 3 attempts, then flag for admin).

### FR-3 Daily check-in: triple verification

Three independent checks run **in parallel**:

| Check | Method | Catches |
| --- | --- | --- |
| Face | Rekognition CompareFaces against the enrolled selfie | Proxy check-ins, wrong person |
| Location | Haversine distance from the shared location to the nearest registered site geo-fence | Off-site check-ins |
| Voice intent | Speech-to-text, then an LLM judges whether the note describes real work at the site | Empty or scripted check-ins |

**Confidence routing:**

| Result | Condition |
| --- | --- |
| **Auto-approved** | Face ≥ 60, geo ≥ 60, **and** a spoken voice note that describes work and says the one-time number |
| **Rejected** | Face < 30, distance beyond 2× the site radius, or the wrong one-time number |
| **Pending review** | Anything else, including a skipped or typed voice note; queued for an admin |

**Also flagged (a note for the reviewer, not a block):** off-hours submissions (before 06:00 or after 20:00 IST), non-work voice notes, and blurry or glaring selfies (possible photo of a screen).

**Site attribution:** a worker is not tied to one company. Each check-in is attributed to the nearest active site whose geo-fence contains the shared location, and appears on the dashboard of the company that owns that site.

**Anti-misuse checks in this build:**

| Misuse | Check |
| --- | --- |
| Re-sending an old selfie | SHA-256 of the image compared with the worker's recent check-ins |
| Forwarded photo or voice note | WhatsApp forwarded flag; rejected |
| Picking a place on the map | Locations with a place name or address are refused; only "current location" is accepted |
| Replaying an old voice note | A random two-digit number per check-in must be spoken |
| Skipping or typing the voice note | Allowed, but only a spoken note can auto-approve; others go to review |
| Selfie now, location hours later | Selfie, location and voice note must arrive within 10 minutes |
| Two check-ins in a day | One log per worker per IST date (conditional write) |

**Duplicates:** one check-in per worker per day.

**Reply:** text plus a spoken audio reply (Amazon Polly) with days logged and days remaining.

### FR-4 Signed work credential

- Issued automatically when verified days reach `CERTIFICATE_THRESHOLD`.
- **Format:** a JWT signed with **ES256**. Its claims include:
  - issuer DID
  - worker pseudonymous ID
  - name
  - Aadhaar last 4
  - verified day count
  - date range
  - site names
  - issue time
- **Issuer key:**
  - The public key is published as a **did:web** document on the portal's domain (`/.well-known/did.json`).
  - The private key never leaves the backend.
- **Delivery on WhatsApp:**
  - a **real QR code** encoding the portal URL `/verify#<token>` (the token sits in the URL fragment, so it never reaches a server log)
  - the PDF certificate
- The PDF keeps a SHA-256 fingerprint and a public verification link.

### FR-5 Officer verification portal

- Scan a QR with the phone or laptop camera, or paste a token.
- **In-browser verification:**
  - Resolve the issuer's did:web public key and verify the ES256 signature.
  - Check expiry.
  - No call to the Nirman Mitra API is needed to decide validity.
- Show the credential summary: worker name, Aadhaar last 4, verified days, date range, sites.
- **Approve** or **Reject** with an optional note. The decision is written to the audit log.
- **Target:** QR scan to "Verified" in under 5 seconds on a mid-range phone.

### FR-6 Admin dashboard

- Login with JWT access and refresh tokens. The seed endpoint requires a seed secret.
- Overview: workers, active or onboarding, days logged, pending reviews, trend charts.
- Review queue: flagged check-ins with reasons and per-signal confidence; approve or reject with justification.
- Worker search and profile, with the phone number masked.

### FR-7 Audit log

Append-only audit entries for:

- every officer view
- every approve and reject decision
- every admin view of a worker profile

Each entry records actor, action, subject, timestamp and outcome.

### FR-8 Languages

- Demo path: **Kannada, Hindi and English**.
- The roughly 15 Kannada strings on the demo path are hand-translated and checked by a native speaker.

---

## 5. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Latency | Check-in reply target: a few seconds, measured end to end before quoting any number. Credential verification under 5 s |
| Privacy | Data minimisation: Aadhaar last 4 only; the phone number is masked in admin views; no Aadhaar image or number is ever sent to an LLM |
| Security | Webhook requests authenticated with Meta's `X-Hub-Signature-256`; admin API behind JWT; secrets only in deployment parameters or secret stores, never in the repository; S3 encryption at rest (SSE-S3) |
| Compliance | Aligned with the DPDP Act 2023: explicit consent, stated purpose, audit trail, deletion on request (roadmap) |
| Accessibility | The whole worker flow is completable by voice and buttons; spoken replies for every status message |
| Cost | Serverless and pay-per-use; idle cost near zero; an honest per-worker cost estimate is published with its working |
| Reliability | Duplicate-safe check-ins; webhook acknowledges receipt even when downstream processing fails, and errors are logged |

---

## 6. Architecture

```
Worker (WhatsApp) ──► Meta WhatsApp Cloud API ──► API Gateway ──► Lambda: message handler
                                                                   │
        ┌──────────────────────────────────────────────────────────┤
        ▼                    ▼                    ▼                ▼
  Amazon Rekognition   Amazon Textract     Speech-to-text     Groq LLM
  (face 1:1)           (Aadhaar OCR)       (Transcribe;       (intent, voice
                                            Whisper planned)   relevance)
        │                                                         │
        └────────► DynamoDB (workers, attendance, sites, consent, audit, certificates)
                   S3 (media, certificates)       Amazon Polly (spoken replies)

Officer / Admin (browser) ──► React dashboard + officer portal (AWS Amplify)
                              ├─ admin API (API Gateway + Lambda, JWT)
                              └─ credential check in the browser using did:web public key
```

**Stack:**

- **Backend:** Node.js 20 on AWS Lambda, API Gateway, DynamoDB, S3, deployed with AWS SAM.
- **AI:** Amazon Rekognition, Textract, Transcribe, Polly, and Groq (`openai/gpt-oss-120b`) behind a provider interface.
- **Frontend:** React + Vite on AWS Amplify.
- **Messaging:** WhatsApp Cloud API.
- **CI/CD:** GitHub Actions deploys on merge to `main`.

---

## 7. Scope for this build

| Piece | Scope | Owner |
| --- | --- | --- |
| Signed credential | ES256 JWT, did:web document, real QR to `/verify#<token>` | Wasih |
| Officer portal | QR scan, in-browser signature check, attendance summary, approve action, audit display | Abubaker |
| Consent + audit log | WhatsApp consent button with purpose notice, consent record, audit entry on every officer/admin view | Shehzan / Wasih |
| Kannada | The demo-path strings, native-speaker checked | Hasan / Shehzan |
| Faster speech-to-text | Groq Whisper instead of batch transcription, **2-hour timebox**; revert if it overruns | Shehzan |
| Hardening | Restrict test keywords to team numbers, production configuration, remove fallback transcription, ~10 unit tests | Wasih |

---

## 8. Known gaps (anti-misuse roadmap)

Honest limits of verifying attendance over WhatsApp, and the planned answer to each.

| Gap | Why it is open | Planned mitigation |
| --- | --- | --- |
| Mock-location apps | WhatsApp passes on whatever GPS the phone reports; a spoofing app looks like a real "current location" | Flag identical coordinates day after day (real GPS jitters), impossible travel between check-ins, and a mismatch with the SIM's telecom circle |
| Gallery or edited selfies | WhatsApp does not say if a photo was just taken and strips its metadata; the image hash only catches exact copies | Perceptual (near-duplicate) matching against the worker's past selfies; a random gesture in the selfie ("show two fingers") as lightweight liveness |
| Photo of a photo or screen | Only a blur and glare heuristic today | Liveness detection (Rekognition Face Liveness or a gesture prompt) |
| Check in, then leave | One check-in covers the day | A random mid-shift location ping, or a check-out step |
| One person, two numbers | Registration does not search the face or Aadhaar against other workers | Search each new face against all enrolled workers; flag a repeated Aadhaar last-4 plus name |
| One phone checking in many workers | Each worker uses their own number, but a contractor could hold several SIMs | Flag several workers checking in from identical coordinates within a minute |
| Officer collusion | Approvals are audited, but one officer can approve an auto-rejected day | Two-person approval for overturning an automatic rejection |

## 9. Out of scope (roadmap)

- Bhashini speech services and languages beyond Kannada, Hindi and English
- e-Shram UAN linkage and DigiLocker issuance
- Site supervisor interface (co-signing check-ins)
- Liveness detection
- Credential revocation (status list)
- Workflow orchestration with Step Functions
- Direct integration with welfare board systems

---

## 10. Success criteria

- A credential issued on WhatsApp verifies in the portal **with no server call**.
- An officer goes from scan to "Verified" in **under 5 seconds**.
- A new worker sees the consent notice in Kannada, and the check-in reply arrives quickly (time measured and reported as measured).
- Every officer or admin view appears in the audit log.

---

## 11. Communication rules

- **Claims:** state only what works at the time of saying it.
  - Languages: "Kannada, Hindi and English today".
  - Verification speed: quote only measured times.
- **Numbers:** every statistic used in the pitch must have a citable source (§11); a number without a source is dropped.

---

## 12. References

*Every number used in the pitch must carry its source. Fill in each source or remove the claim before submission.*

| Claim | Source |
| --- | --- |
| Number of registered construction workers in India | *to be sourced* |
| Share of eligible workers receiving welfare benefits | *to be sourced* |
| Welfare cess collected but unspent | *to be sourced* |
| Application rejection rate | *to be sourced* |
