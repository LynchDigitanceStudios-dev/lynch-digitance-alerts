/* Lynch Digitance Alerts: reviews (background side).
 *
 * Imported by background.js. The popup never sees the account token: it asks this module, which talks
 * to the server (the same one that holds extension accounts).
 *
 * chrome.storage.local "fvnReview":
 *   state   'pending'  not reviewed yet, will be asked when dueAt passes
 *           'snoozed'  pressed "Maybe later" (asked again after a week)
 *           'done'     reviewed (can still be edited from the Reviews tab)
 *           'never'    pressed "Don't ask again"
 *   dueAt   ms: the review window opens on the first popup open at or after this moment
 *   asks    how many times the window has been shown
 *   mine    the review this install sent: { rating, text, name }
 *   note    true until the person has seen the "what's new" note for this update
 *
 * Who is asked, and when:
 *  - A new install: 3 days after it was installed.
 *  - Someone who updates from an older version (before reviews existed): at once, on the next popup open,
 *    together with a short "what's new" note.
 *  - Showing the window counts as an ask: if it is ignored it comes back tomorrow, not on every open.
 *  - "Maybe later" = 7 days. "Don't ask again" = never. Sending a review = never asked again.
 *  - Someone who already reviewed (same account, or this install) is not asked.
 */
const KEY = 'fvnReview';
const DAY = 86400000;
const FIRST_ASK_AFTER = 3 * DAY;
const SNOOZE_LATER = 7 * DAY;
const SNOOZE_SHOWN = DAY;
export const SINCE = '1.15.2';          // reviews arrived in this version
const TEXT_MAX = 500;
const TIMEOUT_MS = 12000;
const API = 'https://alerts.lynchdigitancestudios.workers.dev';

const verParts = v => String(v).split('.').map(n => parseInt(n, 10) || 0);
function isOlder(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0;
  }
  return false;
}

async function get() {
  const s = await chrome.storage.local.get(KEY);
  return Object.assign({ state: 'pending', dueAt: null, firstUse: null, asks: 0, mine: null, note: false }, s[KEY] || {});
}
const put = r => chrome.storage.local.set({ [KEY]: r });

// the same random install ID the daily check uses
async function installId() {
  const s = await chrome.storage.local.get('fvnInstallId');
  if (s.fvnInstallId) return s.fvnInstallId;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(20)), x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
  await chrome.storage.local.set({ fvnInstallId: id });
  return id;
}
async function token() { return (await chrome.storage.local.get('acctToken')).acctToken || null; }

async function req(path, o) {
  o = o || {};
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  let res;
  try {
    res = await fetch(API + path, {
      method: o.method || 'GET',
      cache: 'no-store',
      headers: Object.assign({ 'Content-Type': 'application/json' }, o.token ? { Authorization: 'Bearer ' + o.token } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined
    });
  } catch (e) {
    return { ok: false, status: 0, error: "Couldn't reach the server. Check your connection and try again." };
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data && data.error) || 'Something went wrong. Please try again.' };
}

/* Extension installed or updated. Returns { openNow } so the worker can draw attention to the popup. */
async function onInstalled(details) {
  if (!details) return { openNow: false };
  const r = await get();
  if (details.reason === 'install') {
    if (!r.firstUse) { r.firstUse = Date.now(); r.dueAt = r.firstUse + FIRST_ASK_AFTER; }
    await put(r);
    return { openNow: false };
  }
  if (details.reason !== 'update') return { openNow: false };
  if (!isOlder(details.previousVersion || '0', SINCE)) return { openNow: false };
  r.note = true;                                           // show the "what's new" note once
  if (r.state !== 'done' && r.state !== 'never') { r.state = 'pending'; r.dueAt = Date.now(); }
  if (!r.firstUse) r.firstUse = Date.now();
  await put(r);
  return { openNow: true };
}

