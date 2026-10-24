# Agent37: Welfare Ops Agent

An always-on Agent37 agent that works for the welfare board officers:

| Schedule | Task | What it does |
|---|---|---|
| every 30 min | `triage.py` | Writes an AI recommendation (approve / reject / needs_human) on each new pending check-in, using Nodus inference with a rules fallback |
| 19:00 IST daily | `digest.py` | Officer digest (check-ins, fraud patterns, sites, workers near their certificate), sent by Gmail or Slack |
| Mon 09:00 IST | scheme refresh | Summarises Karnataka BOCW welfare schemes into `knowledge/schemes-ka.md` for the ElevenLabs helpline |

The agent only talks to `/api/agent/*` (see `src/handlers/agentRoutes.js`). That API has no
phone numbers, images or Aadhaar data, records every call in the audit log, and has **no
approve or reject route**.

## Setup

1. Generate a key and deploy its hash:
   ```bash
   KEY="agk_$(openssl rand -hex 24)"
   echo -n "$KEY" | sha256sum      # → AgentApiKeyHash parameter / AGENT_API_KEY_HASH
   ```
2. Sign up at [agent37.com/personal](https://agent37.com/personal) **with the same email as
   your Build 2026 application** and create an agent instance.
3. In the instance terminal:
   ```bash
   git clone https://github.com/LowkeyShehz/Hackyard-Strawhats.git && cd Hackyard-Strawhats/agents/agent37
   export NIRMAN_API_URL=https://<api-id>.execute-api.ap-south-1.amazonaws.com/prod
   export NIRMAN_AGENT_KEY=<KEY>
   export NODUS_API_KEY=<nodus key>
   python triage.py --dry-run
   ```
   Store the three values as instance secrets or environment variables, not in files.
4. Paste `AGENT.md` as the agent's instructions. Add the three schedules above as scheduled
   tasks, and connect Gmail and/or Slack through the integrations panel.
5. Set the agent's model to Nodus inference if Agent37 lets you bring your own OpenAI-compatible
   key: base URL `https://inference.nodus-compute.ai/v1`, model `nodus/gpt-oss-120b`.

## Prize submission (verified use)

- [ ] Instance ID (from the Agent37 dashboard URL)
- [ ] Dashboard screenshot showing scheduled task runs and their logs
- [ ] Submit the [form](https://forms.gle/nmJxUubMJj6ZEKaY7) with the project link, Build 2026
      application email, Agent37 account email, instance ID and screenshot

## Tests

```bash
python -m pytest agents/agent37/tests
```
