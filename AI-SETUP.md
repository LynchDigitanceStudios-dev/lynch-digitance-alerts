# LYNCH AI ASSISTANT — setup

The assistant runs on **Cloudflare Workers AI**. No API key, nothing to leak, and the
free tier covers this kind of usage comfortably.

Until the binding below is added, both the website chat and the extension panel show a
friendly "not switched on yet" message and point users at **Diagnose a problem**, which
works offline. Nothing breaks.

---

## Turn it on (dashboard, 2 minutes)

1. <https://dash.cloudflare.com> → **Workers & Pages** → open your **alerts** project
2. **Settings** → **Bindings** → **Add binding**
3. Choose **Workers AI**
4. Variable name — must be exactly:

```
AI
```

5. **Deploy** / redeploy the project

That's the whole setup. The endpoint is `POST /ai` on the same domain, so there's no
CORS setup, no second service, no secrets.

## Turn it on (command line)

```bash
npm install -g wrangler
wrangler login
cd "LYNCH ALERTS SITE"
wrangler deploy
```

`wrangler.toml` already declares both the assets and the `AI` binding.

---

## Check it works

```bash
curl -X POST https://alerts.lynchdigitancestudios.workers.dev/ai \
  -H "Content-Type: application/json" \
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"telegram says chat not found\"}]}"
```

A working reply mentions messaging your bot first and pressing **Detect chat ID**.

- `503 not-configured` → the `AI` binding is missing or misnamed
- `502 ai-failed` → the binding exists but the model call failed; check the model names
  in `_worker.js` against Cloudflare's current Workers AI catalogue

---

## What it costs

Workers AI bills in "neurons" with a free daily allowance. A support answer is a few
hundred tokens, so ordinary use stays inside the free tier. Screenshot analysis costs
more than text — it is only ever triggered when a user explicitly attaches one.

If you ever want a hard ceiling, add a Rate Limiting binding in the dashboard and check
it at the top of `handleAI`.

---

## Models

| Purpose | Model | Where |
|---|---|---|
| Answers | `@cf/meta/llama-3.1-8b-instruct` | `TEXT_MODEL` in `_worker.js` |
| Screenshots | `@cf/llava-hf/llava-1.5-7b-hf` | `VISION_MODEL` in `_worker.js` |

Cloudflare renames and retires models periodically. If replies stop working, check the
Workers AI model list and update those two constants.

---

## What it knows

The system prompt in `_worker.js` holds everything the assistant knows about the
extension — how it works, why it's safe for a Fiverr account, and the exact fix for each
known error. **Edit it there when the extension changes.** It lives on the server, so
corrections take effect on redeploy without shipping a new extension build to anyone.

It is explicitly told never to ask for a bot token, API key, or password, and to tell
users to revoke one immediately if they paste it.