/* The popup asks this each time it opens. Showing the review window counts as an ask. */
async function prompt() {
  const r = await get();
  const now = Date.now();
  const due = (r.state === 'pending' || r.state === 'snoozed') && r.dueAt && now >= r.dueAt;
  if (!due && !r.note) return { show: false, note: false };

  let signedIn = false;
  if (due) {
    const tk = await token();
    signedIn = !!tk;
    const m = await req('/reviews/mine?install=' + encodeURIComponent(await installId()), { token: tk });
    if (m.ok && m.data && m.data.review) {                 // already reviewed (this install, or this account elsewhere)
      r.state = 'done';
      r.mine = m.data.review;
      await put(r);
      return { show: false, note: !!r.note };
    }
    r.dueAt = now + SNOOZE_SHOWN;
    r.asks = (r.asks || 0) + 1;
    await put(r);
  }
  return { show: !!due, note: !!r.note, mine: r.mine || null, signedIn, version: chrome.runtime.getManifest().version };
}

async function noteSeen() {
  const r = await get();
  if (r.note) { r.note = false; await put(r); }
  await chrome.storage.local.remove('fvnAttention');
  return { ok: true };
}

async function later() {
  const r = await get();
  if (r.state === 'done' || r.state === 'never') return { ok: true };
  r.state = 'snoozed';
  r.dueAt = Date.now() + SNOOZE_LATER;
  await put(r);
  return { ok: true };
}

async function never() {
  const r = await get();
  if (r.state !== 'done') r.state = 'never';
  await put(r);
  return { ok: true };
}

async function submit(rating, text) {
  rating = Number(rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'Choose 1 to 5 stars.' };
  text = typeof text === 'string' ? text.trim() : '';
  if (text.length > TEXT_MAX) return { ok: false, error: 'Please keep your review under 500 characters.' };
  if (/(https?:\/\/|www\.)/i.test(text)) return { ok: false, error: 'Please leave links out of your review.' };

  const tk = await token();
  const body = { rating, text, install: await installId(), v: chrome.runtime.getManifest().version };
  let r = await req('/reviews', { method: 'POST', token: tk, body });
  if (r.status === 401 && tk) {                            // the saved login expired: send it without an account
    await chrome.storage.local.remove('acctToken');
    r = await req('/reviews', { method: 'POST', body });
  }
  if (!r.ok) return { ok: false, error: r.error };

  const st = await get();
  st.state = 'done';
  st.mine = { rating, text, name: r.data && r.data.name ? r.data.name : '' };
  await put(st);
  return { ok: true, name: st.mine.name, created: !!(r.data && r.data.created) };
}

/* The public reviews plus this install's own (the Reviews tab). */
async function list() {
  const tk = await token();
  const inst = await installId();
  const [pub, mine] = await Promise.all([
    req('/reviews?limit=30'),
    req('/reviews/mine?install=' + encodeURIComponent(inst), { token: tk })
  ]);
  if (!pub.ok || !pub.data) return { ok: false, error: pub.error || 'Could not load the reviews.' };

  let m = null;
  const st = await get();
  if (mine.ok && mine.data) {
    m = mine.data.review || null;
    // the server is the truth: a review that was removed is no longer "mine"
    if ((m ? JSON.stringify(m) : '') !== (st.mine ? JSON.stringify(st.mine) : '')) {
      st.mine = m;
      if (m && st.state !== 'never') st.state = 'done';
      await put(st);
    }
  } else {
    m = st.mine || null;                                   // offline for this part: show what was last sent
  }
  return { ok: true, count: pub.data.count || 0, average: pub.data.average || 0, reviews: pub.data.reviews || [], mine: m };
}

/* The popup waits on every reply, so none of these may throw. */
const safe = (fn, fallback) => async (...args) => {
  try { return await fn(...args); } catch (e) { return fallback; }
};
const FAIL = { ok: false, error: 'Something went wrong. Please try again.' };

export const LynchReview = {
  SINCE,
  FIRST_ASK_AFTER,
  onInstalled: safe(onInstalled, { openNow: false }),
  prompt: safe(prompt, { show: false, note: false }),
  noteSeen: safe(noteSeen, { ok: true }),
  later: safe(later, FAIL),
  never: safe(never, FAIL),
  submit: safe(submit, FAIL),
  list: safe(list, { ok: false, error: 'Could not load the reviews.' })
};
