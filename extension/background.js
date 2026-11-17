import { LynchReview } from './review-core.js';
/*
 * background.js — service worker.
 *
 * Delivery does NOT touch WhatsApp Web. It sends a plain HTTPS request to a
 * relay that pushes a WhatsApp message to your own number. No WhatsApp login
 * in this browser, no linked-device slot used, nothing hosted, no cost.
 *
 * Channels: CallMeBot (WhatsApp), Telegram bot, or a generic webhook.
 */

/* Where the extension checks for new versions, tried in order until one answers.
 *
 * This is a LIST on purpose. The URL is compiled into every copy a user installs,
 * so a build shipped today keeps checking today's address forever — if the site
 * ever moves, everyone already installed is stranded on a dead endpoint with no
 * way to be told. Keeping old addresses in the list means those builds still find
 * an answer at one of them.
 *
 * Rules when the site moves:
 *   - ADD the new URL at the top; never delete an old one that shipped
 *   - keep every listed host in manifest.json > host_permissions, or the fetch
 *     is blocked and the check fails silently
 */
const UPDATE_MANIFEST_URLS = [
  'https://alerts.lynchdigitancestudios.workers.dev/version.json',   // live site (primary)
  'https://lynch-digitance-alerts.pages.dev/version.json'            // kept for builds that shipped with it
];

/* Lynch AI lives in its own Worker, deliberately separate from the website
 * assistant: it holds ONLY this extension's knowledge, accepts requests only
 * from extension origins, and has its own rate limit. Deployed from
 * LYNCH ALERTS SITE/ai-worker. */
const AI_ENDPOINT = 'https://alerts-ai.lynchdigitancestudios.workers.dev/chat';

const DEFAULTS = {
  enabled: true,
  channel: 'telegram',      // 'telegram' | 'callmebot' | 'webhook'
  waNumber: '',             // digits only, with country code, no + or spaces
  apiKey: '',               // CallMeBot key
  tgToken: '',              // Telegram bot token
  tgChatId: '',             // Telegram chat id
  webhookUrl: '',
  accountLabels: {},        // { fiverrUsername: "friendly name" }
  fvnMaint: null,           // { on, msg, id } pushed from the studio
  shareInstall: true,       // anonymous once-a-day install count (random id, version, channel)
  watchdog: true,           // warn when a watched account goes silent
  watchdogMins: 20,         // how long silent before warning
  heartbeatHours: 8,        // periodic "still alive" ping
  privacyMode: false,       // omit message body, send sender + account only
  debugMode: false,         // capture raw Fiverr signals for troubleshooting
  desktopNotif: true,
  quietUntil: 0,
  maxLen: 500
};

/* Settings that used to be on the Settings page. They are fixed now: nobody has to configure them. */
const FIXED = {
  enabled: true, desktopNotif: true, privacyMode: false, debugMode: false,
  watchdog: true, watchdogMins: 20, heartbeatHours: 8, shareInstall: true, accountLabels: {}
};
async function cfg() {
  const { fvnAdv = {} } = await chrome.storage.local.get('fvnAdv');       // set on the Advanced page
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)), ...FIXED, ...fvnAdv, shareInstall: true };
}
// Clear whatever older versions or synced accounts stored for those settings, but keep Advanced choices.
chrome.runtime.onInstalled.addListener(async () => {
  const { fvnAdv = {} } = await chrome.storage.local.get('fvnAdv');
  await chrome.storage.local.set({ ...FIXED, ...fvnAdv });
});

// ---------------------------------------------------------------- dedupe
/* Kept in storage, not memory. An in-memory set died with every page load,
   which is why refreshing or navigating replayed the whole backlog. Entries
   are content fingerprints, so a message and its notification echo collapse
   into one alert. */
const DEDUPE_TTL = 7 * 24 * 60 * 60 * 1000;   // a week
const DEDUPE_MAX = 3000;

async function isDupe(fp) {
  if (!fp) return false;
  const { fvnSeen = {} } = await chrome.storage.local.get('fvnSeen');
  const now = Date.now();

  if (fvnSeen[fp] && now - fvnSeen[fp] < DEDUPE_TTL) return true;

  fvnSeen[fp] = now;
  for (const k in fvnSeen) if (now - fvnSeen[k] > DEDUPE_TTL) delete fvnSeen[k];

  const keys = Object.keys(fvnSeen);
  if (keys.length > DEDUPE_MAX) {
    keys.sort((a, b) => fvnSeen[a] - fvnSeen[b])
        .slice(0, keys.length - DEDUPE_MAX)
        .forEach(k => delete fvnSeen[k]);
  }
  await chrome.storage.local.set({ fvnSeen });
  return false;
}

// ---------------------------------------------------------------- format
const ICONS = {
  message: '💬', notification: '🔔', brief: '📋',
  order: '🛒', review: '⭐', alert: '⚠️'
};
const LOUD = { order: 'NEW ORDER', brief: 'BRIEF', review: 'REVIEW' };

/* Telegram hard-caps a message at 4096 characters. Leave room for the header
   and the link, or a long buyer brief fails to send outright. */
const HARD_CAP = 3400;

function format(e, c) {
  const icon = ICONS[e.type] || '🔔';
  let body;
  if (c.privacyMode) {
    body = '(privacy mode — open Fiverr to read)';
  } else {
    body = String(e.text || '')
      .replace(/<[^>]*>/g, ' ')            // belt-and-braces HTML strip
      .replace(/\s+/g, ' ')
      .trim();
    // Never shorten a buyer's message: Telegram sends are split into numbered parts instead.
  }
  /* A custom label beats the raw username — several accounts often use
     near-identical names, and you shouldn't have to squint at a phone to
     work out which inbox just lit up. Username stays in brackets so the
     mapping is never ambiguous. */
  const label = (c.accountLabels || {})[e.account];
  const who = label ? `${label} (${e.account})` : e.account;

  return [
    'LYNCH DIGITANCE · ALERTS' + (c.fvnMaint && c.fvnMaint.on ? (c.fvnMaint.kind === 'update' ? ' · ⬆️ UPDATE REQUIRED' : ' · 🔧 UNDERGOING MAINTENANCE') : ''),
    `${icon} ${LOUD[e.type] ? 'Fiverr ' + LOUD[e.type] : 'Fiverr'} · ${who}`,
    `From: ${e.from}`,
    '',
    body,
    '',
    e.url && e.url.startsWith('http') ? e.url : 'https://www.fiverr.com/inbox'
  ].join('\n');
}

/* Telegram caps one message at 4096 characters. A long buyer message is never cut: it is split
 * at a word boundary into numbered parts. Every part repeats the 3 header lines and the link, so
 * swipe-replying to ANY part still routes to the right account and buyer. */
