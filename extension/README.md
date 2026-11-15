# LYNCH DIGITANCE · Alerts

Instant Fiverr message / order / notification alerts pushed to Telegram in seconds.
**No VPS. No paid API. Nothing hosted.**

Chrome extension name: **Lynch Digitance Alerts**.

---

## Why not `wa.me/<number>`?

`wa.me/2348012345678` is a **link**, not an API. Clicking it opens a chat with text
pre-typed — a human still has to press Send, and something must already be logged
into WhatsApp on that device. It cannot deliver a message on its own, and it can't
be triggered from a background script. That's why this build uses a relay instead.

## How it works

```
Chrome (your real, human Fiverr session)
  └─ pinned tab: fiverr.com/inbox
        └─ extension reads what the page already loaded
              └─ HTTPS request → relay → WhatsApp on your phone
```

Nothing is logged into WhatsApp in Chrome. No linked-device slot is used. Every
Chrome profile can send to the same number simultaneously.

### Detection — three layers, deduped

1. **Network read** — the message/notification JSON your Fiverr tab already fetched.
2. **Tab-title watcher** — Fiverr rewrites the title to `(1) …` on any unread. Never misses.
3. **DOM observer** — inbox rows and notification toasts.

## The safety rule this is built around

The extension **never sends a request to Fiverr**. No timers hitting Fiverr endpoints,
no login automation, no clicking, no form submission. It is a passive reader inside a
session a human created. To Fiverr, your traffic is identical to a person with the
inbox open — because it is.

Never add polling of Fiverr endpoints later. That single change is what turns a safe
extension into a flagged account.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `FIVERR NOTIFIER` folder
3. Click the extension icon and set up a delivery channel (below)
4. Open and **pin** `https://www.fiverr.com/inbox`
5. Hit **Send test**

## Delivery channels

### WhatsApp via CallMeBot (free) — default
One-time setup, 2 minutes:
1. Save **+34 644 87 21 57** to your phone contacts.
2. From WhatsApp on your phone, send it: `I allow callmebot to send me messages`
3. It replies `API Activated for your phone number. Your APIKEY is …`
4. Paste the key + your number (country code, e.g. `2348012345678`) into settings.

Free, no account, no card. Rate-limited to roughly one message per minute, which is
why the extension queues and paces sends.

**If no key arrives in 2 minutes:** send `Recover APIKey` to the same contact. If that's
also silent, WhatsApp has killed the bot number and CallMeBot has published a new one —
check <https://www.callmebot.com/blog/free-api-whatsapp-messages/> for the current
number. Their official advice otherwise is to retry after 24h.

**This is the fragile part of the whole system.** The bot number gets banned by WhatsApp
periodically and everyone's setup breaks until they rotate it. If you want alerts you can
depend on, use the Telegram channel.

**Privacy note:** message text passes through CallMeBot's server. If that bothers you,
turn on **Privacy mode** — you'll get "new message from `buyer` on account `X`" with
no body text, and you open Fiverr to read it.

### Telegram (free, fastest, most reliable) — recommended
1. `@BotFather` → `/newbot` → paste the token into settings → **Save**
2. **Open your new bot in Telegram and send it `hi`.** Bots may not message you first;
   skipping this is what produces `Bad Request: chat not found`.
3. Press **Detect chat ID** → **Save** → **Send test**

No rate limits worth worrying about, instant delivery, nothing that can be banned out
from under you. This is the channel to depend on.

Error reference:
| Log line | Cause |
|---|---|
| `Not Found` | bot token wrong or malformed |
| `Unauthorized` | token revoked |
| `Bad Request: chat not found` | you never messaged the bot, or the chat ID is wrong |
| `Sent ✓` but nothing arrives | chat ID points at a different chat |

### Custom webhook / Discord
Paste any webhook URL; the extension POSTs `{content, text}`.

## Multiple Fiverr accounts

One Chrome **profile per account** (Chrome menu → Add profile). Install the extension
in each and pin the Fiverr inbox tab in each. Configure the same number/key in all of
them. Every alert is labelled with the account it came from, and they all arrive in the
same WhatsApp chat. No WhatsApp login needed in any of them.

## Alert format

```
LYNCH DIGITANCE · ALERTS
💬 Fiverr · innocent_thames
From: buyer_username

hey are you available for a quick job today?

https://www.fiverr.com/inbox/buyer_username
```

The header is built in `format()` in `background.js` — one place, applies to every
channel and to the test message.

## Settings

| Setting | Meaning |
|---|---|
| Enabled | master switch |
| Account names | friendly label per Fiverr account, shown in every alert |
| Unread badge | gold count on the toolbar icon of alerts since you last opened the popup; per-account breakdown inside, cleared on open |
| Desktop notification | also pop a Chrome notification |
| Privacy mode | sender + account only, no message text leaves your machine |
| Delivery channel | CallMeBot / Telegram / webhook |
| Max message characters | truncation length, default 500 |
| Mute 1h | silence without disabling |
| Watching | which Fiverr accounts are live right now |
| Log | last 25 events and whether delivery succeeded |

Failed sends retry automatically every minute, up to 4 attempts.

## Troubleshooting

**"Watching: no Fiverr tab detected"** while a Fiverr tab is open — the content script
isn't running in it. Chrome injects content scripts only at page load, so reloading the
extension leaves already-open tabs dead. The extension now re-injects itself into open
Fiverr tabs on install, on browser start, and every 30 minutes. If it still says this,
just reload the Fiverr tab (F5).

The **Watching** line is the health check. If it doesn't name your account, nothing else
in the pipeline matters — fix that first.

**Getting alerts for your own replies** — fixed in 1.4.1. Fiverr labels your own bubbles
with the literal word `Me` and gives them no distinguishing CSS class, so own-message
detection reads the sender label and compares it against `Me`, your username, and your
display name (see `isOwn` / `ownNames` in `fiverr-content.js`). If you ever rename your
Fiverr display name and start getting alerts for your own messages again, that's the
place to look.

## Known limits

- **Browser must be open.** Online-only by design. Closed laptop = no alerts.
- CallMeBot is a free third-party relay — occasional slow minutes, and it can go down.
  Telegram is the more dependable channel if you'll accept it.
- Fiverr's JSON schema isn't public, so the payload reader uses heuristics rather than
  fixed field names. The title watcher + DOM observer are the backstop — worst case you
  get "New unread activity" instead of full text, still instant.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 config |
| `fiverr-hook.js` | page-world passive response reader |
| `fiverr-content.js` | signal → event, account detection, dedupe |
| `background.js` | dedupe, formatting, queue, retry, delivery |
| `options.html` / `options.js` | settings, live status, log |
| `generate_icons.py` | redraws `icon16/32/48/128.png` — edit colours here, then rerun |
