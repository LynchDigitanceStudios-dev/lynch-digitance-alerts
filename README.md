# Lynch Digitance Alerts

A free Chrome extension (also Edge, Brave, Opera) that pushes Fiverr buyer messages, orders and notifications to your own Telegram bot within seconds, and can optionally let you answer buyers from Telegram.

**Live site and download:** https://alerts.lynchdigitancestudios.workers.dev

Built by [Lynch Digitance Studios](https://www.lynchdigitancestudios.workers.dev).

## Why it exists

Fiverr's own email alerts can arrive hours late, long after a buyer has moved on to another seller. This watches the Fiverr tabs you already have open and sends an alert the moment a message lands. One Chrome profile per Fiverr account, so several accounts can share one bot.

## Features

- **Instant alerts** for messages, orders and notifications, with the sender, account and the full message (long messages are split into numbered parts, never cut).
- **Several Fiverr accounts, one Telegram bot.** Each alert names the account.
- **Reply from Telegram (optional, off by default).** Swipe-reply to an alert and the answer is typed into that buyer's chat on Fiverr. Starts in test mode, asks for confirmation before every send, sends plain text only, capped per hour. It writes in your Fiverr tab, which Fiverr's rules may restrict, so use it at your own risk.
- **Watchdog.** Warns you if an account stops being watched.
- **Optional account** that syncs your settings between computers.
- **Lynch AI.** A built-in assistant that explains settings and can change them.
- **Studio updates.** New-version and announcement messages are forwarded to your own bot.

## How it works

```
Fiverr tab ──► extension (content script) ──► your own Telegram bot ──► your phone
                         ▲                                 │
                         │  reply relay (optional)         ▼
                  Cloudflare Worker  ◄──── Telegram webhook (swipe-reply)
```

- Alerts go straight from the browser to **your** Telegram bot. Buyer messages never pass through the server.
- By default the extension only reads what your logged-in Fiverr tab has already loaded. The optional reply feature is the one exception.
- The Worker (`_worker.js`) provides the website, extension accounts (settings sync), the reply relay, an admin dashboard, anonymous install counts and the site AI assistant. State lives in Cloudflare KV.

## Repository layout

| Path | What it is |
| --- | --- |
| `extension/` | The Chrome extension source (Manifest V3) |
| `_worker.js`, `wrangler.toml` | Cloudflare Worker + static site config |
| `index.html`, `admin.html`, `assets/` | Landing page and admin dashboard |
| `ai-worker/` | Separate Worker for the in-extension AI assistant |
| `lynch-digitance-alerts.zip`, `version.json` | The downloadable build and its update manifest |
| `MAIL-HOOK.example.gs` | Optional Apps Script that lets the admin page send email through Gmail |

## Install the extension

1. Download `lynch-digitance-alerts.zip` from the live site and unzip it.
2. Open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and choose the folder.
3. In the extension, paste your Telegram bot token (from @BotFather), message your bot once, press **Detect chat ID**, then **Send test**.

To update, unzip the new files over the same folder and press **Reload**. Your settings are kept.

## Deploy your own copy

```bash
npx wrangler kv namespace create ACCOUNTS     # put the id in wrangler.toml
npx wrangler secret put ADMIN_PASSWORD        # protects /admin
npx wrangler deploy
```

Optional secrets: `MAIL_HOOK_URL` and `MAIL_HOOK_SECRET` (see `MAIL-HOOK.example.gs`). Secrets live in Cloudflare, never in this repo.

## Privacy

- Settings stay in your browser unless you create the optional account, which stores your email, a hashed password and your synced settings.
- Once a day the extension sends an anonymous ping (random install ID, version, alert channel). It can be switched off in Settings.
- If Reply from Telegram is on, your replies wait on the server for up to 3 days until your extension collects them, then are deleted.
- No analytics on the site and no tracking of what you do.

## Status

Current version: see `version.json`. Questions or custom work: lynchdigitancestudios@gmail.com