function tgParts(text) {
  const MAX = 4000;
  if (text.length <= MAX) return [text];
  const lines = text.split('\n');
  const head = lines.slice(0, 3).join('\n');
  const foot = lines[lines.length - 1];
  const body = lines.slice(3, -1).join('\n').trim();
  const room = MAX - head.length - foot.length - 40;
  const chunks = [];
  let rest = body;
  while (rest.length > room) {
    let cut = Math.max(rest.lastIndexOf('\n', room), rest.lastIndexOf(' ', room));
    if (cut < room * 0.6) cut = room;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.map((ch, i) => head + '\nPart ' + (i + 1) + '/' + chunks.length + '\n\n' + ch + '\n\n' + foot);
}

// ---------------------------------------------------------------- delivery
async function send(text, c, kb) {
  try {
    if (c.channel === 'callmebot') {
      if (!c.waNumber || !c.apiKey) return { ok: false, reason: 'missing-number-or-apikey' };

      // CallMeBot's docs use a leading "+". Some accounts are registered with it,
      // some without — try both before giving up.
      const digits = c.waNumber.replace(/[^0-9]/g, '');
      const variants = ['+' + digits, digits];
      let last = '';

      for (const phone of variants) {
        const url = 'https://api.callmebot.com/whatsapp.php'
          + `?phone=${encodeURIComponent(phone)}`
          + `&text=${encodeURIComponent(text)}`
          + `&apikey=${encodeURIComponent(c.apiKey)}`;

        let r, body;
        try {
          r = await fetch(url, { method: 'GET' });
          body = await r.text();
        } catch (e) {
          last = 'network: ' + String(e);
          continue;
        }

        // Their response is an HTML page. Strip tags before judging it, and
        // look for an explicit success phrase rather than guessing from absence
        // of the word "error" (their boilerplate contains it either way).
        const plain = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        last = `http-${r.status}: ${plain.slice(0, 240) || '(empty response)'}`;

        if (r.ok && /message\s*(queued|sent|delivered)|success|APIKey.*valid/i.test(plain)) {
          return { ok: true };
        }
        if (/apikey|api key/i.test(plain) && /invalid|wrong|missing|not\s*valid/i.test(plain)) {
          return { ok: false, reason: 'BAD API KEY — ' + plain.slice(0, 160) };
        }
        if (/not\s*(registered|authorized|allowed)|didn'?t\s*receive/i.test(plain)) {
          return { ok: false, reason: 'NUMBER NOT REGISTERED with CallMeBot — ' + plain.slice(0, 160) };
        }
      }
      return { ok: false, reason: last || 'callmebot-no-response' };
    }

    if (c.channel === 'telegram') {
      if (!c.tgToken || !c.tgChatId) return { ok: false, reason: 'missing-telegram-config' };
      for (const part of tgParts(text)) {
        const r = await fetch(`https://api.telegram.org/bot${c.tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ chat_id: c.tgChatId, text: part, disable_web_page_preview: true }, kb ? { reply_markup: kb } : {}))
        });
        const j = await r.json().catch(() => ({}));
        if (!j.ok) return { ok: false, reason: j.description || ('http-' + r.status) };
      }
      return { ok: true };
    }

    if (c.channel === 'webhook') {
      if (!c.webhookUrl) return { ok: false, reason: 'missing-webhook-url' };
      const r = await fetch(c.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, text })   // works with Discord + Slack-ish
      });
      return r.ok ? { ok: true } : { ok: false, reason: 'http-' + r.status };
    }

    return { ok: false, reason: 'no-channel-selected' };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

// Relays rate-limit; serialise sends and space them out.
const queue = [];
let draining = false;

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const c = await cfg();
      const item = queue[0];
      const r = await send(item.text, c, item.kb);
      await log({ ts: Date.now(), account: item.account, from: item.from,
                  type: item.type, delivered: r.ok, reason: r.reason || '' });
      if (r.ok) {
        queue.shift();
        if (!item.noBadge) await bumpUnread(item.account);   // heartbeats aren't new Fiverr activity
        await new Promise(res => setTimeout(res, 4000));   // relay-friendly pacing
      } else {
        item.tries = (item.tries || 0) + 1;
        if (item.tries >= 4) queue.shift();                // give up, keep it in the log
        break;                                             // retry on the next alarm
      }
    }
  } finally {
    draining = false;
  }
}

/* Chrome only injects content scripts on page load, so reloading the extension
   leaves every open Fiverr tab unwatched until you manually refresh it. Inject
   into them directly instead — on install, on browser start, and hourly as a
   self-heal if the service worker was ever restarted. */
async function injectExistingTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'https://*.fiverr.com/*' }); } catch { return; }
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['fiverr-hook.js'],
        world: 'MAIN'
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['fiverr-content.js'],
        world: 'ISOLATED'
      });
    } catch {}   // already injected, or a page we can't touch
  }
}

/* Where Chrome sends someone after they remove the extension. Carries the
   version they left on, so the feedback says which build they gave up on. */
function setGoodbyePage() {
  try {
    const origin = new URL(UPDATE_MANIFEST_URLS[0]).origin;
    const v = chrome.runtime.getManifest().version;
    chrome.runtime.setUninstallURL(`${origin}/goodbye.html?v=${encodeURIComponent(v)}`);
  } catch {}
}
chrome.runtime.onInstalled.addListener(setGoodbyePage);
chrome.runtime.onStartup.addListener(setGoodbyePage);

chrome.runtime.onInstalled.addListener(injectExistingTabs);
chrome.runtime.onStartup.addListener(injectExistingTabs);

/* ---------------------------------------------------------------- updates
   Unpacked extensions never auto-update, so instead of leaving users stranded
   on an old build we check a small version.json on the site and tell them.
   Updating is then: replace the folder contents, restart Chrome. */

function newerThan(remote, local) {
  const a = String(remote).split('.').map(Number);
  const b = String(local).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/* Tries each known endpoint in turn; the first valid answer wins. */
async function fetchVersionManifest() {
  let last = 'no-endpoint';
  for (const url of UPDATE_MANIFEST_URLS) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) { last = 'http-' + r.status; continue; }
      const j = await r.json();
      if (j && j.version) return j;
      last = 'malformed-version-json';
    } catch (e) {
      last = String(e);
    }
  }
  throw new Error(last);
}

async function checkForUpdate(manual = false) {
  const local = chrome.runtime.getManifest().version;
  try {
    const j = await fetchVersionManifest();

    if (j.version && newerThan(j.version, local)) {
      const info = {
        available: true,
        version: j.version,
        notes: j.notes || '',
        url: j.url || '',
        checked: Date.now()
      };
      await chrome.storage.local.set({ fvnUpdate: info });
      await refreshBadge();

      /* A badge only works on someone who happens to look at the toolbar.
         Fire one desktop notification per version — once, never nagging —
         and send it through the user's alert channel too, since that's the
         one place we know they actually read. */
      const { fvnNotifiedVersion } = await chrome.storage.local.get('fvnNotifiedVersion');
      if (fvnNotifiedVersion !== j.version) {
        await chrome.storage.local.set({ fvnNotifiedVersion: j.version });

        try {
          chrome.notifications.create('fvn-update-' + j.version, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon128.png'),
            title: `Update available — v${j.version}`,
            message: (j.notes || 'A new version is ready.') + '\nClick to download.',
            priority: 1
          });
        } catch {}

        if (!manual) {
          const c = await cfg();
          if (c.enabled) {
            await send([
              'LYNCH DIGITANCE · ALERTS',
              `⬆️ Update available — v${j.version}`,
              '',
              j.notes || 'A new version is ready.',
              '',
              j.url || ''
            ].join('\n'), c);
          }
        }
      }
      return { ok: true, ...info };
    }

    await chrome.storage.local.set({
      fvnUpdate: { available: false, version: local, checked: Date.now() }
    });
    await refreshBadge();
    return { ok: true, available: false, version: local };
  } catch (e) {
    if (manual) return { ok: false, reason: String(e) };
    return { ok: false };
  }
}

/* Clicking the update notification opens the download page. */
chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('fvn-update-')) return;
  const { fvnUpdate = {} } = await chrome.storage.local.get('fvnUpdate');
  if (fvnUpdate.url) chrome.tabs.create({ url: fvnUpdate.url });
  chrome.notifications.clear(id);
});

chrome.runtime.onInstalled.addListener(() => checkForUpdate());
chrome.runtime.onStartup.addListener(() => checkForUpdate());
chrome.alarms.create('fvn-update', { periodInMinutes: 360 });   // every 6h

/* ---------------------------------------------- install count + announcements
 * Once a day: an anonymous ping (random install id, version, channel, signed-in yes/no),
 * so the studio can count installs that never made an account. Nothing else is sent: no
 * Fiverr data, no messages, no tokens. Can be switched off in Settings.
 * Announcements: the studio can publish a short update. Each install sends it ONCE to the
 * user's own alert channel (their own Telegram bot), so it reaches everyone, account or not. */
/* Maintenance switch from the studio: shown in the popup, tagged on every alert, and announced
 * once on the way in and once on the way out. */
async function applyMaint(m, c) {
  // A notice can be limited to builds older than m.minVersion ("update required"): a build that is already
  // new enough simply ignores it.
  if (m && m.on && m.minVersion && !newerThan(m.minVersion, chrome.runtime.getManifest().version)) m = { on: false, id: m.id };
  const { fvnMaint, fvnMaintSeen } = await chrome.storage.local.get(['fvnMaint', 'fvnMaintSeen']);
  const was = !!(fvnMaint && fvnMaint.on);
  const upd = m.kind === 'update';
  await chrome.storage.local.set({ fvnMaint: m.on ? { on: true, msg: m.msg || '', id: m.id, kind: m.kind || '', block: !!m.block } : null });
  const key = (m.id || '') + ':' + (m.on ? 1 : 0);
  if (key !== fvnMaintSeen && (m.on || was)) {
    if (c.enabled) {
      await send(m.on
        ? ['LYNCH DIGITANCE · ALERTS', upd ? '⬆️ UPDATE REQUIRED' : '🔧 UNDERGOING MAINTENANCE', '', m.msg || 'Alerts may be delayed.'].join('\n')
        : ['LYNCH DIGITANCE · ALERTS', '✅ Back to normal', '', 'Maintenance is finished. Alerts are running as usual.'].join('\n'), c);
    }
    await chrome.storage.local.set({ fvnMaintSeen: key });
  }
  await refreshBadge();
}

async function fvnAnnounceAndPing() {
  try {
    const c = await cfg();
    const st = await chrome.storage.local.get(['fvnInstallId', 'fvnPingAt', 'fvnAnnSeen', 'acctToken']);
    if (c.shareInstall !== false && Date.now() - (st.fvnPingAt || 0) > 20 * 3600e3) {
      let id = st.fvnInstallId;
      if (!id) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(20)), x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
        await chrome.storage.local.set({ fvnInstallId: id });
      }
      const r = await fetch(ACCT_API + '/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, v: chrome.runtime.getManifest().version, ch: c.channel || '', a: !!st.acctToken }) });
      if (r.ok) await chrome.storage.local.set({ fvnPingAt: Date.now() });
    }
    const r2 = await fetch(ACCT_API + '/announce', { cache: 'no-store' });
    const a = r2.ok ? await r2.json() : null;
    if (a && a.maint) await applyMaint(a.maint, c);
    // "Only installs older than X": an extension already at that version (or newer) ignores it.
    const eligible = !a || !a.minVersion || newerThan(a.minVersion, chrome.runtime.getManifest().version);
    if (a && a.id && eligible && a.id !== st.fvnAnnSeen && Date.now() - (a.at || 0) < 30 * 86400e3) {
      if (c.enabled) {
        await send(['LYNCH DIGITANCE · ALERTS', '📣 ' + (a.title || 'Update from the studio'), '', a.text].join('\n'), c);
      }
      await chrome.storage.local.set({ fvnAnnSeen: a.id });
    }
  } catch (e) { /* try again at the next check */ }
}
chrome.alarms.create('fvn-announce', { periodInMinutes: 15 });   // cheap: one tiny GET
chrome.runtime.onInstalled.addListener(() => fvnAnnounceAndPing());
chrome.runtime.onStartup.addListener(() => fvnAnnounceAndPing());

/* ------------------------------------------------------------- watchdog
 * Running on a server means nobody is looking at the screen. A tab that got
 * logged out, crashed, or was discarded stops watching silently — and silence
 * is indistinguishable from "no messages today". These two checks make the
 * failure loud instead.
 *
 *  watchdog  — an account stops checking in  → warn, and say when it returns
 *  heartbeat — periodic "still alive" message. If the whole browser or server
 *              dies the extension can't warn you, so absence of the heartbeat
 *              is the signal. A dead man's switch.
 */
/* Names that are placeholders, not accounts. Earlier builds recorded these as
   real accounts, which is where "WATCHER OFFLINE · unknown" came from. */
const PLACEHOLDER_USERS = new Set([
  'unknown', 'undefined', 'null', 'me', 'you', 'user', 'users',
  'inbox', 'dashboard', 'seller_dashboard', 'unidentified', ''
]);

function isRealUser(u) {
  return typeof u === 'string'
      && /^[A-Za-z0-9_.-]{3,40}$/.test(u.trim())
      && !PLACEHOLDER_USERS.has(u.trim().toLowerCase());
}

/* One-time repair for storage written by earlier builds. */
async function purgePhantomAccounts() {
  const { fvnAccounts = {}, fvnWatchdog = {}, fvnUnseen = {} } =
    await chrome.storage.local.get(['fvnAccounts', 'fvnWatchdog', 'fvnUnseen']);

  let removed = 0;
  for (const store of [fvnAccounts, fvnWatchdog, fvnUnseen]) {
    for (const k of Object.keys(store)) {
      if (!isRealUser(k)) { delete store[k]; removed++; }
    }
  }
  if (removed) {
    await chrome.storage.local.set({ fvnAccounts, fvnWatchdog, fvnUnseen });
    await refreshBadge();
  }
  return removed;
}

chrome.runtime.onInstalled.addListener(purgePhantomAccounts);
chrome.runtime.onStartup.addListener(purgePhantomAccounts);

/* What you get when an account is watched again: how long it was away and what is waiting. */
function backOnlineText(account, awayMs, unread, wasFlagged) {
  const mins = Math.round(awayMs / 60000);
  const away = mins < 120 ? mins + ' min' : Math.round(mins / 60) + ' h';
  return [
    'LYNCH DIGITANCE · ALERTS',
    '▶️ BACK ONLINE · ' + account,
    '',
    'Away for ' + away + '. ' + (unread > 0
      ? unread + ' unread on Fiverr right now. Anything that arrived while it was off is not listed one by one.'
      : 'Nothing unread on Fiverr right now.'),
    '',
    'https://www.fiverr.com/inbox'
  ].join('\n');
}

async function runWatchdog() {
  const c = await cfg();
  if (!c.enabled) return;

  const { fvnAccounts = {}, fvnWatchdog = {}, fvnUnread = {} } =
    await chrome.storage.local.get(['fvnAccounts', 'fvnWatchdog', 'fvnUnread']);

  const now = Date.now();
  const limit = Math.max(5, c.watchdogMins) * 60 * 1000;
  let changed = false;

  for (const [user, lastSeen] of Object.entries(fvnAccounts)) {
    if (!isRealUser(user)) continue;                 // never warn about a phantom
    const named = (c.accountLabels || {})[user];
    // Always name the username, so an unlabelled account is still identifiable
    // at a glance — the whole point of the alert.
    const label = named ? `${named} (${user})` : user;
    const silent = now - lastSeen > limit;

    if (c.watchdog && silent && !fvnWatchdog[user]) {
      fvnWatchdog[user] = now;
      changed = true;
      queue.push({
        text: [
          'LYNCH DIGITANCE · ALERTS',
          `⚠️ WATCHER OFFLINE · ${label}`,
          '',
          `No activity from this account for ${c.watchdogMins}+ minutes.`,
          'The Fiverr tab may be closed, logged out, or discarded.',
          '',
          'https://www.fiverr.com/inbox'
        ].join('\n'),
        account: user, from: 'Watchdog', type: 'alert'
      });
    } else if (!silent && fvnWatchdog[user]) {
      const awayMs = now - fvnWatchdog[user];
      delete fvnWatchdog[user];
      changed = true;
      queue.push({
        text: backOnlineText(user, awayMs + limit, fvnUnread[user] || 0, true),
        account: user, from: 'Watchdog', type: 'alert'
      });
    }
  }

  if (changed) await chrome.storage.local.set({ fvnWatchdog });
  if (queue.length) drain();
}

async function runHeartbeat() {
  const c = await cfg();
  if (!c.enabled || !c.heartbeatHours) return;

  const { fvnHeartbeat = 0, fvnAccounts = {} } =
    await chrome.storage.local.get(['fvnHeartbeat', 'fvnAccounts']);

  const due = Date.now() - fvnHeartbeat > c.heartbeatHours * 3600 * 1000;
  if (!due) return;
  await chrome.storage.local.set({ fvnHeartbeat: Date.now() });
  if (!fvnHeartbeat) return;            // don't fire on the very first run

  const labels = c.accountLabels || {};
  const nameOf = u => labels[u] ? `${labels[u]} (${u})` : u;
  const known = Object.entries(fvnAccounts).filter(([u]) => isRealUser(u)).sort((a, b) => b[1] - a[1]);
  const liveUsers = known.filter(([, t]) => Date.now() - t < 10 * 60 * 1000).map(([u]) => u);
  const ago = t => {
    const m = Math.max(1, Math.round((Date.now() - t) / 60000));
    return m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  };

  let body;
  if (liveUsers.length) {
    body = liveUsers.map(nameOf).join('\n');
  } else {
    body = '⚠️ No account is currently active!';
    // Say which accounts WERE being watched, so you know exactly what went quiet.
    if (known.length) {
      body += '\n\nWas watching:\n' +
        known.map(([u, t]) => '• ' + nameOf(u) + ' — last seen ' + ago(t)).join('\n');
    }
  }

  queue.push({
    text: ['LYNCH DIGITANCE · ALERTS', liveUsers.length ? '💓 Still watching' : '⚠️ Heartbeat', '', body].join('\n'),
    account: liveUsers[0] || 'system', from: 'Heartbeat', type: 'alert', noBadge: true
  });
  drain();
}

chrome.alarms.create('fvn-watchdog', { periodInMinutes: 5 });
/* Dashboard snapshots were removed. Clean up what an earlier build may have
   left behind: the timer, the saved settings, and the screenshot permission. */
async function removeSnapshotLeftovers() {
  try { await chrome.alarms.clear('fvn-snap'); } catch {}
  try { await chrome.storage.local.remove(['snapEnabled', 'snapHours', 'snapFocus']); } catch {}
  try { await chrome.permissions.remove({ origins: ['<all_urls>'] }); } catch {}
}
chrome.runtime.onInstalled.addListener(removeSnapshotLeftovers);
chrome.runtime.onStartup.addListener(removeSnapshotLeftovers);

/* ------------------------------------------------------- settings sync
 * Signed in: every setting below lives on the account, so a new install or
 * another device picks it all up by signing in. Pushed on Save, pulled on
 * sign-in, on browser start and every 15 minutes. */
const ACCT_API = 'https://alerts.lynchdigitancestudios.workers.dev';
const SYNC_KEYS = ['enabled', 'channel', 'waNumber', 'apiKey', 'tgToken', 'tgChatId', 'webhookUrl',
  'privacyMode', 'desktopNotif', 'maxLen', 'maxNotifAgeMins',
  'watchdog', 'watchdogMins', 'heartbeatHours'];

async function acctFetch(path, method, body) {
  const { acctToken } = await chrome.storage.local.get('acctToken');
  const r = await fetch(ACCT_API + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Ext-Version': chrome.runtime.getManifest().version, ...(acctToken ? { Authorization: 'Bearer ' + acctToken } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && acctToken && !/\/account\/(login|register)$/.test(path)) {
    await chrome.storage.local.remove(['acctToken']);            // session expired
  }
  return { ok: r.ok, status: r.status, data };
}

async function syncSnapshot() {
  const all = await chrome.storage.local.get(SYNC_KEYS);
  const out = {};
  for (const k of SYNC_KEYS) if (all[k] !== undefined) out[k] = all[k];
  return out;
}

async function applyRemote(settings) {
  if (!settings || typeof settings !== 'object') return;
  const clean = {};
  for (const k of SYNC_KEYS) if (settings[k] !== undefined) clean[k] = settings[k];
  if (Object.keys(clean).length) await chrome.storage.local.set(clean);
}

/* One sync, both directions, safe to run from anywhere.
 *
 * The old version pushed THIS computer's settings first and pulled second, so
 * pressing Sync on a computer holding stale values overwrote the good copy on
 * the account. Now:
 *   - acctBase remembers what the account held at the last sync;
 *   - anything that differs from it is a change made HERE, and only those keys
 *     are sent up, merged into whatever the account holds now;
 *   - everything else is taken from the account.
 * So a change on one computer can never wipe a change made on another. */
const sameVal = (x, y) => JSON.stringify(x) === JSON.stringify(y);
let syncing = null;

function syncNow() {
  if (!syncing) syncing = runSync().catch(e => ({ ok: false, error: 'Could not reach the server.' }))
    .finally(() => { syncing = null; });
  return syncing;
}

async function runSync() {
  const { acctToken, acctBase } = await chrome.storage.local.get(['acctToken', 'acctBase']);
  if (!acctToken) return { ok: false, error: 'not signed in' };

  const g = await acctFetch('/account/settings', 'GET');
  if (!g.ok) return { ok: false, error: g.data.error };
  const remote = g.data.settings || {};
  const local = await syncSnapshot();
  const base = acctBase || remote;              // never synced before: assume nothing changed here

  const dirty = SYNC_KEYS.filter(k => local[k] !== undefined && !sameVal(local[k], base[k]));
  const merged = Object.assign({}, remote);
  for (const k of dirty) merged[k] = local[k];

  if (dirty.length && !sameVal(merged, remote)) {
    const p = await acctFetch('/account/settings', 'PUT', { settings: merged });
    if (!p.ok) return { ok: false, error: p.data.error };
  }

  await applyRemote(merged);                    // brings in other computers' changes, keeps ours
  await chrome.storage.local.set({ acctBase: merged });
  const changed = SYNC_KEYS.some(k => merged[k] !== undefined && !sameVal(merged[k], local[k]));
  return { ok: true, pushed: dirty.length > 0, changed };
}

chrome.runtime.onStartup.addListener(() => { syncNow(); });

// Fresh install: open the settings page so the sign-up prompt is seen straight away.
chrome.runtime.onInstalled.addListener(d => { if (d.reason === 'install') chrome.runtime.openOptionsPage(); });
chrome.alarms.create('fvn-sync', { periodInMinutes: 15 });

/* ============================================================ REPLY FROM TELEGRAM
 * Optional, OFF by default. You swipe-reply to an alert in Telegram; the relay (our
 * Worker) works out which Fiverr account and buyer it is for and puts it in that
 * account's mailbox; the browser profile for that account collects it, asks you to
 * confirm in Telegram, then types it into the buyer's conversation on Fiverr.
 *
 * This is the one feature that WRITES in the Fiverr tab instead of only reading, so it
 * is switched on per Fiverr account, starts in TEST mode (types but never sends), asks
 * for confirmation by default, sends text only, never retries a send, and is capped.
 */
const REPLY_PER_HOUR = 15;
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const acksFor = {};                 // account -> ids to acknowledge on the next poll
let replyBusy = false, replyTickN = 0;

const RC_DEF = { replyEnabled: false, replyAccounts: {}, replyMode: 'live', replyConfirm: true,
                 replySeen: [], replyPending: {}, replySent: {} };
// One switch: when replies are on they work for every account in this browser, and every send is confirmed in Telegram.
const replyCfg = async () => ({ ...(await chrome.storage.local.get(RC_DEF)), replyMode: 'live', replyConfirm: true });
const REPLY_BTN = { inline_keyboard: [[{ text: '↩️ Reply', callback_data: 'rp' }]] };
async function setReplyState(state, extra) {
  await chrome.storage.local.set({ replyState: Object.assign({ at: Date.now(), state }, extra || {}) });
}

async function tgApi(token, method, body) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}
const tgNote = (c, text, extra) => tgApi(c.tgToken, 'sendMessage',
  Object.assign({ chat_id: c.tgChatId, text, disable_web_page_preview: true }, extra || {}));

/* Turning the feature on: register this chat with the relay, then point the bot's webhook
 * at it. Idempotent, so every profile sharing the bot can run it. */
async function replySetup() {
  const c = await cfg();
  const { acctToken } = await chrome.storage.local.get('acctToken');
  if (!acctToken) return { ok: false, error: 'Sign in to your extension account first (Account section) — replies need it.' };
  if (c.channel !== 'telegram' || !c.tgToken || !c.tgChatId) {
    return { ok: false, error: 'Set up Telegram first (bot token and chat ID), and press Save.' };
  }
  const r = await acctFetch('/relay/enable', 'POST', { chatId: String(c.tgChatId) });
  if (!r.ok) return { ok: false, error: r.data.error || 'The reply relay is unavailable.' };
  const info = await tgApi(c.tgToken, 'getWebhookInfo');
  if (!info.ok) return { ok: false, error: 'Telegram: ' + (info.description || 'could not check the bot') };
  if (r.data.fresh || !info.result || info.result.url !== r.data.url) {
    const s = await tgApi(c.tgToken, 'setWebhook', {
      url: r.data.url, secret_token: r.data.secret, allowed_updates: ['message', 'callback_query'], max_connections: 4 });
    if (!s.ok) return { ok: false, error: 'Telegram: ' + (s.description || 'could not connect the bot') };
  }
  return { ok: true };
}

async function replyTab(account) {
  const { fvnTabs = {} } = await chrome.storage.local.get('fvnTabs');
  const id = fvnTabs[account];
  if (!id) return null;
  try {
    const t = await chrome.tabs.get(id);
    return /fiverr\.com/.test(t.url || '') ? t : null;
  } catch { return null; }
}

/* Opens the buyer's conversation in this account's Fiverr tab and asks the page to type
 * (and, in live mode, send) the text. */
async function performReply(p, mode) {
  const tab = await replyTab(p.account);
  if (!tab) return { ok: false, error: 'No Fiverr tab is open for ' + p.account + ' in this browser.' };
  const needle = '/inbox/' + p.buyer.toLowerCase();
  if (!(tab.url || '').toLowerCase().includes(needle)) {
    await chrome.tabs.update(tab.id, { url: 'https://www.fiverr.com/inbox/' + encodeURIComponent(p.buyer) });
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      await sleepMs(600);
      const t = await chrome.tabs.get(tab.id).catch(() => null);
      if (t && t.status === 'complete' && (t.url || '').toLowerCase().includes(needle)) break;
    }
    await sleepMs(2500);
  }
  for (let i = 0; i < 12; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id,
        { kind: 'fvn-do-reply', account: p.account, buyer: p.buyer, text: p.text, mode });
      if (r) return r;
    } catch (e) { /* page still starting */ }
    await sleepMs(1000);
  }
  return { ok: false, error: 'The Fiverr page did not respond.' };
}

async function runReply(id, c) {
  const rc = await replyCfg();
  const p = rc.replyPending[id];
  if (!p) return;
  const now = Date.now();
  const done = text => p.prompt
    ? tgApi(c.tgToken, 'editMessageText', { chat_id: c.tgChatId, message_id: p.prompt, text })
    : tgNote(c, text);
  const drop = async () => {
    const cur = (await chrome.storage.local.get({ replyPending: {} })).replyPending;
    delete cur[id];
    await chrome.storage.local.set({ replyPending: cur });
  };

  const recent = (rc.replySent[p.account] || []).filter(t => now - t < 3600e3);
  if (recent.length >= REPLY_PER_HOUR) {
    await done('❌ Not sent. ' + REPLY_PER_HOUR + ' replies have already gone out from ' + p.account + ' in the last hour.');
    return drop();
  }

  const mode = rc.replyMode === 'live' ? 'live' : 'test';
  const r = await performReply(p, mode);

  if (r.ok && r.sent) {
    recent.push(Date.now());
    const sent = (await chrome.storage.local.get({ replySent: {} })).replySent;
    sent[p.account] = recent;
    await chrome.storage.local.set({ replySent: sent });
    await done('✅ Sent to ' + p.buyer + ' as ' + p.account + '.' +
      (r.unconfirmed ? '\n(Fiverr did not show it back yet. Check the conversation to be sure.)' : ''));
  } else if (r.ok) {
    await done('📝 Typed into the message box for ' + p.buyer + ' on ' + p.account + ', but NOT sent: you are in test mode.\n' +
      'Switch to Live in the extension (Settings → Reply from Telegram) when you are happy with it.');
  } else {
    await done('❌ Could not send to ' + p.buyer + ' as ' + p.account + ':\n' + r.error);
  }
  await log({ ts: Date.now(), account: p.account, from: p.buyer, type: 'reply',
              delivered: !!r.ok, reason: r.ok ? (r.sent ? 'sent' : 'test mode') : r.error });
  return drop();
}

async function handleRelayItem(account, item, c, rc) {
  bumpReplyBurst();
  if (item.t === 'reply') {
    const ageMin = (Date.now() - item.at) / 60000;
    const ask = rc.replyConfirm || ageMin > 5;          // a late reply ALWAYS asks first
    const pending = rc.replyPending;
    const now = Date.now();
    for (const k of Object.keys(pending)) if (now - pending[k].at > 7 * 86400e3) delete pending[k];
    pending[item.id] = { account, buyer: item.buyer, text: item.text, at: item.at };
    await chrome.storage.local.set({ replyPending: pending });

    if (!ask) return runReply(item.id, c);

    const age = ageMin > 5
      ? '\n(You wrote this ' + (ageMin < 120 ? Math.round(ageMin) + ' min' : Math.round(ageMin / 60) + ' h') + ' ago.)' : '';
    const test = rc.replyMode === 'live' ? '' : '\nTEST MODE: it will be typed in, not sent.';
    const m = await tgApi(c.tgToken, 'sendMessage', {
      chat_id: c.tgChatId, reply_to_message_id: item.msgId, allow_sending_without_reply: true,
      text: '↩️ Send this reply?\nAs: ' + account + '\nTo: ' + item.buyer + test + age + '\n\n“' + item.text + '”',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Send', callback_data: 'fvr:' + item.id + ':y' },
        { text: '✖ Cancel', callback_data: 'fvr:' + item.id + ':n' }]] }
    });
    if (m.ok) {
      pending[item.id].prompt = m.result.message_id;
      await chrome.storage.local.set({ replyPending: pending });
    }
    return;
  }

  if (item.t === 'prompt') {
    tgApi(c.tgToken, 'answerCallbackQuery', { callback_query_id: item.cb });
    // The prompt looks like one of our alerts, so the answer you type routes to the right account and buyer.
    return tgNote(c, ['LYNCH DIGITANCE · ALERTS', '💬 Fiverr · ' + account, 'From: ' + item.buyer, '',
      '✍️ Type your reply to ' + item.buyer + ' below. It will be sent from ' + account + '.', '',
      'https://www.fiverr.com/inbox/' + item.buyer].join('\n'),
      { reply_markup: { force_reply: true, input_field_placeholder: 'Reply to ' + item.buyer } });
  }

  if (item.t === 'confirm') {
    tgApi(c.tgToken, 'answerCallbackQuery', { callback_query_id: item.cb });   // stop the button spinner
    const p = rc.replyPending[item.cmd];
    const edit = text => tgApi(c.tgToken, 'editMessageText', { chat_id: c.tgChatId, message_id: item.msgId, text });
    if (!p) return edit('This reply has expired or was already handled.');
    if (!item.yes) {
      const cur = (await chrome.storage.local.get({ replyPending: {} })).replyPending;
      delete cur[item.cmd];
      await chrome.storage.local.set({ replyPending: cur });
      return edit('✖ Cancelled. Nothing was sent.');
    }
    p.prompt = item.msgId;
    const cur = (await chrome.storage.local.get({ replyPending: {} })).replyPending;
    cur[item.cmd] = p;
    await chrome.storage.local.set({ replyPending: cur });
    await edit('⏳ Sending to ' + p.buyer + '…');
    return runReply(item.cmd, c);
  }
}

async function replyPollOnce() {
  const rc = await replyCfg();
  if (!rc.replyEnabled) return setReplyState('off');
  const { acctToken, fvnAccounts = {} } = await chrome.storage.local.get(['acctToken', 'fvnAccounts']);
  if (!acctToken) return setReplyState('signed-out');
  const c = await cfg();
  if (c.channel !== 'telegram' || !c.tgToken || !c.tgChatId) return setReplyState('no-telegram');

  const mine = Object.entries(fvnAccounts)
    .filter(([u, t]) => isRealUser(u) && Date.now() - t < 15 * 60 * 1000).map(([u]) => u);
  if (!mine.length) return setReplyState('no-fiverr-tab');
  let bad = '';
  for (const account of mine) {
    const ack = acksFor[account] || [];
    const r = await acctFetch('/relay/poll?account=' + encodeURIComponent(account) +
      (ack.length ? '&ack=' + ack.join(',') : ''), 'GET');
    if (!r.ok) { bad = (r.data && r.data.error) || ('http ' + r.status); continue; }
    acksFor[account] = [];
    for (const item of (r.data.items || [])) {
      acksFor[account].push(item.id);
      const st = await chrome.storage.local.get({ replySeen: [] });
      if (st.replySeen.includes(item.id)) continue;                    // already handled
      st.replySeen.push(item.id);
      await chrome.storage.local.set({ replySeen: st.replySeen.slice(-300) });
      try { await handleRelayItem(account, item, c, await replyCfg()); }
      catch (e) {
        await log({ ts: Date.now(), account, from: item.buyer || '', type: 'reply', delivered: false, reason: 'reply error: ' + e });
        await tgNote(c, '⚠️ Something went wrong handling your reply for ' + account + ':\n' + e);
      }
    }
  }
  await setReplyState(bad ? 'error' : 'ok', { accounts: mine, error: bad });
}

/* An alarm can only fire every 30 seconds, so each one checks three times, 10 s apart. */
/* Replies come right after an alert, so: check every 10 s for 3 minutes after any alert or reply
 * activity, and only once a minute the rest of the time. (Saves the server almost all of its reads.) */
const bumpReplyBurst = () => chrome.storage.local.set({ replyBurstUntil: Date.now() + 3 * 60e3 });
async function replyTick() {
  if (replyBusy) return;
  replyBusy = true;
  replyTickN++;
  try {
    const { replyBurstUntil = 0 } = await chrome.storage.local.get('replyBurstUntil');
    const fast = Date.now() < replyBurstUntil;
    if (!fast && replyTickN % 2) return;
    const polls = fast ? 3 : 1;
    for (let i = 0; i < polls; i++) {
      await replyPollOnce();
      if (i < polls - 1) await sleepMs(10000);
    }
  } catch (e) { /* try again next alarm */ } finally { replyBusy = false; }
}
chrome.alarms.create('fvn-reply', { periodInMinutes: 0.5 });

/* "Test the message box" button: asks the open conversation page what it can find. */
async function replyComposerTest() {
  const tabs = await chrome.tabs.query({ url: 'https://*.fiverr.com/inbox/*' });
  if (!tabs.length) return { ok: false, error: 'Open a conversation in Fiverr first (any buyer), then try again.' };
  try { return (await chrome.tabs.sendMessage(tabs[0].id, { kind: 'fvn-composer-test' })) || { ok: false, error: 'No answer from the page.' }; }
  catch { return { ok: false, error: 'The page did not answer. Refresh the Fiverr tab (F5) and try again.' }; }
}

chrome.alarms.create('fvn-heal', { periodInMinutes: 30 });
chrome.alarms.create('fvn-drain', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'fvn-drain') drain();
  if (a.name === 'fvn-heal') injectExistingTabs();
  if (a.name === 'fvn-sync') syncNow();
  if (a.name === 'fvn-reply') replyTick();
  if (a.name === 'fvn-update') { checkForUpdate(); fvnAnnounceAndPing(); }
  if (a.name === 'fvn-announce') fvnAnnounceAndPing();
  if (a.name === 'fvn-watchdog') { runWatchdog(); runHeartbeat(); }
});

// ------------------------------------------------------------ unread badge
/* Counts alerts delivered since you last opened the popup, per account, so a
   phone restart or a missed Telegram window doesn't mean you silently lose
   track of what came in. Opening the popup is what marks them seen. */

async function bumpUnread(account) {
  if (!account) return;
  const { fvnUnseen = {} } = await chrome.storage.local.get('fvnUnseen');
  fvnUnseen[account] = (fvnUnseen[account] || 0) + 1;
  await chrome.storage.local.set({ fvnUnseen });
  await refreshBadge();
}

/* One badge, two things competing for it. The unread count wins when there is
   one — it's time-sensitive — and the update flag shows only when you're clear. */
async function refreshBadge() {
  const { fvnUnseen = {}, fvnUpdate = {}, fvnMaint = null, fvnAttention = false } =
    await chrome.storage.local.get(['fvnUnseen', 'fvnUpdate', 'fvnMaint', 'fvnAttention']);

  const total = Object.values(fvnUnseen).reduce((a, b) => a + b, 0);

  if (fvnMaint && fvnMaint.on) {
    chrome.action.setBadgeText({ text: fvnMaint.kind === 'update' ? 'UPD' : 'FIX' });
    chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
  } else if (fvnAttention) {
    chrome.action.setBadgeText({ text: '★' });
    chrome.action.setBadgeBackgroundColor({ color: '#D97A3D' });
  } else if (total > 0) {
    chrome.action.setBadgeText({ text: total > 99 ? '99+' : String(total) });
    chrome.action.setBadgeBackgroundColor({ color: '#D97A3D' });
  } else if (fvnUpdate.available) {
    chrome.action.setBadgeText({ text: 'NEW' });
    chrome.action.setBadgeBackgroundColor({ color: '#D97A3D' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

async function markAllSeen() {
  const { fvnUnseen = {} } = await chrome.storage.local.get('fvnUnseen');
  await chrome.storage.local.set({ fvnUnseen: {} });
  await refreshBadge();
  return fvnUnseen;                       // snapshot, so the popup can show it
}

chrome.runtime.onStartup.addListener(refreshBadge);
chrome.runtime.onInstalled.addListener(refreshBadge);
// After an update: draw attention to the popup (a star on the icon, and open it if Chrome allows) so the
// "what's new" note and the review window are the first thing people see.
chrome.runtime.onInstalled.addListener(async d => {
  const r = await LynchReview.onInstalled(d);
  if (r && r.openNow) {
    await chrome.storage.local.set({ fvnAttention: true });
    await refreshBadge();
    try { await chrome.action.openPopup(); } catch (e) { /* needs a focused window: the star is the fallback */ }
  }
});

// ---------------------------------------------------------------- log
async function log(entry) {
  const { fvnLog = [] } = await chrome.storage.local.get('fvnLog');
  fvnLog.unshift(entry);
  await chrome.storage.local.set({ fvnLog: fvnLog.slice(0, 100) });
}

// ---------------------------------------------------------------- router
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.kind === 'fvn-alive') {
      /* Guard the heartbeat store. A placeholder name written in here becomes a
         phantom account that the watchdog reports offline forever. */
      if (!isRealUser(msg.account)) return reply({ ok: false, reason: 'no-username-yet' });
      const st = await chrome.storage.local.get(['fvnAccounts', 'fvnTabs', 'fvnWatchdog', 'fvnReturn', 'fvnUnread']);
      const fvnAccounts = st.fvnAccounts || {}, fvnTabs = st.fvnTabs || {}, fvnWatchdog = st.fvnWatchdog || {};
      const fvnReturn = st.fvnReturn || {}, fvnUnread = st.fvnUnread || {};
      const now = Date.now(), prev = fvnAccounts[msg.account] || 0;
      /* Coming back after a long gap with the watchdog never having noticed (browser was closed):
         remember it, and say what is waiting once the page has settled. */
      if (prev && now - prev > (await cfg()).watchdogMins * 60e3 && !fvnWatchdog[msg.account] && !fvnReturn[msg.account]) {
        fvnReturn[msg.account] = { since: prev, at: now };
      }
      fvnAccounts[msg.account] = now;
      fvnUnread[msg.account] = typeof msg.unread === 'number' ? msg.unread : 0;
      if (sender && sender.tab) fvnTabs[msg.account] = sender.tab.id;   // which tab watches which account
      const ret = fvnReturn[msg.account];
      if (ret && now - ret.at >= 45000) {                               // title count has had time to load
        delete fvnReturn[msg.account];
        queue.push({ text: backOnlineText(msg.account, now - ret.since, fvnUnread[msg.account], false),
                     account: msg.account, from: 'Watchdog', type: 'alert', noBadge: true });
        drain();
      }
      await chrome.storage.local.set({ fvnAccounts, fvnTabs, fvnReturn, fvnUnread });
      return reply({ ok: true });
    }

    if (msg.kind === 'fvn-review-prompt') return reply(await LynchReview.prompt());
    if (msg.kind === 'fvn-review-list') return reply(await LynchReview.list());
    if (msg.kind === 'fvn-review-submit') return reply(await LynchReview.submit(msg.rating, msg.text));
    if (msg.kind === 'fvn-review-later') return reply(await LynchReview.later());
    if (msg.kind === 'fvn-review-never') return reply(await LynchReview.never());
    if (msg.kind === 'fvn-note-seen') { const nr = await LynchReview.noteSeen(); await refreshBadge(); return reply(nr); }

    if (msg.kind === 'fvn-reply-status') {
      const rc = await replyCfg();
      const { replyState = null, acctToken } = await chrome.storage.local.get(['replyState', 'acctToken']);
      return reply({ enabled: rc.replyEnabled, signedIn: !!acctToken, state: replyState });
    }

    if (msg.kind === 'fvn-debug') {
      const { fvnDebug = [] } = await chrome.storage.local.get('fvnDebug');
      fvnDebug.unshift(msg.entry);
      await chrome.storage.local.set({ fvnDebug: fvnDebug.slice(0, 120) });
      return reply({ ok: true });
    }

    if (msg.kind === 'fvn-event') {
      const c = await cfg();
      if (!c.enabled || Date.now() < c.quietUntil) return reply({ ok: false, reason: 'disabled' });
      if (c.fvnMaint && c.fvnMaint.on && c.fvnMaint.kind === 'update' && c.fvnMaint.block) return reply({ ok: false, reason: 'update-required' });

      const e = msg.event;
      const fp = e.fingerprint || (e.account + '|' + e.from + e.text).slice(0, 180);
      if (!e.noDedupe && await isDupe(fp)) return reply({ ok: false, reason: 'dupe' });

      if (c.desktopNotif) {
        try {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon128.png'),
            title: `${(c.accountLabels || {})[e.account] || e.account} · ${e.from}`,
            message: (e.text || '').slice(0, 180),
            priority: 2
          });
        } catch {}
      }

      const rcx = await replyCfg();
      const kb = (rcx.replyEnabled && e.type === 'message' && e.from && !c.privacyMode) ? REPLY_BTN : undefined;
      if (kb) bumpReplyBurst();
      queue.push({ text: format(e, c), account: e.account, from: e.from, type: e.type, kb });
      drain();
      return reply({ ok: true, queued: queue.length });
    }

    /* Asks Telegram which chats have messaged this bot, and returns the most
       recent one's id. Removes the whole "which number is my chat id" problem. */
    if (msg.kind === 'fvn-tg-detect') {
      const c = await cfg();
      if (!c.tgToken) return reply({ ok: false, reason: 'enter-and-save-the-bot-token-first' });
      try {
        const r = await fetch(`https://api.telegram.org/bot${c.tgToken}/getUpdates`);
        const j = await r.json().catch(() => ({}));
        if (!j.ok) return reply({ ok: false, reason: j.description || ('http-' + r.status) });

        const chats = [];
        for (const u of (j.result || [])) {
          const m = u.message || u.edited_message || u.channel_post;
          if (m && m.chat && m.chat.id != null) {
            chats.push({
              id: String(m.chat.id),
              name: m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ')
                    || m.chat.username || 'chat'
            });
          }
        }
        if (!chats.length) {
          return reply({ ok: false, reason: 'no messages yet — open your bot in Telegram and send it "hi", then press Detect again' });
        }
        const pick = chats[chats.length - 1];
        await chrome.storage.local.set({ tgChatId: pick.id });
        return reply({ ok: true, chatId: pick.id, name: pick.name });
      } catch (e) {
        return reply({ ok: false, reason: String(e) });
      }
    }

    if (msg.kind === 'fvn-mark-seen') {
      return reply({ ok: true, snapshot: await markAllSeen() });
    }

    /* Chrome extensions cannot write to their own folder, and MV3 forbids
       running remotely fetched code — so a true self-update isn't possible for
       an unpacked install. What we CAN do is remove the fiddly steps: fetch the
       zip straight into Downloads, and offer a reload button so nobody has to
       go hunting through chrome://extensions. */
    if (msg.kind === 'fvn-download-update') {
      const { fvnUpdate = {} } = await chrome.storage.local.get('fvnUpdate');
      const url = fvnUpdate.url;
      if (!url) return reply({ ok: false, reason: 'no-download-url' });
      try {
        const id = await chrome.downloads.download({ url, saveAs: false });
        return reply({ ok: true, id });
      } catch (e) {
        return reply({ ok: false, reason: String(e) });
      }
    }

    if (msg.kind === 'fvn-reload-extension') {
      reply({ ok: true });
      setTimeout(() => chrome.runtime.reload(), 200);
      return;
    }

    /* ------------------------------------------------------------ diagnose
       Reads the extension's actual state and reports what is wrong in plain
       English. Every failure this tool has is a known one, so a checklist that
       inspects real state beats a chat box that has to guess. */
    if (msg.kind === 'fvn-diagnose') {
      const c = await cfg();
      const { fvnAccounts = {}, fvnLog = [], fvnUpdate = {}, fvnWatchdog = {} } =
        await chrome.storage.local.get(['fvnAccounts', 'fvnLog', 'fvnUpdate', 'fvnWatchdog']);

      const now = Date.now();
      const out = [];
      const add = (level, title, detail, action) => out.push({ level, title, detail, action });

      // --- master switches -------------------------------------------------
      if (!c.enabled) {
        add('fail', 'Alerts are switched off',
            'Nothing will be sent until you tick Enabled at the top.', 'enable');
      }
      if (now < c.quietUntil) {
        const mins = Math.ceil((c.quietUntil - now) / 60000);
        add('warn', `Muted for another ${mins} min`,
            'You pressed Mute. Alerts resume automatically.', 'unmute');
      }

      // --- delivery channel ------------------------------------------------
      if (c.channel === 'telegram') {
        if (!c.tgToken) {
          add('fail', 'No Telegram bot token',
              'Message @BotFather, send /newbot, paste the token above, then Save.');
        } else if (!c.tgChatId) {
          add('fail', 'No chat ID',
              'Open your bot in Telegram, send it "hi", then press Detect chat ID.', 'detect');
        }
      } else if (c.channel === 'callmebot') {
        if (!c.waNumber || !c.apiKey) {
          add('fail', 'CallMeBot is not set up',
              'Both your WhatsApp number and the API key are required.');
        }
      } else if (c.channel === 'webhook' && !c.webhookUrl) {
        add('fail', 'No webhook URL', 'Paste the webhook address above and Save.');
      }

      // --- what actually happened on the wire ------------------------------
      const fails = fvnLog.filter(e => !e.delivered);
      const lastFail = fails[0];
      const lastOk = fvnLog.find(e => e.delivered);

      if (lastFail && (!lastOk || lastFail.ts > lastOk.ts)) {
        const r = String(lastFail.reason || '');
        if (/chat not found/i.test(r)) {
          add('fail', 'Telegram says "chat not found"',
              'Your bot has never been messaged, so it is not allowed to message you. ' +
              'Open the bot in Telegram, send it anything, then press Detect chat ID.', 'detect');
        } else if (/unauthorized/i.test(r)) {
          add('fail', 'Telegram rejected the token',
              'The bot token is wrong or was revoked. Get a fresh one from @BotFather.');
        } else if (/not found/i.test(r)) {
          add('fail', 'Bot token looks malformed',
              'Check it copied fully — it should look like 123456789:AAG... with no spaces.');
        } else if (/bad api key/i.test(r)) {
          add('fail', 'CallMeBot key rejected',
              'Send "Recover APIKey" to the CallMeBot contact on WhatsApp.');
        } else {
          add('fail', 'Last delivery failed', r.slice(0, 160) || 'No reason reported.', 'test');
        }
      }

      // --- is anything actually being watched? ------------------------------
      const live = Object.entries(fvnAccounts)
        .filter(([u, t]) => isRealUser(u) && now - t < 5 * 60 * 1000)
        .map(([u]) => u);
      const known = Object.keys(fvnAccounts).filter(isRealUser);

      if (!live.length) {
        add('fail', 'No Fiverr tab is being watched',
            known.length
              ? `Last seen: ${known.join(', ')}. The tab may be closed, logged out, or discarded.`
              : 'Open fiverr.com/inbox and pin the tab, then reopen this popup.',
            'openfiverr');
      } else {
        add('ok', `Watching ${live.length} account${live.length > 1 ? 's' : ''}`,
            live.map(u => (c.accountLabels || {})[u] || u).join(', '));
      }

      // --- phantoms & stale watchers ----------------------------------------
      const phantoms = Object.keys(fvnAccounts).filter(u => !isRealUser(u));
      if (phantoms.length) {
        add('warn', 'Phantom account in storage',
            `Found: ${phantoms.join(', ')}. These are placeholders from an older build ` +
            'and cause "WATCHER OFFLINE · unknown" alerts.', 'purge');
      }

      const offline = Object.keys(fvnWatchdog).filter(isRealUser);
      if (offline.length) {
        add('warn', 'Watcher reported offline',
            offline.map(u => (c.accountLabels || {})[u] || u).join(', ') +
            ' stopped checking in. Reopen the Fiverr tab and confirm you are still logged in.',
            'openfiverr');
      }

      // --- housekeeping -----------------------------------------------------
      if (fvnUpdate.available) {
        add('warn', `Update available — v${fvnUpdate.version}`,
            'You are running an older build. Newer versions fix known problems.');
      }
      if (c.debugMode) {
        add('warn', 'Debug mode is on',
            'It captures page data and grows over time. Turn it off when you are done.', 'nodebug');
      }
      if (!c.watchdog) {
        add('warn', 'Offline warnings are disabled',
            'If a tab dies you will not be told, and silence looks like "no messages".');
      }

      // --- all clear ---------------------------------------------------------
      if (!out.some(o => o.level !== 'ok')) {
        add('ok', 'Everything looks healthy',
            lastOk ? `Last alert delivered ${new Date(lastOk.ts).toLocaleString()}.`
                   : 'No alerts sent yet — press Send test to confirm delivery.');
      }

      return reply({ ok: true, results: out, version: chrome.runtime.getManifest().version });
    }

    /* ---------------------------------------------------------- LYNCH AI
       The assistant is far more useful when it can see what's actually wrong,
       so every question carries a sanitised state summary. Tokens, API keys and
       webhook URLs are NEVER included — only whether they are present. */
    if (msg.kind === 'fvn-ai') {
      const c = await cfg();
      const { fvnAccounts = {}, fvnLog = [], fvnUpdate = {}, fvnWatchdog = {} } =
        await chrome.storage.local.get(['fvnAccounts', 'fvnLog', 'fvnUpdate', 'fvnWatchdog']);

      const now = Date.now();
      const live = Object.entries(fvnAccounts)
        .filter(([u, t]) => isRealUser(u) && now - t < 5 * 60 * 1000).map(([u]) => u);

      const state = [
        `Extension version: ${chrome.runtime.getManifest().version}`,
        `Alerts enabled: ${c.enabled}`,
        `Muted: ${now < c.quietUntil}`,
        `Delivery channel: ${c.channel}`,
        `Telegram token set: ${!!c.tgToken}`,
        `Telegram chat ID set: ${!!c.tgChatId}`,
        `CallMeBot configured: ${!!(c.waNumber && c.apiKey)}`,
        `Accounts being watched right now: ${live.length ? live.join(', ') : 'NONE'}`,
        `Accounts ever seen: ${Object.keys(fvnAccounts).join(', ') || 'none'}`,
        `Placeholder/phantom accounts: ${Object.keys(fvnAccounts).filter(u => !isRealUser(u)).join(', ') || 'none'}`,
        `Watchers currently offline: ${Object.keys(fvnWatchdog).join(', ') || 'none'}`,
        `Update available: ${fvnUpdate.available ? fvnUpdate.version : 'no'}`,
        `Debug mode: ${c.debugMode}`,
        'Recent delivery attempts (newest first):',
        ...fvnLog.slice(0, 8).map(e =>
          `  ${new Date(e.ts).toLocaleTimeString()} ${e.delivered ? 'OK' : 'FAILED'} ` +
          `${e.account || '?'} ${e.reason ? '— ' + e.reason : ''}`)
      ].join('\n');

      try {
        const r = await fetch(AI_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: msg.messages,
            context: state,
            image: msg.image || null
          })
        });

        // A good answer comes back as plain text. Failures come back as JSON
        // carrying a readable message, so the two are told apart by type.
        const ct = r.headers.get('Content-Type') || '';
        if (r.ok && !ct.includes('application/json')) {
          const text = (await r.text()).trim();
          if (text) return reply({ ok: true, reply: text });
        }
        const data = await r.json().catch(() => ({}));
        return reply({
          ok: false,
          reply: data.error ||
            "I can't reach the assistant right now. Press \"Diagnose a problem\" — " +
            'it works offline and covers the common faults.'
        });
      } catch (e) {
        return reply({
          ok: false,
          reply: 'No connection to the assistant. Press "Diagnose a problem" instead — ' +
                 'it runs entirely on your machine.'
        });
      }
    }

    /* Screenshot of whatever the user is looking at, so the assistant can read
       an error rather than have it described second-hand. */
    if (msg.kind === 'fvn-screenshot') {
      try {
        const shot = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 55 });
        return reply({ ok: true, image: shot });
      } catch (e) {
        return reply({ ok: false, reason: String(e) });
      }
    }

    /* Ask every open Fiverr tab what it can currently see in the notification
       panel. Read-only, ignores the age cutoff, sends nothing to Telegram —
       purely "prove the detector works" on whatever is already there. */
    if (msg.kind === 'fvn-test-scan') {
      let tabs = [];
      try { tabs = await chrome.tabs.query({ url: 'https://*.fiverr.com/*' }); } catch {}
      if (!tabs.length) return reply({ ok: false, reason: 'no-fiverr-tab' });

      const results = [];
      for (const t of tabs) {
        try {
          const r = await chrome.tabs.sendMessage(t.id, { kind: 'fvn-test-scan' });
          if (r && r.ok) results.push(r);
        } catch {
          results.push({ ok: false, url: t.url, error: 'tab not responding — reload it (F5)' });
        }
      }
      return reply({ ok: true, results });
    }

    /* -------------------------------------------------- account + sync */
    if (msg.kind === 'fvn-acct') {
      const op = msg.op;
      try {
        if (op === 'login' || op === 'register') {
          const local = op === 'register' ? await syncSnapshot() : undefined;
          const r = await acctFetch('/account/' + op, 'POST',
            { email: msg.email, password: msg.password, settings: local });
          if (!r.ok) return reply({ ok: false, error: r.data.error });
          await chrome.storage.local.set({ acctToken: r.data.token, acctEmail: r.data.email });
          if (op === 'login') await applyRemote(r.data.settings);
          await chrome.storage.local.set({ acctBase: await syncSnapshot() });   // what the account held at sign-in
          return reply({ ok: true, email: r.data.email });
        }
        if (op === 'logout') {
          await acctFetch('/account/logout', 'POST', {}).catch(() => {});
          await chrome.storage.local.remove(['acctToken', 'acctEmail', 'acctBase']);
          return reply({ ok: true });
        }
        if (op === 'sync' || op === 'push' || op === 'pull') return reply(await syncNow());
      } catch (e) {
        return reply({ ok: false, error: 'Could not reach the server.' });
      }
      return reply({ ok: false, error: 'unknown op' });
    }

    if (msg.kind === 'fvn-reply-setup') return reply(await replySetup());
    if (msg.kind === 'fvn-reply-composer-test') return reply(await replyComposerTest());

    if (msg.kind === 'fvn-purge') {
      const removed = await purgePhantomAccounts();
      await chrome.storage.local.set({ fvnWatchdog: {} });
      return reply({ ok: true, removed });
    }

    if (msg.kind === 'fvn-check-update') {
      return reply(await checkForUpdate(true));
    }

    if (msg.kind === 'fvn-test') {
      const c = await cfg();

      /* Name the accounts being watched. With several profiles open you'd
         otherwise have no idea which install just sent the test. */
      const { fvnAccounts = {} } = await chrome.storage.local.get('fvnAccounts');
      const live = Object.entries(fvnAccounts)
        .filter(([, t]) => Date.now() - t < 5 * 60 * 1000)
        .map(([u]) => (c.accountLabels || {})[u] ? `${c.accountLabels[u]} (${u})` : u);

      const who = live.length
        ? live.join('\n')
        : '(no Fiverr tab open in this browser profile)';

      const r = await send([
        'LYNCH DIGITANCE · ALERTS',
        '✅ Test message — delivery works.',
        '',
        'Watching:',
        who
      ].join('\n'), c);

      await log({ ts: Date.now(), account: live[0] || 'test', from: 'self', type: 'test',
                  delivered: r.ok, reason: r.reason || '' });
      return reply(r);
    }

    reply({ ok: false, reason: 'unknown' });
  })();
  return true;
});
