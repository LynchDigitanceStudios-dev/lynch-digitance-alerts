# Lynch AI — the Alerts extension assistant

A Worker of its own, separate from the website assistant.

```
LYNCH ALERTS SITE/
├── _worker.js        the WEBSITE assistant + the site itself
└── ai-worker/        ← the EXTENSION assistant, deployed separately
    ├── wrangler.jsonc
    └── src/
        ├── index.js      plumbing only
        └── knowledge.js  everything the assistant knows
```

## Why separate

- **The knowledge can't bleed.** This worker holds only Alerts knowledge, so the
  extension can never start talking about the studio, other products, or anything else.
- **It can be locked down.** The website chat must accept anyone. This one accepts
  **only extension origins** and returns 403 to everything else.
- **Its own rate limit.** 12 messages a minute per IP, on its own namespace, so
  extension traffic can't throttle the website bot or burn its allowance.
- **Edit knowledge without touching logic.** `knowledge.js` is prose, `index.js` is code.

## Deploying

```bash
cd "LYNCH ALERTS SITE/ai-worker"
wrangler deploy
```

Goes live at `https://alerts-ai.lynchdigitancestudios.workers.dev/chat`.

`wrangler.toml`/`wrangler.jsonc` already declares the AI binding and the rate limiter,
so there is nothing to click in the dashboard.

> The site itself is deployed separately, from the folder above:
> `cd "LYNCH ALERTS SITE" && wrangler deploy`

## Testing it

The worker refuses ordinary browser requests on purpose, so `curl` without an Origin
header gets **403**. That is correct. To test properly, add an extension-shaped origin:

```bash
curl -X POST https://alerts-ai.lynchdigitancestudios.workers.dev/chat -H "Content-Type: application/json" -H "Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop" -d "{\"messages\":[{\"role\":\"user\",\"content\":\"telegram says chat not found\"}]}"
```

A working reply mentions messaging your bot first and pressing **Detect chat ID**.
The `X-Model` response header names the model that answered.

| Response | Meaning |
|---|---|
| 403 | Origin isn't an extension — expected from a plain browser or curl |
| 429 | Rate limited; wait a minute |
| 503 "isn't configured yet" | AI binding missing |
| 503 "resting for today" | Daily Workers AI allowance used up |

## Changing what it knows

Edit `src/knowledge.js`, then redeploy. Nothing else to touch, and no new extension
build needs shipping — the knowledge lives on the server.

**Keep it to this extension.** If it doesn't concern Lynch Digitance Alerts, it doesn't
belong here.

## Changing settings for the user

The assistant can act, not just explain. It ends a reply with a fenced `lynch-action`
block containing a JSON array; the popup parses it, **validates every field**, applies
the change through the same code the UI uses, and reports back **in the popup's own
wording, never the model's**. Malformed actions are skipped rather than failing the
batch, and the JSON is hidden from the chat.

Supported actions are listed at the bottom of `knowledge.js`. Adding one means editing
two places: the list there, and `applyOne()` in the extension's `options.js`.

**Tokens, chat IDs, API keys and webhook URLs can never be set this way** — the prompt
forbids it and `applyOne()` has no case for them.
