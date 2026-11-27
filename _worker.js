/**
 * LYNCH AI ASSISTANT — Cloudflare Worker backend.
 *
 * Serves the static site and adds one endpoint, POST /ai, which answers support
 * questions about the extension. It runs on Cloudflare Workers AI, so there is
 * no API key to leak and no per-token bill — the free tier covers this usage.
 *
 * This is the WEBSITE assistant. The extension has its own worker in
 * ai-worker/ (deployed as "alerts-ai") holding only extension knowledge, so the
 * two can never bleed into each other and that one can be locked to extension
 * origins with its own rate limit.
 *
 * Routes:
 *   POST /ai        { messages, state?, image? }  -> { reply }
 *   POST /feedback  uninstall survey              -> your Telegram
 *   *               everything else               -> the static site
 */

/* Cloudflare retires Workers AI models on a schedule — llama-3.1-8b-instruct
 * was deprecated on 2026-05-30 and took the assistant offline with it. So these
 * are LISTS, tried in order until one answers. When the top one is retired the
 * next takes over on its own, with no redeploy and no outage.
 *
 * The first model that works is remembered for the life of the isolate, so the
 * fallback cost is paid once rather than on every request. */
const TEXT_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.2-3b-instruct',
  '@cf/openai/gpt-oss-20b',
  '@cf/meta/llama-3.2-1b-instruct'
];

const VISION_MODELS = [
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@cf/llava-hf/llava-1.5-7b-hf'
];

let workingText = null;
let workingVision = null;

/* Runs the first model in `list` that isn't dead. Returns [result, modelUsed]. */
async function runFirstAvailable(env, list, payload, remembered) {
  const order = remembered ? [remembered, ...list.filter(m => m !== remembered)] : list;
  let lastErr = 'no models tried';

  for (const model of order) {
    try {
      const out = await env.AI.run(model, payload);
      return [out, model];
    } catch (e) {
      lastErr = String(e);
      // Deprecated / unknown / unavailable — move on. Anything else is likely a
      // real fault (bad payload, quota) and retrying other models won't help.
      if (!/deprecat|not found|no such model|unavailable|5028|invalid model/i.test(lastErr)) {
        throw e;
      }
    }
  }
  throw new Error(lastErr);
}

const MAX_MESSAGE   = 2000;   // characters per user turn
const MAX_HISTORY   = 12;     // turns kept for context
const MAX_IMAGE_KB  = 1400;   // screenshots are resized client-side before this

/* ============================================================================
 * TWO SCOPES, TWO PROMPTS
 *
 *   scope: "extension" — sent by the extension itself. Support only. Someone
 *                        hitting an error wants the fix, not a sales pitch.
 *   scope: "site"      — sent by the website. Knows the studio, the services,
 *                        and how to talk to a prospective client.
 *
 * Both live here on the server, so corrections take effect on redeploy without
 * shipping a new extension build to anyone.
 * ========================================================================= */

/* ---------------------------------------------------------------------------
 * ▼▼▼ EDIT THIS BLOCK — it is the only part that needs your own facts ▼▼▼
 * Anything left as a placeholder, the assistant is told to admit it doesn't
 * know rather than invent. Fill in what's true and delete what isn't.
 * ------------------------------------------------------------------------- */
const STUDIO = `
ABOUT THE STUDIO
- Name: Lynch Digitance Studios. Tagline: "Create • Capture • Elevate".
- It is a one-person studio: Lynch Digitance Studios is the developer and sole
  author of Lynch Digitance Alerts. If anyone asks who built the extension, who
  is behind it, or who to credit — the answer is Lynch Digitance Studios.
- Works with clients internationally, largely through Fiverr and direct contact.

WHAT THE STUDIO BUILDS
- Chrome extensions and browser tools (Lynch Digitance Alerts is one of these).
- Websites and landing pages — static, fast, deployed on Cloudflare.
- Workflow automation: connecting apps, messaging platforms and APIs so manual
  work happens by itself.
- Custom internal tools and dashboards.
- Game development work, including Roblox and FiveM scripting.

CONTACT
- Discord community: https://discord.gg/aGBWVQfZsj — invite people to join for help and updates.
- Main site: https://www.lynchdigitancestudios.workers.dev — point people here to see all products and hire the studio.
- Email: lynchdigitancestudios@gmail.com — this is the address to give anyone who
  wants custom work, has a business enquiry, or needs a human. Give it freely and
  spell it out exactly.
- Also reachable through the studio's Fiverr profile.

OTHER PROJECTS
- The studio builds other tools beyond this extension, but you have not been given
  their details. If someone asks what else exists, say you can only speak in detail
  about Lynch Digitance Alerts, and invite them to email
  lynchdigitancestudios@gmail.com — do not name or describe projects you were not
  told about.
`;
/* ▲▲▲ END EDITABLE BLOCK ▲▲▲ */

/* Product knowledge — shared by both scopes. */
const PRODUCT = `You are LYNCH AI ASSISTANT, the support assistant for "Lynch Digitance Alerts",
a free Chrome extension by Lynch Digitance Studios that sends Fiverr messages, orders,
briefs and notifications to Telegram within seconds.

HOW IT WORKS
- By default it passively reads what the user's already-open Fiverr tab has loaded. It never
  sends any request to Fiverr, never logs in, never clicks, never automates the account.
- The ONE exception is the optional "Reply from Telegram" feature (off until switched on, then
  on). It types the user's own reply into their logged-in Fiverr tab and
  presses Send. That is automation, Fiverr's rules may restrict it, and nobody can promise how
  Fiverr treats it. Say this plainly when asked about bans or safety. Every reply is confirmed in
  Telegram before it is sent, only text is sent and it is capped per hour.
- Once a day the extension sends an anonymous ping (random install ID, version, alert channel) so installs can be counted. The studio can also publish short updates that each install forwards once to the user's own Telegram bot.
- Alerts go straight from the browser to the user's OWN Telegram bot; buyer messages never pass
  through our server. An optional extension account stores the user's email, a hashed password
  and their synced settings. If Reply from Telegram is on, the user's replies pass through our
  server and wait up to 3 days until the extension collects them, then are deleted.
- It only runs while Chrome is open with a Fiverr tab. Closed laptop means no alerts.
- Multiple Fiverr accounts: one Chrome profile per account, each labelled.

KNOWN PROBLEMS AND THEIR EXACT FIXES
1. "Bad Request: chat not found" — the user never messaged their own bot. Telegram forbids
   bots from starting a conversation. Fix: open the bot in Telegram, send it "hi", then press
   "Detect chat ID" in the extension, then Save, then Send test.
2. "Not Found" — the bot token is wrong or malformed. It looks like 123456789:AAG... with no
   spaces. Get a fresh one from @BotFather.
3. "Unauthorized" — the token was revoked. Generate a new one with @BotFather.
4. "WATCHER OFFLINE · unknown" — a placeholder account from an older build. Fix: press
   Diagnose, then "Clean it up". Updating to the latest version prevents it recurring.
5. "Watching: no Fiverr tab detected" — the content script is not running in that tab.
   Fix: open fiverr.com/inbox and reload the tab (F5).
6. Alerts stopped entirely — check it is not muted, and press
   Diagnose.
7. Not getting briefs or orders — those appear only in Fiverr's notification panel, not the
   inbox. Latest versions read that panel. Tell them to update.
8. CallMeBot/WhatsApp not working — CallMeBot is an unreliable free third party whose bot
   number gets banned periodically. Recommend Telegram instead.

UPDATING
Chrome cannot auto-update an extension installed with "Load unpacked", and it cannot rewrite
its own files. To update: press Download in the extension, unzip OVER the existing extension
folder replacing the files, then press "Reload extension". Settings survive because they live
in browser storage. Never uninstall — that erases settings. Never move the folder.

HOW TO ANSWER
- Be direct and short. Lead with the fix, not with sympathy.
- Give concrete steps the user can follow, naming the exact buttons.
- If a "DIAGNOSTIC STATE" block is provided, trust it over the user's description and refer
  to what it actually shows.
- If you genuinely cannot tell what is wrong, ask them to press "Diagnose a problem" and paste
  the result, or to attach a screenshot. Ask for ONE thing at a time.
- Never invent features. If you don't know, say so and point them to the site.
- Never ask for their bot token, API key, or password. If they paste one, tell them to revoke
  it with @BotFather immediately.`;

