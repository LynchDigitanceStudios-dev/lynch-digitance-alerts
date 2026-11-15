# Lynch Digitance Alerts — website

Static site. **No backend, no build step, no dependencies.** One HTML file plus assets.

```
LYNCH ALERTS SITE/
├── index.html                     the whole site
├── version.json                   the update announcement — see RELEASING.md
├── _headers                       cache rules (Cloudflare Pages + Netlify)
├── lynch-digitance-alerts.zip     what the Download button serves
├── DEPLOY.md / RELEASING.md       docs (harmless if uploaded)
└── assets/
    ├── logo.png / mark.png / wordmark.png   the LDS lockups
    ├── icon16/32/48/128.png                 extension icon + favicon
    └── make_logo_assets.py                  recuts the logos from the master
```

Upload this one folder. Everything is already in it.

---

## Deploy to Cloudflare Pages

### The project name is not cosmetic — get it right

The update-check URL is **compiled into every copy of the extension your users
install**. Builds from v1.10.0 onward look for:

```
https://lynch-digitance-alerts.pages.dev/version.json
```

So the Cloudflare Pages project **must** be named exactly:

```
lynch-digitance-alerts
```

Any other name and your users' extensions check an address that doesn't exist,
and they are never told an update is available.

### Direct upload (easiest)

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Pages**
2. Choose **Upload assets**
3. Project name: `lynch-digitance-alerts`
4. Drag the whole `LYNCH ALERTS SITE` folder in → **Deploy site**

Live at `https://lynch-digitance-alerts.pages.dev` in under a minute.

To publish an update later: same project → **Create new deployment** → drag the
folder again.

### Git-based (better if you'll update often)

1. Push this folder to a GitHub repo
2. Cloudflare Pages → **Connect to Git** → pick the repo
3. Framework preset: **None** · Build command: *(empty)* · Output directory: `/`

Every push deploys automatically.

---

## Confirm it worked

Open these two in a browser:

- `https://lynch-digitance-alerts.pages.dev` — the site loads
- `https://lynch-digitance-alerts.pages.dev/version.json` — shows `{"version": "1.10.0", ...}`

If the second one works, the update system is live.

---

## About caching

`_headers` marks `version.json` as **never cacheable**. This matters more on
Cloudflare than anywhere else: its default is to cache static files hard, and a
cached `version.json` means users keep being told the old version is current
long after you ship. Don't remove that rule.

The extension also requests with `cache: 'no-store'`, so both ends are covered.

---

## Custom domain (optional)

Cloudflare Pages → your project → **Custom domains** → add it. If the domain is
already on Cloudflare, DNS is configured for you. HTTPS is automatic and free.

**Keep the `.pages.dev` address working** — it's what every already-installed
extension checks. Cloudflare serves both, so adding a custom domain is safe.

---

## Netlify (the previous plan)

The site works unchanged on Netlify — `_headers` uses the same format. If you
deploy there too, name the site `lynch-digitance-alerts` so the legacy fallback
URL in the extension resolves. Running both is fine; the extension tries
Cloudflare first and falls back to Netlify.
