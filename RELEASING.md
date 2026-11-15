# Shipping an update to your users

## The constraint

Extensions installed with **Load unpacked** never auto-update. That's Chrome's rule.
Self-hosting a `.crx` with an `update_url` doesn't help either — Chrome only honours that
for enterprise force-installed extensions, not normal users.

**True auto-update requires the Chrome Web Store.** One-time $5 developer fee, a review of
a few days, and after that every user updates silently in the background with no action
from them. If this extension gets real traction, that $5 is the answer.

## What users do today (no uninstall needed)

This is the part that surprises people — it's much lighter than reinstalling:

1. Download the new zip
2. Unzip it **over their existing extension folder**, replacing the files
3. Restart Chrome

That's it. Chrome reads the folder fresh on every start. **Their settings survive** — the
bot token, chat ID and preferences live in browser storage, not in the folder. Nobody has
to redo setup, and nobody loses anything.

Uninstalling and re-adding also works but is pointless extra steps — and it *would* wipe
their settings, so tell them not to.

## The update notifier

The extension checks `version.json` on the site every 6 hours (and at browser start).
When a newer version is out:

- a gold **NEW** badge appears on the toolbar icon
- the popup shows a banner with the version, release notes, and a download button
- the banner spells out the replace-the-folder-and-restart instructions

There's also a **Check for update** button for checking on demand.

## Your release checklist

1. Make the code changes in `FIVERR NOTIFIER/`
2. Bump `"version"` in `manifest.json` (e.g. `1.7.0` → `1.8.0`)
3. Re-zip:

```powershell
$src = "C:\Users\USER\Desktop\claude-code folder\FIVERR NOTIFIER"
$dest = "C:\Users\USER\Desktop\claude-code folder\LYNCH ALERTS SITE\lynch-digitance-alerts.zip"
Remove-Item $dest -Force -ErrorAction SilentlyContinue
$items = Get-ChildItem $src | Where-Object { $_.Name -ne 'generate_icons.py' }
Compress-Archive -Path $items.FullName -DestinationPath $dest -CompressionLevel Optimal
```

4. Update `version.json` — the `version` must **match manifest.json exactly**, and write a
   one-line `notes` describing what changed
5. Redeploy the site folder to Cloudflare Pages (**Create new deployment** → drag the folder)

Within six hours every user sees the badge. Nobody gets stranded on an old build.

## ⚠️ The update URL is baked into every build — read this before deploying

The check address is compiled into each copy a user installs. A build shipped today
checks today's address **forever**. This has one consequence that bites hard:

> If you deploy to a domain that doesn't match what shipped, everyone already
> installed keeps checking the old address, finds nothing, and is never told
> another update exists. They can't be reached automatically ever again.

### So: name your Cloudflare Pages project to match what shipped

Builds from v1.10.0 onward check `https://lynch-digitance-alerts.pages.dev/version.json`,
so the Pages project must be named exactly:

```
lynch-digitance-alerts
```

Do this **before** announcing anything.

Adding a custom domain later is fine — Cloudflare keeps serving the `.pages.dev`
address alongside it, so installed builds keep finding `version.json`.

### If the site ever does move

`background.js` holds `UPDATE_MANIFEST_URLS` — a **list**, tried in order.

- **Add** the new URL at the top
- **Never delete** an address that has shipped; that's the only lifeline for builds
  still pointing at it
- Add every listed host to `manifest.json` → `host_permissions`, or Chrome blocks the
  fetch and the check fails silently

### Users on v1.6.0 or older

The update checker didn't exist before v1.7.0, so those builds have no code that looks
for updates. They cannot be notified automatically — message them once by hand. After
they update, they're on the automatic track permanently.