/* --- scope: site ------------------------------------------------------------
   Talking to someone who hasn't installed anything yet, and may be a client. */
const SYSTEM_SITE = PRODUCT + `
` + STUDIO + `
SCOPE
You are on the Lynch Digitance Studios website. You answer BOTH:
  (a) questions about the extension — setup, safety, troubleshooting, updating; and
  (b) questions about the studio — who built it, what else it makes, how to get in touch,
      whether it can build something for them.

VISITORS HAVE NOT INSTALLED ANYTHING YET
Most people here are deciding whether to trust and install it. The two questions that come
up most are "will this get my Fiverr account banned" and "does it work when my PC is off".
Answer both honestly and specifically — by default the extension never contacts Fiverr at all
(only the optional Reply from Telegram feature writes in the Fiverr tab, and you must say so),
and no, it needs the browser open. Honesty converts better than hedging here.

ENQUIRIES
If someone wants custom work, is interested in hiring, or asks about another kind of tool:
be encouraging, ask what they're trying to achieve, and direct them to contact the studio.
Never quote a price or promise a delivery date — you don't set those. Say the studio will
confirm scope and pricing directly.

HONESTY RULES
- If a fact about the studio is marked PLACEHOLDER or is simply not in your instructions,
  say you don't have that detail to hand and offer to pass the enquiry on. Never guess a
  price, a client name, a statistic, or a project you were not told about.
- Never claim the extension does something it doesn't.`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });

const handlers = {
  async fetch(request, env) {
    try { return await handlers.route(request, env); }
    catch (e) { return failSoft(request, e); }
  },

  async route(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ai') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      return handleAI(request, env);
    }

    if (url.pathname === '/relay/enable' || url.pathname === '/relay/poll') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_ACCT });
      if (!env.ACCOUNTS) return ajson({ error: 'Accounts are not set up yet.' }, 503);
      if (url.pathname === '/relay/enable' && request.method === 'POST') return relayEnable(request, env, url);
      if (url.pathname === '/relay/poll' && request.method === 'GET') return relayPoll(request, env, url);
      return ajson({ error: 'Not found' }, 404);
    }

    if (url.pathname.startsWith('/tg/') && request.method === 'POST' && env.ACCOUNTS) {
      return handleTelegram(request, env, url.pathname.slice(4));
    }

    if (url.pathname === '/ping' || url.pathname === '/announce') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_ACCT });
      if (!env.ACCOUNTS) return ajson({ error: 'Not set up' }, 503);
      if (url.pathname === '/ping' && request.method === 'POST') return handlePing(request, env);
      if (url.pathname === '/announce' && request.method === 'GET') return handleAnnounce(env, request);
      return ajson({ error: 'Not found' }, 404);
    }

    if (url.pathname === '/admin/login' || url.pathname.startsWith('/admin/') && url.pathname !== '/admin/') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_ACCT });
      if (!env.ACCOUNTS) return ajson({ error: 'Accounts are not set up yet.' }, 503);
      if (url.pathname === '/admin/login' && request.method === 'POST') return adminLogin(request, env);
      if (url.pathname === '/admin/users' && request.method === 'GET') return adminUsers(request, env);
      if (url.pathname === '/admin/delete' && request.method === 'POST') return adminDelete(request, env);
      if (url.pathname === '/admin/announce' && request.method === 'POST') return adminAnnounce(request, env);
      if (url.pathname === '/admin/email' && request.method === 'POST') return adminEmail(request, env);
      if (url.pathname === '/admin/maintenance' && request.method === 'POST') return adminMaintenance(request, env);
      if (url.pathname === '/admin/reviews' && request.method === 'GET') return adminReviews(request, env);
      if (url.pathname === '/admin/reviews/hide' && request.method === 'POST') return adminReviewHide(request, env);
      if (url.pathname === '/admin/reviews/reply' && request.method === 'POST') return adminReviewReply(request, env);
      return ajson({ error: 'Not found' }, 404);
    }

    if (url.pathname === '/reviews' || url.pathname === '/reviews/mine') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_ACCT });
      if (!env.DB) return ajson({ error: 'Reviews are not set up yet.' }, 503);
      return handleReviews(request, env, url);
    }

    if (url.pathname.startsWith('/account/')) {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_ACCT });
      return handleAccount(request, env, url.pathname);
    }

    if (url.pathname === '/feedback') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
      if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
      return handleFeedback(request, env);
    }

    // Everything else is the static site.
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  }
};
export default handlers;

/* Uninstall feedback from goodbye.html.
 *
 * Delivered to YOUR Telegram, so churn reasons land where you'll actually read
 * them. Needs two secrets: OWNER_TG_TOKEN and OWNER_TG_CHAT. Without them the
 * endpoint quietly accepts and discards — the page must never show a stranger
 * an error because a secret is missing. */
const REASONS = {
  'not-working': "Wasn't working — never got alerts",
  'setup':       'Setup too complicated',
  'too-many':    'Too many or wrong alerts',
  'updating':    'Updating was too much hassle',
  'no-need':     'No longer needs Fiverr alerts',
  'other':       'Something else'
};

