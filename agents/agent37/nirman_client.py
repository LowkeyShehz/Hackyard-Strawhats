"""
Shared clients for the Agent37 ops agent (standard library only, so it runs in any sandbox).

Environment:
  NIRMAN_API_URL   API Gateway base URL, e.g. https://abc.execute-api.ap-south-1.amazonaws.com/prod
  NIRMAN_AGENT_KEY the X-Agent-Key whose SHA-256 is deployed as AgentApiKeyHash
  NODUS_API_KEY    Nodus inference key (scope inference:invoke); when unset or failing, Groq is used
  NODUS_MODEL      default nodus/gpt-oss-120b
  GROQ_API_KEY     fallback LLM (GROQ_MODEL, default openai/gpt-oss-120b)
"""

import json
import os
import urllib.parse
import urllib.request

API_URL = os.environ.get("NIRMAN_API_URL", "").rstrip("/")
AGENT_KEY = os.environ.get("NIRMAN_AGENT_KEY", "")
NODUS_URL = os.environ.get("NODUS_BASE_URL", "https://inference.nodus-compute.ai/v1").rstrip("/")
NODUS_KEY = os.environ.get("NODUS_API_KEY", "")
NODUS_MODEL = os.environ.get("NODUS_MODEL", "nodus/gpt-oss-120b")
GROQ_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")


def _request(method, url, headers, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode() or "null")


def api(method, path, body=None, query=None):
    """Call /api/agent/* on the Nirman Mitra backend."""
    if not API_URL or not AGENT_KEY:
        raise RuntimeError("NIRMAN_API_URL and NIRMAN_AGENT_KEY must be set")
    url = f"{API_URL}{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
    return _request(method, url, {"X-Agent-Key": AGENT_KEY}, body)


def _chat(url, key, model, system, prompt, json_mode, max_tokens):
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": max_tokens,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    data = _request("POST", f"{url}/chat/completions", {"Authorization": f"Bearer {key}"}, body, timeout=60)
    return data["choices"][0]["message"]["content"] or ""


def llm(system, prompt, json_mode=False, max_tokens=800):
    """One chat completion: Nodus inference when NODUS_API_KEY is set, Groq otherwise or on failure."""
    if NODUS_KEY:
        try:
            return _chat(NODUS_URL, NODUS_KEY, NODUS_MODEL, system, prompt, json_mode, max_tokens)
        except Exception:  # noqa: BLE001 - fall through to Groq
            if not GROQ_KEY:
                raise
    if GROQ_KEY:
        return _chat("https://api.groq.com/openai/v1", GROQ_KEY, GROQ_MODEL, system, prompt, json_mode, max_tokens)
    raise RuntimeError("Set NODUS_API_KEY or GROQ_API_KEY")
