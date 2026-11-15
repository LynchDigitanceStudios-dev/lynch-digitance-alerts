# Running the watchers on a server (Windows VPS / RDP)

A server is the **best** place to run this. It removes the extension's one real
limitation — your own machine no longer has to be on. The browser sits there
24/7 and alerts reach your phone wherever you are.

But an unattended machine has three traps that will silently cost you alerts.

---

## Trap 1 — Chrome throttles what nobody is looking at

This is the big one. Chrome slows timers in windows that aren't in the
foreground, and **on a server nothing is ever in the foreground.** Timers drop
to roughly one tick a minute and idle tabs get discarded to save memory. Your
alerts arrive late, or stop.

**Fix:** launch Chrome with throttling disabled. `start-watchers.bat` in this
folder does it — edit the `PROFILES` line to your account names and run it.

It also keeps the server from sleeping, and opens one profile per account so
your Fiverr sessions stay separate.

---

## Trap 2 — Disconnecting RDP freezes the desktop

Closing Remote Desktop with the ✕ **locks the session**. A locked Windows
session stops compositing, and Chrome can stop rendering — so the extension
stops seeing page changes even though Chrome is technically "running".

**Fix — disconnect without locking.** Instead of clicking ✕, open Command
Prompt **as Administrator** on the server and run:

```bat
for /f "skip=1 tokens=3" %s in ('query user %USERNAME%') do tscon %s /dest:console
```

That drops your RDP connection but leaves the session live and unlocked on the
server's console. Everything keeps rendering.

Make it a shortcut — save as `disconnect.bat` on the server desktop and run it
as admin whenever you're done:

```bat
@echo off
for /f "skip=1 tokens=3" %%s in ('query user %%USERNAME%%') do tscon %%s /dest:console
```

**Also turn off the screensaver and lock timeout:**
Settings → Personalization → Lock screen → Screen saver settings → uncheck
"On resume, display logon screen", set wait to `0`.

---

## Trap 3 — Silence looks exactly like "no messages"

If a tab logs out, crashes, or gets discarded, alerts just stop. Nothing tells
you. You'd assume it was a quiet day — and lose orders for as long as it takes
you to notice.

**Fix:** the extension's **Uptime** settings, on by default:

| Setting | What it does |
|---|---|
| **Watchdog** | An account stops checking in → `⚠️ WATCHER OFFLINE · Patrick account`, and `✅ BACK ONLINE` when it recovers |
| **Heartbeat** | Every 12h → `💓 Still watching` listing the live accounts |

The heartbeat is the important one. If the **whole browser or the server** dies,
the extension can't warn you — it's dead too. So the missing heartbeat is your
signal. It's a dead man's switch: no ping by morning means go look.

Set the heartbeat to something you'll actually notice the absence of. 12 hours
is a reasonable default; 24 if twice a day is too chatty.

---

## Start automatically at boot

So a server reboot doesn't leave you dark:

1. **Task Scheduler** → Create Task
2. **General:** "Run whether user is logged on or not" ❌ — you need
   "**Run only when user is logged on**", since Chrome needs a desktop session
3. **Triggers:** At log on (your user)
4. **Actions:** Start a program → browse to `start-watchers.bat`
5. **Conditions:** untick "Start the task only if the computer is on AC power"
6. **Settings:** untick "Stop the task if it runs longer than…"

Then enable auto-login on the server so a reboot restores the desktop session
automatically (`netplwiz` → untick "Users must enter a user name and password").

---

## The Fiverr-safety question

You're **already** running these accounts from this server, so the extension
adds no new exposure. It sends nothing to Fiverr — it only reads what those
tabs already loaded. The thing Fiverr notices is where you log in from, and
that hasn't changed.

What *would* change it: logging into a Fiverr account from the server for the
**first time**, especially if it's a different country from where you normally
use it. Do first logins the way you already do them, not as a side effect of
setting this up.

---

## Checklist

- [ ] `PROFILES` in `start-watchers.bat` edited to your accounts
- [ ] Run it once, then per window: log in → load the extension → set up Telegram → name the account → pin the tab
- [ ] `disconnect.bat` saved on the desktop, and used instead of the ✕
- [ ] Screensaver and lock-on-resume disabled
- [ ] Uptime watchdog + heartbeat on
- [ ] Task Scheduler entry at log on
- [ ] Auto-login enabled

Once that's done: reboot the server on purpose and confirm the watchers come
back on their own. Better to find out now than during a live order.