async function handleFeedback(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: true }); }

  if (!env.OWNER_TG_TOKEN || !env.OWNER_TG_CHAT) return json({ ok: true, stored: false });

  const text = [
    'LYNCH DIGITANCE · UNINSTALL',
    '',
    `Reason: ${REASONS[body.reason] || body.reason || 'not given'}`,
    `Version: ${String(body.version || 'unknown').slice(0, 20)}`,
    body.note ? `\nThey said:\n${String(body.note).slice(0, 900)}` : ''
  ].join('\n');

  try {
    await fetch(`https://api.telegram.org/bot${env.OWNER_TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.OWNER_TG_CHAT, text, disable_web_page_preview: true })
    });
  } catch {}

  return json({ ok: true, stored: true });
}

/* ---------------------------------------------------------------- accounts
 * Settings sync for the extension. KV holds:
 *   user:<email>   -> { salt, hash, settings, updated }
 *   sess:<token>   -> email   (90-day TTL)
 * Passwords are PBKDF2-SHA256 (100k rounds) with a per-user salt; never stored plain.
 */
const CORS_ACCT = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Ext-Version'
};
/* If a lookup fails (for example Cloudflare's free daily KV allowance is used up), say so plainly. */
function failSoft(request, e) {
  const p = new URL(request.url).pathname;
  console.error('worker error', String(e).slice(0, 200));
  if (p.startsWith('/tg/')) return new Response('busy', { status: 503 });          // Telegram retries by itself
  if (/^\/(account|relay|admin|ping|announce)/.test(p)) {
    return ajson({ error: 'The service is very busy right now. Please try again in a little while.', busy: true }, 503);
  }
  return new Response('Service temporarily unavailable', { status: 503 });
}

const ajson = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...CORS_ACCT } });
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function hashPw(pw, saltB64) {
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}
function sameStr(a, b) {                       // constant-time compare
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function newSession(env, email) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, '');
  await env.ACCOUNTS.put('sess:' + token, email, { expirationTtl: 90 * 86400 });
  return token;
}

async function handleAccount(request, env, path) {
  if (!env.ACCOUNTS) return ajson({ error: 'Accounts are not set up yet.' }, 503);
  const ver = (request.headers.get('X-Ext-Version') || '').slice(0, 20);
  let body = {};
  if (request.method === 'POST' || request.method === 'PUT') {
    try { body = await request.json(); } catch { return ajson({ error: 'Bad request' }, 400); }
  }

  if (path === '/account/register' || path === '/account/login') {
    const email = String(body.email || '').trim().toLowerCase();
    const pw = String(body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return ajson({ error: 'Enter a valid email.' }, 400);
    if (pw.length < 8) return ajson({ error: 'Password must be at least 8 characters.' }, 400);
    const rec = await env.ACCOUNTS.get('user:' + email, 'json');

    if (path === '/account/register') {
      if (rec) return ajson({ error: 'That email already has an account — sign in instead.' }, 409);
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
      const displayName = cleanDisplayName(body.name);
      const fres = { salt, hash: await hashPw(pw, salt), settings, updated: Date.now(), created: Date.now(), lastSeen: Date.now() };
      if (displayName) fres.displayName = displayName;
      await putUser(env, email, fres, ver);
      return ajson({ token: await newSession(env, email), email, settings, displayName });
    }
    if (!rec || !sameStr(await hashPw(pw, rec.salt), rec.hash)) {
      return ajson({ error: 'Wrong email or password.' }, 401);
    }
    await touchUser(env, email, rec, ver);
    return ajson({ token: await newSession(env, email), email, settings: rec.settings || {}, updated: rec.updated, displayName: rec.displayName || '' });
  }

  // Everything else needs a session.
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
  const email = token && await sessEmail(token, env);
  if (!email) return ajson({ error: 'Signed out — please sign in again.' }, 401);
  const rec = await env.ACCOUNTS.get('user:' + email, 'json');
  if (!rec) return ajson({ error: 'Account not found.' }, 404);

  if (path === '/account/settings' && request.method === 'GET') {
    await touchUser(env, email, rec, ver);
    return ajson({ email, settings: rec.settings || {}, updated: rec.updated || 0, displayName: rec.displayName || '' });
  }
  if (path === '/account/settings' && request.method === 'PUT') {
    const settings = body.settings;
    if (!settings || typeof settings !== 'object' || JSON.stringify(settings).length > 20000) {
      return ajson({ error: 'Bad settings' }, 400);
    }
    rec.settings = settings; rec.updated = Date.now(); rec.lastSeen = Date.now();
    await putUser(env, email, rec, ver);
    return ajson({ ok: true, updated: rec.updated });
  }
  if (path === '/account/profile') {
    if (request.method === 'GET') return ajson({ email, displayName: rec.displayName || '' });
    const name = cleanDisplayName(body.name);
    if (!name) return ajson({ error: 'Use 2–24 letters, numbers, spaces, . _ - or an apostrophe.' }, 400);
    rec.displayName = name;
    rec.updated = Date.now();
    rec.lastSeen = Date.now();
    await putUser(env, email, rec, ver);
    // every review this account already wrote takes the chosen name too
    try {
      if (env.DB) {
        await env.DB.prepare('UPDATE reviews SET name = ? WHERE email = ?').bind(name, email).run();
        RV_CACHE.clear();
      }
    } catch { /* editing the profile must not fail because of a review row */ }
    return ajson({ ok: true, name });
  }
  if (path === '/account/logout' && request.method === 'POST') {
    SESS_CACHE.delete(token);
    await env.ACCOUNTS.delete('sess:' + token);
    return ajson({ ok: true });
  }
  return ajson({ error: 'Not found' }, 404);
}

/* ------------------------------------------------------- reply relay + admin
 * Lets ONE shared Telegram bot serve several Fiverr accounts.
 *
 * Telegram sends every reply here (a webhook). The alert you replied to names the
 * Fiverr account and the buyer, so we always know where a reply belongs; it then
 * waits in that account's mailbox until the right browser profile collects it.
 *
 * This Worker never holds the bot token. The extension does all the talking to
 * Telegram; the Worker only routes. Reply text is kept for delivery (max 3 days)
 * and is deleted when the extension confirms it received it.
 *
 * KV keys:
 *   route:<routeKey>        -> { email, chatId, secret }
 *   routeBy:<email>         -> routeKey
 *   (waiting replies and button presses live in D1 tables mailbox + cmds, not KV)
 *   cmd:<id>                -> { email, account }   (7-day TTL, routes button presses)
 *   adm:<token>             -> '1'                  (12-hour admin session)
 */
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,40}$/;
const rid = len => {
  const a = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(a, x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
};
const bearer = request => (request.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');

const SESS_CACHE = new Map();      // token -> { email, exp }
async function sessEmail(token, env) {
  if (!token) return null;
  const hit = SESS_CACHE.get(token);
  if (hit && hit.exp > Date.now()) return hit.email;
  const email = await env.ACCOUNTS.get('sess:' + token);
  if (email) {
    if (SESS_CACHE.size > 400) SESS_CACHE.clear();
    SESS_CACHE.set(token, { email, exp: Date.now() + 10 * 60e3 });
  }
  return email;
}
async function sessionEmail(request, env) {
  return sessEmail(bearer(request), env);
}

/* Reads "which account, which buyer" out of one of OUR alerts:
 *   💬 Fiverr · MY ACCOUNT (the_username)      or    💬 Fiverr · the_username
 *   From: buyer_name
 *   https://www.fiverr.com/inbox/buyer_name
 * Anything without a buyer (heartbeats, bell pings, offline warnings) returns null. */
function parseAlert(text) {
  const t = String(text || '');
  const hdr = /^\S+\s+Fiverr[^\n·]*·\s*(.+)$/m.exec(t);
  const who = hdr ? hdr[1].trim() : '';
  const paren = /\(([A-Za-z0-9_.-]{3,40})\)\s*$/.exec(who);
  const account = paren ? paren[1] : (USERNAME_RE.test(who) ? who : null);
  const url = /fiverr\.com\/inbox\/([A-Za-z0-9_.-]{3,40})/i.exec(t);
  const from = /^From:\s*(\S+)\s*$/m.exec(t);
  const buyer = url ? url[1] : (from && USERNAME_RE.test(from[1]) ? from[1] : null);
  if (!account || !buyer || /^fiverr$/i.test(buyer)) return null;
  return { account, buyer };
}

/* ---- user records: keep a little metadata on the KV key so the admin page can list
 *      everyone in ONE call (the free plan allows only 50 lookups per request). ---- */
async function putUser(env, email, rec, ver) {
  const s = rec.settings || {};
  if (ver) rec.ver = ver;
  const meta = { c: rec.created || null, s: rec.lastSeen || null, v: rec.ver || null, ch: s.channel || null };
  await env.ACCOUNTS.put('user:' + email, JSON.stringify(rec), { metadata: meta });
}
// "Last active" is refreshed at most every 6 hours, to stay well inside KV's free write limit.
async function touchUser(env, email, rec, ver) {
  const now = Date.now();
  if (!rec.lastSeen || now - rec.lastSeen > 6 * 3600e3 || (ver && rec.ver !== ver)) {
    rec.lastSeen = now;
    await putUser(env, email, rec, ver);
  }
}

const MB_EMPTY = new Map();       // mailbox key -> time until which it is known to be empty
async function queueCmd(env, email, account, item) {
  const key = 'mb:' + email + ':' + account;
  MB_EMPTY.delete(key);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO mailbox (id, email, account, item, at) VALUES (?, ?, ?, ?, ?)').bind(String(item.id), email, account, JSON.stringify(item), now),
    env.DB.prepare('DELETE FROM mailbox WHERE email = ? AND account = ? AND id NOT IN (SELECT id FROM mailbox WHERE email = ? AND account = ? ORDER BY at DESC LIMIT 50)').bind(email, account, email, account),
    env.DB.prepare('DELETE FROM mailbox WHERE at < ?').bind(now - 3 * 86400e3)
  ]);
}

/* POST /relay/enable  { chatId }  -> { routeKey, secret, url, fresh }
 * Safe to call from every browser profile: the same account + chat always gets the same route. */
async function relayEnable(request, env, url) {
  const email = await sessionEmail(request, env);
  if (!email) return ajson({ error: 'Signed out — please sign in again.' }, 401);
  let body = {};
  try { body = await request.json(); } catch { return ajson({ error: 'Bad request' }, 400); }
  const chatId = String(body.chatId || '');
  if (!/^-?\d{3,20}$/.test(chatId)) return ajson({ error: 'Bad chat id' }, 400);

  let routeKey = await env.ACCOUNTS.get('routeBy:' + email);
  let route = routeKey ? await env.ACCOUNTS.get('route:' + routeKey, 'json') : null;
  let fresh = false;
  if (!route || String(route.chatId) !== chatId) {
    routeKey = routeKey || rid(24);
    route = { email, chatId, secret: rid(40) };
    await env.ACCOUNTS.put('route:' + routeKey, JSON.stringify(route));
    await env.ACCOUNTS.put('routeBy:' + email, routeKey);
    fresh = true;
  }
  return ajson({ routeKey, secret: route.secret, url: url.origin + '/tg/' + routeKey, fresh });
}

/* GET /relay/poll?account=X&ack=id1,id2  -> { items }
 * Items stay in the mailbox until the extension acknowledges them on its NEXT poll, so a
 * dropped connection can never lose a reply (the extension ignores repeats). */
async function relayPoll(request, env, url) {
  const email = await sessionEmail(request, env);
  if (!email) return ajson({ error: 'Signed out — please sign in again.' }, 401);
  const account = url.searchParams.get('account') || '';
  if (!USERNAME_RE.test(account)) return ajson({ error: 'Bad account' }, 400);
  const ack = new Set((url.searchParams.get('ack') || '').split(',').filter(Boolean));
  const key = 'mb:' + email + ':' + account;
  if (!ack.size) { const until = MB_EMPTY.get(key); if (until && until > Date.now()) return ajson({ items: [] }); }
  try {
    if (ack.size) {
      const ids = [...ack].filter(x => /^[a-z0-9]{4,40}$/.test(x)).slice(0, 50);
      if (ids.length) await env.DB.prepare('DELETE FROM mailbox WHERE email = ? AND account = ? AND id IN (' + ids.map(() => '?').join(',') + ')').bind(email, account, ...ids).run();
    }
    const rs = await env.DB.prepare('SELECT item FROM mailbox WHERE email = ? AND account = ? ORDER BY at ASC LIMIT 10').bind(email, account).all();
    const rows = (rs && rs.results) || [];
    if (!rows.length) {
      if (MB_EMPTY.size > 400) MB_EMPTY.clear();
      MB_EMPTY.set(key, Date.now() + 5000);
      return ajson({ items: [] });
    }
    const items = [];
    for (const r of rows) { try { items.push(JSON.parse(r.item)); } catch { /* skip a damaged row */ } }
    return ajson({ items });
  } catch (e) {
    return ajson({ items: [] });          // database hiccup: the extension simply asks again
  }
}

/* POST /tg/<routeKey>  — Telegram's webhook. Always answers 200 so Telegram doesn't retry. */
async function handleTelegram(request, env, routeKey) {
  const ok = () => new Response('ok');
  const route = await env.ACCOUNTS.get('route:' + routeKey, 'json');
  if (!route) return ok();
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== route.secret) {
    return new Response('forbidden', { status: 403 });
  }
  let u;
  try { u = await request.json(); } catch { return ok(); }
  const now = Date.now();

  // A swipe-reply to one of our alerts.
  if (u.message && u.message.reply_to_message && typeof u.message.text === 'string') {
    const m = u.message;
    if (String(m.chat && m.chat.id) !== String(route.chatId)) return ok();     // only YOUR chat
    const target = parseAlert(m.reply_to_message.text);
    if (!target) return ok();
    const text = m.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 1500);
    if (!text) return ok();
    const id = rid(8);
    await queueCmd(env, route.email, target.account, {
      id, t: 'reply', buyer: target.buyer, text, at: now, msgId: m.message_id
    });
    await env.DB.prepare('INSERT OR REPLACE INTO cmds (id, email, account, at) VALUES (?, ?, ?, ?)').bind(id, route.email, target.account, now).run();
    return ok();
  }

  // A press of the ✅ Send / ✖ Cancel button.
  if (u.callback_query) {
    const q = u.callback_query;
    if (!q.message || String(q.message.chat && q.message.chat.id) !== String(route.chatId)) return ok();
    if (q.data === 'rp') {                       // the ↩️ Reply button under an alert
      const target = parseAlert(q.message.text);
      if (!target) return ok();
      await queueCmd(env, route.email, target.account, {
        id: rid(8), t: 'prompt', buyer: target.buyer, cb: q.id, msgId: q.message.message_id, at: now
      });
      return ok();
    }
    const me = /^fve:([a-z0-9]{8})$/.exec(q.data || '');
    if (me) {                                    // ✏️ Edit: drop the flagged draft, ask for a new one
      const meta = await env.DB.prepare('SELECT email, account FROM cmds WHERE id = ?').bind(me[1]).first();
      if (!meta || meta.email !== route.email) return ok();
      await queueCmd(env, route.email, meta.account, {
        id: rid(8), t: 'edit', cmd: me[1], cb: q.id, msgId: q.message.message_id, at: now
      });
      return ok();
    }
    const mm = /^fvr:([a-z0-9]{8}):([yn])$/.exec(q.data || '');
    if (!mm) return ok();
    const meta = await env.DB.prepare('SELECT email, account FROM cmds WHERE id = ?').bind(mm[1]).first();
    if (!meta || meta.email !== route.email) return ok();
    await queueCmd(env, route.email, meta.account, {
      id: rid(8), t: 'confirm', cmd: mm[1], yes: mm[2] === 'y',
      cb: q.id, msgId: q.message.message_id, at: now
    });
  }
  return ok();
}

/* ---------------------------------------------------------------- admin */
async function adminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) return ajson({ error: 'Admin is not set up.' }, 503);
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'x' });
    if (!success) return ajson({ error: 'Too many attempts. Wait a minute.' }, 429);
  }
  let body = {};
  try { body = await request.json(); } catch { return ajson({ error: 'Bad request' }, 400); }
  if (!sameStr(String(body.password || ''), String(env.ADMIN_PASSWORD))) {
    return ajson({ error: 'Wrong password.' }, 401);
  }
  const token = rid(40);
  await env.ACCOUNTS.put('adm:' + token, '1', { expirationTtl: 12 * 3600 });
  return ajson({ token });
}

async function adminUsers(request, env) {
  const t = bearer(request);
  if (!t || !(await env.ACCOUNTS.get('adm:' + t))) return ajson({ error: 'Signed out.' }, 401);

  const keys = [];
  let cursor;
  do {
    const r = await env.ACCOUNTS.list({ prefix: 'user:', cursor, limit: 1000 });
    keys.push(...r.keys);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor && keys.length < 5000);

  const rl = await env.ACCOUNTS.list({ prefix: 'routeBy:', limit: 1000 });
  const replyOn = new Set(rl.keys.map(k => k.name.slice(8)));

  // Accounts created before metadata existed are filled in a few at a time.
  let budget = 30, pending = 0;
  const users = [];
  for (const k of keys) {
    const email = k.name.slice(5);
    let m = k.metadata;
    if (!m) {
      if (budget > 0) {
        budget--;
        const rec = await env.ACCOUNTS.get(k.name, 'json');
        if (rec) {
          await putUser(env, email, rec, rec.ver);
          m = { c: rec.created || null, s: rec.lastSeen || null, v: rec.ver || null, ch: (rec.settings || {}).channel || null };
        }
      } else pending++;
    }
    m = m || {};
    users.push({ email, joined: m.c || null, last: m.s || null, ver: m.v || null, channel: m.ch || null, reply: replyOn.has(email) });
  }
  const installs = [];
  let ic;
  do {
    const r = await env.ACCOUNTS.list({ prefix: 'inst:', cursor: ic, limit: 1000 });
    for (const k of r.keys) {
      const m = k.metadata || {};
      installs.push({ id: k.name.slice(5), joined: m.c || null, last: m.s || null, ver: m.v || null, channel: m.ch || null, acct: !!m.a });
    }
    ic = r.list_complete ? null : r.cursor;
  } while (ic && installs.length < 5000);
  const announce = await env.ACCOUNTS.get('announce:latest', 'json');
  const maint = await env.ACCOUNTS.get('maint:state', 'json');
  return ajson({ users, total: users.length, pending, installs, announce, maint: maint || { on: false }, mail: !!(env.MAIL_HOOK_URL && env.MAIL_HOOK_SECRET) });
}

async function adminAuth(request, env) {
  const t = bearer(request);
  return !!(t && (await env.ACCOUNTS.get('adm:' + t)));
}

/* POST /admin/delete { email } or { inst }  — removes an account (and its reply route/mailboxes) or an install record. */
async function adminDelete(request, env) {
  if (!(await adminAuth(request, env))) return ajson({ error: 'Signed out.' }, 401);
  let b = {}; try { b = await request.json(); } catch { return ajson({ error: 'Bad request' }, 400); }
  if (b.inst) {
    if (!/^[a-z0-9]{16,64}$/.test(String(b.inst))) return ajson({ error: 'Bad id' }, 400);
    await env.ACCOUNTS.delete('inst:' + b.inst);
    return ajson({ ok: true });
  }
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return ajson({ error: 'Bad email' }, 400);
  const routeKey = await env.ACCOUNTS.get('routeBy:' + email);
  if (routeKey) await env.ACCOUNTS.delete('route:' + routeKey);
  await env.ACCOUNTS.delete('routeBy:' + email);
  if (env.DB) { try { await env.DB.batch([env.DB.prepare('DELETE FROM mailbox WHERE email = ?').bind(email), env.DB.prepare('DELETE FROM cmds WHERE email = ?').bind(email)]); } catch (e) { /* optional */ } }
  await env.ACCOUNTS.delete('user:' + email);
  if (env.DB) { try { await env.DB.prepare('DELETE FROM reviews WHERE email = ?').bind(email).run(); RV_CACHE.clear(); } catch (e) { /* review table is optional */ } }
  return ajson({ ok: true });
}

/* ---- install pings: anonymous, one per install per day, so people WITHOUT an account can be counted ---- */
async function handlePing(request, env) {
  let b = {}; try { b = await request.json(); } catch { return ajson({ error: 'Bad request' }, 400); }
  const id = String(b.id || '');
  if (!/^[a-z0-9]{16,64}$/.test(id)) return ajson({ error: 'Bad id' }, 400);
  const v = String(b.v || '').slice(0, 20), ch = String(b.ch || '').slice(0, 20), a = b.a ? 1 : 0;
  const key = 'inst:' + id;
  const cur = await env.ACCOUNTS.getWithMetadata(key);
  const m = cur.metadata || {};
  const now = Date.now();
  if (!cur.value || m.v !== v || m.ch !== ch || !!m.a !== !!a || !m.s || now - m.s > 20 * 3600e3) {
    await env.ACCOUNTS.put(key, '1', { metadata: { c: m.c || now, s: now, v, ch, a } });
  }
  return ajson({ ok: true });
}

/* ---- announcements: you write one in the admin page; every extension picks it up on its next check
 *      and sends it to its OWN Telegram bot (so it reaches people without an account too). ---- */
let ANN_CACHE = null;           // { exp, body }
async function handleAnnounce(env, request) {
  if (ANN_CACHE && ANN_CACHE.exp > Date.now()) return ajson(ANN_CACHE.body);
  let fixed = null;
  try {
    const st = await env.ASSETS.fetch(new Request(new URL('/status.json', request.url)));
    if (st && st.ok) fixed = await st.json();
  } catch (e) { fixed = null; }
  let a = null, kvMaint = null, kvOk = true;
  try {
    a = await env.ACCOUNTS.get('announce:latest', 'json');
    kvMaint = await env.ACCOUNTS.get('maint:state', 'json');
  } catch (e) { kvOk = false; }
  const sm = fixed && fixed.maint;
  let maint = kvMaint || { on: false };
  if (sm && (!kvMaint || (sm.at || 0) > (kvMaint.at || 0))) maint = sm;      // the newest state wins
  const body = { ...(a || {}), maint };
  ANN_CACHE = { exp: Date.now() + (kvOk ? 120000 : 30000), body };
  return ajson(body);
}
/* Maintenance switch: every install (and the website) shows "UNDERGOING MAINTENANCE" while it is on. */
async function adminMaintenance(request, env) {
  if (!(await adminAuth(request, env))) return ajson({ error: 'Signed out.' }, 401);
  let b = {}; try { b = await request.json(); } catch { return ajson({ error: 'Bad request' }, 400); }
  const prev = await env.ACCOUNTS.get('maint:state', 'json');
  const on = !!b.on;
  const msg = String(b.msg || '').trim().slice(0, 400) || 'The service is undergoing maintenance. Alerts may be delayed. You will be told when it is back.';
  const st = { on, msg, id: (prev && prev.on === on && prev.id) ? prev.id : rid(8), at: Date.now() };
  const mv = String(b.minVersion || '').trim();
  if (mv) {
    if (!/^\d+(\.\d+){1,3}$/.test(mv)) return ajson({ error: 'Version looks like 1.15.2' }, 400);
    st.minVersion = mv;                        // builds at or above this version ignore the notice
  }
  if (b.kind === 'update') { st.kind = 'update'; if (b.block) st.block = true; }
  await env.ACCOUNTS.put('maint:state', JSON.stringify(st));
  ANN_CACHE = null;
  return ajson({ ok: true, maint: st });
}
async function adminAnnounce(request, env) {
  if (!(await adminAuth(request, env))) return ajson({ error: 'Signed out.' }, 401);
  let b = {}; try { b = await request.json(); } catch { return ajson({ error: 'Bad request' }, 400); }
  const text = String(b.text || '').trim().slice(0, 1500);
  const title = String(b.title || '').trim().slice(0, 100);
  if (b.clear) { await env.ACCOUNTS.delete('announce:latest'); ANN_CACHE = null; return ajson({ ok: true }); }
  // Optional: the same notice also shows as a dismissible banner inside the popup (1.16.0+).
  let banner = null;
  if (b.banner && typeof b.banner === 'object') {
    const bt = String(b.banner.text || '').trim().slice(0, 240);
    if (bt.length >= 3) {
      const bl = String(b.banner.link || '').trim().slice(0, 300);
      if (bl && !/^https:\/\/[^\s"'<>]+$/i.test(bl)) return ajson({ error: 'Banner link must start with https://' }, 400);
      banner = {
        title: String(b.banner.title || '').trim().slice(0, 60),
        text: bt,
        link: bl,
        label: String(b.banner.label || '').trim().slice(0, 24) || 'Learn more'
      };
    }
  }
  // Attach (or remove) a banner on the live notice WITHOUT changing its id, so nobody
  // gets the same Telegram message twice (extensions skip ids they already sent).
  if (b.bannerOnly) {
    const prev = await env.ACCOUNTS.get('announce:latest', 'json');
    if (!prev || !prev.id) return ajson({ error: 'Nothing is published to attach a banner to.' }, 400);
    if (banner) prev.banner = banner; else delete prev.banner;
    await env.ACCOUNTS.put('announce:latest', JSON.stringify(prev));
    ANN_CACHE = null;
    return ajson({ ok: true, announce: prev });
  }
  if (text.length < 3) return ajson({ error: 'Write the message first.' }, 400);
  const a = { id: rid(10), title, text, at: Date.now() };
  const mv = String(b.minVersion || '').trim();
  if (mv) {
    if (!/^\d+(\.\d+){1,3}$/.test(mv)) return ajson({ error: 'Version looks like 1.15.1' }, 400);
    a.minVersion = mv;            // each extension compares this with ITS OWN version; nothing about the user is stored
  }
  if (banner) a.banner = banner;
  await env.ACCOUNTS.put('announce:latest', JSON.stringify(a));
  ANN_CACHE = null;
  return ajson({ ok: true, announce: a });
}

/* ---- email to every account holder, through YOUR Gmail via a small Apps Script (MAIL-HOOK.gs).
 *      Dormant until MAIL_HOOK_URL and MAIL_HOOK_SECRET are set. ---- */
async function adminEmail(request, env) {
  if (!(await adminAuth(request, env))) return ajson({ error: 'Signed out.' }, 401);
  if (!env.MAIL_HOOK_URL || !env.MAIL_HOOK_SECRET) return ajson({ error: 'Email is not connected yet (see MAIL-HOOK.gs).' }, 503);
  let b = {}; try { b = await request.json(); } catch { return ajson({ error: 'Bad request' }, 400); }
  const subject = String(b.subject || '').trim().slice(0, 150);
  const text = String(b.text || '').trim().slice(0, 5000);
  if (!subject || text.length < 3) return ajson({ error: 'Add a subject and a message.' }, 400);
  const to = [];
  let cursor;
  do {
    const r = await env.ACCOUNTS.list({ prefix: 'user:', cursor, limit: 1000 });
    for (const k of r.keys) to.push(k.name.slice(5));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor && to.length < 2000);
  const only = String(b.only || '').trim().toLowerCase();
  const list = only ? to.filter(e => e === only) : to;
  if (!list.length) return ajson({ error: 'No recipients.' }, 400);
  const body = text + '\n\n—\nYou are getting this because you created a Lynch Digitance Alerts account.';
  let sent = 0, failed = 0;
  for (let i = 0; i < list.length; i += 40) {
    try {
      const r = await fetch(env.MAIL_HOOK_URL, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ secret: env.MAIL_HOOK_SECRET, subject, text: body, to: list.slice(i, i + 40) }) });
      const j = await r.json().catch(() => ({}));
      if (j && j.ok) sent += j.sent || 0; else failed += list.slice(i, i + 40).length;
    } catch { failed += list.slice(i, i + 40).length; }
  }
  return ajson({ ok: failed === 0, sent, failed, total: list.length });
}

/* ---------------------------------------------------------------- reviews (D1)
 * The only identity shown with a review is a short name made from the account email ("Ethan C."),
 * never the address itself. Someone without an account posts as "Alerts user". Hiding a review is
 * silent: it disappears for everyone but its author. */
const ANON_NAME = 'Alerts user';
const RV_CACHE = new Map();               // limit -> { at, body }   (a flood of page views must not become a flood of reads)
class RvErr extends Error { constructor(m, s) { super(m); this.status = s; } }

/* The name a person chose for their profile, or '' when it is unusable.
   2–24 characters: letters (any language), numbers, space, . _ - ' */
function cleanDisplayName(v) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 24) return '';
  if (/https?:\/\/|www\.|@/i.test(t)) return '';
  if (!/^[\p{L}\p{N} '._-]+$/u.test(t)) return '';
  return t;
}

function reviewName(email, displayName) {
  const chosen = cleanDisplayName(displayName);
  if (chosen) return chosen;
  if (!email) return ANON_NAME;
  const local = String(email).split('@')[0].split('+')[0];
  const parts = local.split(/[._-]+/).map(p => p.replace(/[^a-z]/gi, '')).filter(Boolean);
  if (!parts.length) return ANON_NAME;
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  const first = cap(parts[0].slice(0, 14)) + (parts[0].length > 14 ? '…' : '');
  return parts[1] ? first + ' ' + parts[1].charAt(0).toUpperCase() + '.' : first;
}
function cleanReviewText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new RvErr("Your review couldn't be saved.", 400);
  const t = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > 500) throw new RvErr('Please keep your review under 500 characters.', 400);
  if (/(https?:\/\/|www\.)/i.test(t)) throw new RvErr('Please leave links out of your review.', 400);
  return t;
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret || 'x')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}
const rvJson = (o, s = 200, extra = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_ACCT, ...extra } });
const INSTALL_RE = /^[a-z0-9]{16,64}$/;

async function handleReviews(request, env, url) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    /* public list: the extension's Reviews tab and the website */
    if (url.pathname === '/reviews' && request.method === 'GET') {
      const want = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit'), 10) || 30));
      const hit = RV_CACHE.get(want);
      let body;
      if (hit && Date.now() - hit.at < 15000) body = hit.body;
      else {
        const agg = await env.DB.prepare('SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE hidden = 0').first();
        const rows = (await env.DB.prepare('SELECT id, name, rating, body, created_at, reply, reply_at FROM reviews WHERE hidden = 0 ORDER BY created_at DESC, id DESC LIMIT ?').bind(want).all()).results || [];
        body = JSON.stringify({
          count: agg.n || 0,
          average: agg.n ? Math.round(agg.avg * 10) / 10 : 0,
          reviews: rows.map(r => ({ id: r.id, name: r.name, rating: r.rating, text: r.body, at: r.created_at, reply: r.reply || null, replyAt: r.reply_at || null }))
        });
        RV_CACHE.set(want, { at: Date.now(), body });
      }
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30', ...CORS_ACCT } });
    }

    if (env.REVIEW_LIMITER) {
      const { success } = await env.REVIEW_LIMITER.limit({ key: 'rv:' + ip });
      if (!success) throw new RvErr('Slow down. Try again in a minute.', 429);
    }
    // signing in is optional; if the session cannot be checked right now the review is simply sent without an account
    let email = null;
    if (/^Bearer /.test(request.headers.get('Authorization') || '')) { try { email = await sessionEmail(request, env); } catch (e) { email = null; } }

    /* what this account / install has already written */
    if (url.pathname === '/reviews/mine' && request.method === 'GET') {
      const inst = url.searchParams.get('install') || '';
      let row = null;
      if (email) row = await env.DB.prepare('SELECT id, name, rating, body, reply FROM reviews WHERE email = ?').bind(email).first();
      if (!row && INSTALL_RE.test(inst)) row = await env.DB.prepare('SELECT id, name, rating, body, reply FROM reviews WHERE install_id = ?').bind(inst).first();
      // a review the owner hid is still shown to its author as theirs
      return rvJson({ review: row ? { id: row.id, name: row.name, rating: row.rating, text: row.body, reply: row.reply || null } : null });
    }

    /* write or edit one */
    if (url.pathname === '/reviews' && request.method === 'POST') {
      let b = {}; try { b = await request.json(); } catch { throw new RvErr('Bad request', 400); }
      const rating = Number.isInteger(b.rating) && b.rating >= 1 && b.rating <= 5 ? b.rating : null;
      if (rating === null) throw new RvErr('Choose 1 to 5 stars.', 400);
      const text = cleanReviewText(b.text);
      const install = typeof b.install === 'string' && INSTALL_RE.test(b.install) ? b.install : null;
      const version = typeof b.v === 'string' && /^\d{1,3}(\.\d{1,3}){1,3}$/.test(b.v) ? b.v : null;
      if (!email && !install) throw new RvErr("Your review couldn't be saved.", 400);

      const now = Date.now(), DAY = 86400000;
      const ipHash = (await hmacHex(env.PEPPER, 'review-ip:' + ip)).slice(0, 24);

      let row = null;
      if (email) row = await env.DB.prepare('SELECT id, name FROM reviews WHERE email = ?').bind(email).first();
      let installFree = !!install;
      if (!row && install) {
        const byInstall = await env.DB.prepare('SELECT id, email, name FROM reviews WHERE install_id = ?').bind(install).first();
        // a signed-out edit, or the account signing in on this install, continues that review; another account's stays theirs
        if (byInstall && (!byInstall.email || !email || byInstall.email === email)) row = byInstall;
        else if (byInstall) installFree = false;
      }

      /* The name shown is the one on the profile. A name typed with a review is
         saved to the profile too, so every review by this account — old ones
         included — is shown under it. */
      let displayName = '';
      if (email) {
        try { const urec = await env.ACCOUNTS.get('user:' + email, 'json'); displayName = (urec && urec.displayName) || ''; } catch {}
      }
      const typed = cleanDisplayName(b.name);
      let shownName;
      if (email) {
        if (typed && typed !== displayName) {
          displayName = typed;
          try {
            const rec = await env.ACCOUNTS.get('user:' + email, 'json');
            if (rec) { rec.displayName = typed; rec.updated = now; rec.lastSeen = rec.lastSeen || now; await putUser(env, email, rec, version || undefined); }
            await env.DB.prepare('UPDATE reviews SET name = ? WHERE email = ?').bind(reviewName(email, typed), email).run();
          } catch { /* the review itself must still save */ }
        }
        shownName = reviewName(email, displayName);
      } else {
        shownName = typed || (row && row.name) || ANON_NAME;
      }

      try {
        if (row) {
          if (email) {
            await env.DB.prepare('UPDATE reviews SET rating = ?, body = ?, version = COALESCE(?, version), updated_at = ?, email = ?, name = ?, install_id = COALESCE(install_id, ?) WHERE id = ?')
              .bind(rating, text, version, now, email, shownName, installFree ? install : null, row.id).run();
          } else {
            await env.DB.prepare('UPDATE reviews SET rating = ?, body = ?, version = COALESCE(?, version), updated_at = ?, name = ? WHERE id = ?').bind(rating, text, version, now, shownName, row.id).run();
          }
        } else {
          const recent = (await env.DB.prepare('SELECT COUNT(*) AS n FROM reviews WHERE ip_hash = ? AND created_at > ?').bind(ipHash, now - DAY).first()).n;
          if (recent >= 3) throw new RvErr("That's enough reviews from this connection for today.", 429);
          await env.DB.prepare('INSERT INTO reviews (email, install_id, name, rating, body, version, created_at, updated_at, hidden, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
            .bind(email || null, installFree ? install : null, shownName, rating, text, version, now, now, ipHash).run();
        }
      } catch (e) {
        if (e instanceof RvErr) throw e;
        throw new RvErr('Your review is already saved.', 409);
      }
      RV_CACHE.clear();
      return rvJson({ ok: true, name: shownName, created: !row }, row ? 200 : 201);
    }
    return rvJson({ error: 'Not found' }, 404);
  } catch (e) {
    if (e instanceof RvErr) return rvJson({ error: e.message }, e.status);
    throw e;
  }
}

/* owner only: every review, hidden ones included, with the real email */
async function adminReviews(request, env) {
  if (!(await adminAuth(request, env))) return ajson({ error: 'Signed out.' }, 401);
  if (!env.DB) return ajson({ error: 'Reviews are not set up yet.' }, 503);
  const rows = (await env.DB.prepare('SELECT id, name, email, rating, body, version, created_at AS created, updated_at AS updated, hidden, reply, reply_at FROM reviews ORDER BY created_at DESC, id DESC LIMIT 1000').all()).results || [];
  const shown = rows.filter(r => !r.hidden);
  return ajson({
    stats: { total: rows.length, visible: shown.length, hidden: rows.length - shown.length,
             average: shown.length ? Math.round((shown.reduce((n, r) => n + r.rating, 0) / shown.length) * 10) / 10 : 0 },
    reviews: rows.map(r => ({ id: r.id, name: r.name, email: r.email || null, rating: r.rating, text: r.body, version: r.version || null, created: r.created, updated: r.updated, hidden: !!r.hidden, reply: r.reply || null, replyAt: r.reply_at || null }))
  });
}
/* owner only: write, change or remove the studio's public reply under a review */
async function adminReviewReply(request, env) {
  if (!(await adminAuth(request, env))) return ajson({ error: 'Signed out.' }, 401);
  if (!env.DB) return ajson({ error: 'Reviews are not set up yet.' }, 503);
  let b = {}; try { b = await request.json(); } catch { return ajson({ error: 'Bad request' }, 400); }
  const id = parseInt(b.id, 10);
  if (!Number.isInteger(id) || id < 1 || typeof b.reply !== 'string') return ajson({ error: 'Bad request' }, 400);
  const reply = b.reply.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 500);
  const res = await env.DB.prepare('UPDATE reviews SET reply = ?, reply_at = ? WHERE id = ?').bind(reply || null, reply ? Date.now() : null, id).run();
  if (!res.meta.changes) return ajson({ error: 'No such review.' }, 404);
  RV_CACHE.clear();
  return ajson({ ok: true, reply: reply || null });
}
async function adminReviewHide(request, env) {
  if (!(await adminAuth(request, env))) return ajson({ error: 'Signed out.' }, 401);
  if (!env.DB) return ajson({ error: 'Reviews are not set up yet.' }, 503);
  let b = {}; try { b = await request.json(); } catch { return ajson({ error: 'Bad request' }, 400); }
  const id = parseInt(b.id, 10);
  if (!Number.isInteger(id) || id < 1 || typeof b.hidden !== 'boolean') return ajson({ error: 'Bad request' }, 400);
  const res = await env.DB.prepare('UPDATE reviews SET hidden = ? WHERE id = ?').bind(b.hidden ? 1 : 0, id).run();
  if (!res.meta.changes) return ajson({ error: 'No such review.' }, 404);
  RV_CACHE.clear();
  return ajson({ ok: true, hidden: b.hidden });
}

async function handleAI(request, env) {
  if (!env.AI) {
    return json({
      error: 'not-configured',
      reply: "The assistant isn't switched on yet. Add the Workers AI binding named AI, then redeploy."
    }, 503);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad-json' }, 400); }

  const history = Array.isArray(body.messages) ? body.messages.slice(-MAX_HISTORY) : [];
  if (!history.length) return json({ error: 'no-messages' }, 400);

  // Trim anything oversized rather than rejecting — a truncated question still
  // gets a useful answer, an error message doesn't.
  const messages = history
    .filter(m => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE) }));

  if (!messages.length) return json({ error: 'no-usable-messages' }, 400);

  try {
    // --- screenshot path ---------------------------------------------------
    if (body.image && typeof body.image === 'string') {
      const b64 = body.image.replace(/^data:image\/\w+;base64,/, '');
      if (b64.length / 1024 > MAX_IMAGE_KB) {
        return json({ reply: 'That screenshot is too large — crop it to just the error and try again.' });
      }
      const bytes = [...atob(b64)].map(c => c.charCodeAt(0));
      const last = messages[messages.length - 1].content;

      const [vision, vModel] = await runFirstAvailable(env, VISION_MODELS, {
        image: bytes,
        prompt: `You are LYNCH AI ASSISTANT, supporting the Lynch Digitance Alerts Chrome extension. ` +
                `Describe exactly what this screenshot shows, quoting any error text verbatim. ` +
                `The user says: ${last}`,
        max_tokens: 400
      }, workingVision);
      workingVision = vModel;

      const seen = vision?.description || vision?.response || '';
      // Hand the description to the text model, which knows the fixes.
      messages.push({
        role: 'user',
        content: `[Screenshot contents, described automatically]\n${seen}\n\nBased on this, what is wrong and how do I fix it?`
      });
    }

    /* This worker is the WEBSITE assistant only. The extension has its own
       worker (ai-worker/, deployed as alerts-ai) holding only extension
       knowledge, so the two can never bleed into each other. */
    const base = SYSTEM_SITE;

    const sys = body.state
      ? base + `\n\nDIAGNOSTIC STATE reported by the user's extension:\n${String(body.state).slice(0, 3000)}`
      : base;

    const [out, model] = await runFirstAvailable(env, TEXT_MODELS, {
      messages: [{ role: 'system', content: sys }, ...messages],
      max_tokens: 700,
      temperature: 0.3
    }, workingText);
    workingText = model;

    const reply = (out?.response || '').trim();
    return json({
      reply: reply || "I couldn't work that one out. Press Diagnose a problem and paste what it says.",
      model                                   // handy when checking which one is live
    });

  } catch (err) {
    return json({
      error: 'ai-failed',
      reply: 'The assistant is temporarily unavailable. Press "Diagnose a problem" in the extension — it works offline and covers the common faults.',
      detail: String(err).slice(0, 200)
    }, 502);
  }
}
