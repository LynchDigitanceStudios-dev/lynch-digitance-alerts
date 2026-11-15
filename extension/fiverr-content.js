/*
 * fiverr-content.js — ISOLATED world. Turns raw page signals into events and
 * hands them to the service worker. Read-only: it never clicks, submits, or
 * requests anything from Fiverr.
 *
 * Detection rules learned from real traffic:
 *
 *  1. Fiverr's own conversation data contains BOTH sides of a thread, with no
 *     usable "this one is mine" flag. Anything we can't attribute to a real
 *     other-party sender is therefore dropped rather than guessed at — that is
 *     what stopped the user's own replies being sent back to them.
 *  2. Every message also fires a notification-bell echo carrying the same text.
 *     Both paths now produce the same fingerprint so the worker can collapse
 *     them into one alert.
 *  3. Notification rows look like "R Roman M. @roman_morgan <message text>".
 *     The @handle is the other party, and it gives us a correct inbox link.
 */
(() => {
  if (window.__fvn_content) return;
  window.__fvn_content = true;

  const bootTime = Date.now();
  const SETTLE = 6000;              // ignore everything during page boot
  let account = 'unknown';
  let debugMode = false;

  chrome.storage.local.get({ debugMode: false }).then(c => { debugMode = c.debugMode; });
  chrome.storage.onChanged.addListener(ch => {
    if (ch.debugMode) debugMode = ch.debugMode.newValue;
  });

  const dbg = (source, detail) => {
    if (!debugMode) return;
    chrome.runtime.sendMessage({ kind: 'fvn-debug', entry: { ts: Date.now(), source, detail } })
      .catch(() => {});
  };

  /* ------------------------------------------------------------------ text */

  const clean = t => String(t || '')
    .replace(/<[^>]*>/g, ' ')       // strip HTML that leaks out of Fiverr's payloads
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  /* Fiverr's chrome — safety banners, buttons, thread furniture — kept getting
     scooped up as if it were a message. Anything matching these is not one. */
  const UI_JUNK = [
    /WE HAVE YOUR BACK/i,
    /keep payments and communications within Fiverr/i,
    /Translate to English/i,
    /This is your first conversation with this person/i,
    /avoid sharing personal information/i,
    /Click here for more info/i,
    /^(Got it|Report|Learn more|Show more|See all)$/i,
    /^\s*$/
  ];
  const isJunk = t => UI_JUNK.some(r => r.test(t));

  /* A single alert should be a single message. Blobs this long are a container
     that swallowed a banner, a thread, or the whole notification dropdown. */
  const TOO_LONG_FOR_ONE_MESSAGE = 6000;   // Fiverr allows ~2,500 characters per message; never drop a real one

  /* ------------------------------------------------------------- identity */

  /* Words that look like a username but aren't one. Picking one of these up
     produced the "WATCHER OFFLINE · unknown" alerts — a phantom account that
     never checks in again. */
  const NOT_A_USERNAME = new Set([
    'unknown', 'undefined', 'null', 'me', 'you', 'user', 'users', 'inbox',
    'seller_dashboard', 'dashboard', 'settings', 'login', 'logout', 'home'
  ]);

  const validUser = v =>
    typeof v === 'string' &&
    /^[A-Za-z0-9_.-]{3,40}$/.test(v.trim()) &&
    !NOT_A_USERNAME.has(v.trim().toLowerCase());

  function detectAccount() {
    const tries = [
      () => window.__INITIAL_DATA__?.currentUser?.username,
      () => window.__INITIAL_DATA__?.userData?.username,
      () => window.initialData?.currentUser?.username,
      () => document.querySelector('[data-username]')?.getAttribute('data-username'),
      () => document.querySelector('meta[name="user-name"]')?.content,
      // The seller dashboard and gig-manager URLs both carry the username.
      () => /\/users\/([A-Za-z0-9_.-]+)\//.exec(location.pathname)?.[1],
      () => document.querySelector('a[href*="/seller_dashboard"]')
              ?.getAttribute('href')?.match(/\/users\/([A-Za-z0-9_.-]+)/)?.[1],
      () => document.querySelector('a[href^="/users/"]')?.getAttribute('href')?.split('/')[2],
      () => document.querySelector('[class*="user-menu"] a[href^="/users/"]')
              ?.getAttribute('href')?.split('/')[2],
      () => document.querySelector('.user-menu-username, .username')?.textContent?.trim()
    ];
    for (const t of tries) {
      try {
        const v = t();
        if (validUser(v)) return v.trim();
      } catch {}
    }
    return null;                               // null, never the string "unknown"
  }

  /* Detection can fail on pages that don't expose the username — an order page,
     a redirect, a slow render. Remembering the last good answer for this tab
     stops a temporary miss from being reported as a different account. */
  const REMEMBER_KEY = '__fvn_account';
  try { account = sessionStorage.getItem(REMEMBER_KEY) || null; } catch { account = null; }

  function refreshAccount() {
    const found = detectAccount();
    if (found) {
      account = found;
      try { sessionStorage.setItem(REMEMBER_KEY, found); } catch {}
    }
    return account;
  }
  refreshAccount();

  // Retry on a short ramp — the username often isn't in the DOM on first paint.
  [1000, 3000, 6000, 12000, 25000].forEach(ms => setTimeout(refreshAccount, ms));

  function ownNames() {
    const names = new Set(['me', 'you', 'fiverr']);
    if (account && account !== 'unknown') names.add(account.toLowerCase());
    const el = document.querySelector('[class*="user-menu"] [class*="name"], header img[alt]');
    const alt = el?.getAttribute?.('alt') || el?.textContent;
    if (alt && alt.trim().length < 60) names.add(alt.trim().toLowerCase());
    return names;
  }

  function isOwn(name) {
    if (!name) return true;                       // unattributed == not trustworthy
    const s = String(name).toLowerCase().replace(/[^a-z0-9_. ]/g, '').trim();
    for (const n of ownNames()) if (s === n || s.startsWith(n + ' ')) return true;
    return false;
  }

  /* ---------------------------------------------------------------- links */

  const inboxLink = user =>
    user ? `https://www.fiverr.com/inbox/${user}` : 'https://www.fiverr.com/inbox';

  /* --------------------------------------------------------------- emit */

  const localSeen = new Set();

  // Thread opened → its history renders → stay quiet for a moment.
  let historyQuietUntil = 0;
  let sentTimes = [], lastBurstNote = 0;
  let lastPath = location.pathname;
  const quietForHistory = () => { historyQuietUntil = Date.now() + 8000; };
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; quietForHistory(); }
  }, 300);
  // The Navigation API fires at the START of a page change, before anything has rendered. The
  // 300ms poll above was too slow: the thread had already drawn itself by the time it noticed.
  try { window.navigation && window.navigation.addEventListener('navigate', quietForHistory); } catch {}
  document.addEventListener('click', e => {
    if (e.target.closest && e.target.closest('a[href*="/inbox/"], [data-conversation-id], [role="listitem"]')) quietForHistory();
  }, true);
  // Scrolling up in a thread loads older messages — that's history too.
  document.addEventListener('scroll', () => {
    if (/\/inbox\//.test(location.pathname)) historyQuietUntil = Math.max(historyQuietUntil, Date.now() + 3000);
  }, true);

  function send(evt) {
    evt.text = clean(evt.text);
    if (!evt.text || isJunk(evt.text)) return;
    if (evt.text.length > TOO_LONG_FOR_ONE_MESSAGE && evt.type !== 'brief') {
      dbg('dropped-oversize', { len: evt.text.length, head: evt.text.slice(0, 120) });
      return;
    }
    if (evt.type === 'message' && isOwn(evt.from)) {
      dbg('dropped-own', { from: evt.from, head: evt.text.slice(0, 80) });
      return;
    }
    /* Fiverr's inbox list previews your own last reply as "Me: …". Any text
       carrying that marker is yours, whatever path found it. */
    if (/(^|\s)Me:\s/.test(evt.text)) {
      dbg('dropped-own-preview', { head: evt.text.slice(0, 80) });
      return;
    }

    /* Fingerprint is content-based, NOT path-based, so the message and its
       notification echo collapse to one alert. The worker keeps these across
       page loads, which is what stops the backlog replaying on every refresh. */
    evt.fingerprint = (account + '|' + evt.text.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 140));

    /* System-generated alerts ("you have N unread", bell pings) repeat the same
       words every time. Deduplicating them meant the FIRST one got through and
       every later one was silently dropped for a week. They opt out. */
    if (!evt.noDedupe) {
      if (localSeen.has(evt.fingerprint)) return;
      localSeen.add(evt.fingerprint);
      if (localSeen.size > 800) localSeen.clear();
    }

    /* Opening a chat loads and renders its whole history. Anything seen in the
       few seconds after a thread opens is history: remember it, never send it. */
    if (evt.type === 'message' && Date.now() >= historyQuietUntil) {
      const now = Date.now();
      sentTimes = sentTimes.filter(t => now - t < 60000);
      if (sentTimes.length >= 5) {
        dbg('dropped-burst', { head: evt.text.slice(0, 60) });
        if (now - lastBurstNote > 300000) {
          lastBurstNote = now;
          chrome.runtime.sendMessage({ kind: 'fvn-event', event: {
            type: 'alert', from: 'Fiverr', account: account || 'unidentified', ts: now, noDedupe: true,
            fingerprint: 'burst|' + now,
            text: 'A lot of messages appeared at once (usually an old conversation loading), so only the first few were sent. Open Fiverr to see the rest.',
            url: 'https://www.fiverr.com/inbox' } }).catch(() => {});
        }
        return;
      }
      sentTimes.push(now);
    }
    if (evt.type === 'message' && Date.now() < historyQuietUntil) {
      dbg('dropped-history', { head: evt.text.slice(0, 60) });
      return;
    }

    /* A message matters more than knowing which tab it came from, so an
       unidentified account still sends — just labelled honestly. */
    evt.account = account || 'unidentified';
    evt.ts = Date.now();
    evt.url = evt.url || inboxLink(evt.fromUser);
    chrome.runtime.sendMessage({ kind: 'fvn-event', event: evt }).catch(() => {});
  }

  /* ------------------------------------------------ notification row parsing
     Rows read "R Roman M. @roman_morgan <text>" — initial, display name,
     @handle, then the message. The handle is the other party. */
  const NOTIF_RE = /^[A-Z]?\s*(.{0,45}?)\s*@([A-Za-z0-9_.-]+)\s+([\s\S]+)$/;

  function parseNotificationRow(raw) {
    const t = clean(raw);
    const m = NOTIF_RE.exec(t);
    if (!m) return { from: null, fromUser: null, text: t };
    const handle = m[2];
    // Fiverr sometimes prints YOUR handle first; the other party is the one
    // that isn't you.
    const other = isOwn(handle) ? (m[1] || '').trim() : handle;
    return {
      from: other || handle,
      fromUser: isOwn(handle) ? null : handle,
      text: m[3]
    };
  }

  /* ------------------------------------------------- signal 1: JSON payloads */

  const TEXT_KEYS = ['body', 'message', 'text', 'content', 'snippet', 'lastMessage', 'last_message'];
  const NAME_KEYS = ['username', 'sender', 'senderName', 'sender_name', 'from', 'author', 'displayName'];

  function pick(obj, keys) {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object' && typeof v.username === 'string') return v.username;
    }
    return null;
  }

  const TIME_KEYS = ['createdAt','created_at','timestamp','sentAt','sent_at','time','date','created','lastMessageAt','last_message_at','lastMessageTime','last_message_time'];
  const OLD_MS = 5 * 60 * 1000;
  let curSkew = 0;                     // server clock minus this computer's clock
  function nodeTime(node) {
    for (const k of TIME_KEYS) {
      const v = node[k];
      if (typeof v === 'number' && isFinite(v)) { if (v > 1e12) return v; if (v > 1e9) return v * 1000; }
      else if (typeof v === 'string' && v.length >= 8) { const t = Date.parse(v); if (!isNaN(t)) return t; }
    }
    return null;
  }

  function walk(node, depth, out) {
    if (!node || depth > 8 || out.length > 12) return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1, out); return; }
    if (typeof node !== 'object') return;

    const text = pick(node, TEXT_KEYS);
    const from = pick(node, NAME_KEYS);

    /* A conversation message needs a real sender. Payloads carry your sent
       messages too, and with no reliable ownership flag an unattributed message
       is as likely to be yours as theirs — so it's dropped rather than guessed. */
    const ts = nodeTime(node);
    const old = ts !== null && (Date.now() + curSkew) - ts > OLD_MS;   // history, not news
    if (old && text) dbg('dropped-old-json', { ageMin: Math.round(((Date.now() + curSkew) - ts) / 60000), head: text.slice(0, 50) });
    if (!old && text && from && !isOwn(from) && text.length > 1) {
      out.push({ type: 'message', from, fromUser: from, text });
    }
    /* System notifications — orders, reviews, briefs — legitimately have no
       sender, so the rule above would silently swallow them. They're admitted
       on the strength of their wording instead. */
    else if (!old && text && !from && text.length > 8 && looksLikeNotification(text)) {
      out.push({ type: classify(text), from: 'Fiverr', text });
    }
    for (const k in node) walk(node[k], depth + 1, out);
  }

  window.addEventListener('__fvn_payload', (e) => {
    try {
      dbg('network', {
        url: String(e.detail.url).slice(0, 200),
        keys: Object.keys(e.detail.json || {}).slice(0, 25),
        sample: JSON.stringify(e.detail.json).slice(0, 1200)
      });
      if (Date.now() - bootTime < SETTLE) return;
      const sd = e.detail.serverDate ? Date.parse(e.detail.serverDate) : NaN;
      curSkew = isNaN(sd) ? 0 : sd - Date.now();
      const out = [];
      walk(e.detail.json, 0, out);
      out.forEach(send);
    } catch {}
  });

  /* ---------------------------------------- signal 2: unread title watcher */

  let lastTitle = document.title;
  let lastCount = unreadCount(document.title);

  function unreadCount(t) {
    const m = /^\((\d+)\)/.exec(t || '');
    return m ? +m[1] : 0;
  }

  function checkTitle() {
    const t = document.title;
    if (t === lastTitle) return;
    const prev = lastCount;
    lastTitle = t;
    lastCount = unreadCount(t);
    dbg('title', { from: prev, to: lastCount, title: t.slice(0, 120) });
    if (Date.now() - bootTime < SETTLE) return;
    if (lastCount > prev) {
      scrapeUnread('title');
      checkBell('title');
    }
  }
  setInterval(checkTitle, 2000);
  const titleEl = document.querySelector('title');
  if (titleEl) new MutationObserver(checkTitle)
    .observe(titleEl, { childList: true, characterData: true, subtree: true });

  /* ------------------------------------------- signal 3: unread inbox rows */

  function scrapeUnread(reason) {
    const rows = document.querySelectorAll(
      '[data-conversation-id], [class*="conversation-row"], [class*="inbox-row"], [role="listitem"]'
    );
    let found = 0;
    rows.forEach(row => {
      const cls = ((row.className || '') + '') + ' ' + (row.getAttribute?.('aria-label') || '');
      const unread = /unread|new/i.test(cls) || row.querySelector('[class*="unread"]');
      if (!unread) return;

      const txt = clean(row.innerText);
      if (!txt || txt.length > 800) return;

      const href = row.querySelector('a[href*="/inbox/"]')?.getAttribute('href')
                || row.closest('a[href*="/inbox/"]')?.getAttribute('href');
      const user = href ? /\/inbox\/([A-Za-z0-9_.-]+)/.exec(href)?.[1] : null;
      const name = clean(row.querySelector('[class*="username"], [class*="name"], b, strong')?.textContent);

      found++;
      send({
        type: 'message',
        from: name || user || 'Unknown buyer',
        fromUser: user,
        text: txt,
        url: inboxLink(user)
      });
    });

    dbg('scrape-inbox', { reason, rowsScanned: rows.length, unreadFound: found });

    if (!found && lastCount > 0) {
      send({
        type: 'alert',
        from: 'Fiverr',
        text: `You have ${lastCount} unread item(s) — open your Fiverr inbox.`,
        url: 'https://www.fiverr.com/inbox',
        noDedupe: true               // same words every time — must never be deduped
      });
    }
  }

  /* ------------------------------- signal 4: NOTIFICATIONS + BRIEFS
     Briefs never touch the inbox — they only ever appear in the notifications
     panel, which is why they were being missed entirely. This reads the
     notification list wherever it is rendered: the bell dropdown, or the
     /notifications page. Each row's own link is used, so alerts point at the
     right place instead of whatever page happened to be open. */

  const BRIEF_RE = /\bbrief\b|matching brief|new brief|buyer request/i;

  /* Fiverr's system notifications carry no sender — they're from Fiverr itself.
     Matching them by their wording is far more reliable than guessing at
     obfuscated CSS class names, and it lets the data path recognise them even
     when the dropdown isn't open. Taken from real notification text. */
  const NOTIF_PATTERNS = [
    /you have a new order/i,
    /new order and instructions/i,
    /awaiting buyer requirements/i,
    /order (is )?(delivered|completed|cancelled|late|revised)/i,
    /delivered your order/i,
    /left (you )?a \d+ star review/i,
    /left a review/i,
    /you have a new message/i,
    /sent you a custom offer/i,
    /accepted your offer/i,
    /placed an order/i,
    /requested a (revision|modification)/i,
    /extended the delivery/i,
    /cancelled the order/i,
    /new brief|matching brief|buyer request/i,
    /you('ve| have) earned|congratulations.*level/i,
    /get started\b/i
  ];
  const looksLikeNotification = t => NOTIF_PATTERNS.some(r => r.test(t));

  function classify(text) {
    if (/order|buyer requirements|custom offer|revision/i.test(text)) return 'order';
    if (BRIEF_RE.test(text)) return 'brief';
    if (/review/i.test(text)) return 'review';
    return 'notification';
  }

  function notificationRoots() {
    return document.querySelectorAll(
      '[class*="notification-list"], [class*="notifications-list"], [class*="notification-item"],' +
      '[data-testid*="notification"], [class*="notification"] ul, [class*="notification"] [role="list"]'
    );
  }

  function scrapeNotifications(reason) {
    const onNotifPage = /\/notifications/i.test(location.pathname);
    const roots = notificationRoots();
    if (!roots.length && !onNotifPage) return;

    const scope = roots.length ? roots : [document];
    const seenHere = new Set();
    let found = 0;

    scope.forEach(root => {
      const items = root.querySelectorAll('li, [role="listitem"], [class*="notification-item"], a[href]');
      items.forEach(item => {
        const raw = clean(item.innerText);
        if (!raw || raw.length < 6 || raw.length > 900) return;
        if (isJunk(raw)) return;
        if (seenHere.has(raw)) return;
        seenHere.add(raw);

        const href = item.getAttribute?.('href')
                  || item.querySelector?.('a[href]')?.getAttribute('href')
                  || item.closest?.('a[href]')?.getAttribute('href');
        const abs = href
          ? (href.startsWith('http') ? href : 'https://www.fiverr.com' + href)
          : null;

        const parsed = parseNotificationRow(raw);
        const isBrief = BRIEF_RE.test(raw);

        found++;
        send({
          type: isBrief ? 'brief' : 'notification',
          from: isBrief ? 'Fiverr Brief' : (parsed.from || 'Fiverr'),
          fromUser: parsed.fromUser,
          text: parsed.text || raw,
          url: abs || (parsed.fromUser ? inboxLink(parsed.fromUser) : location.href)
        });
      });
    });

    dbg('scrape-notifications', { reason, roots: scope.length, found });
  }

  /* ---------------------------------------------------- text-driven sweep
     The class-name selectors above are a guess at Fiverr's markup, and Fiverr
     obfuscates its classes. This finds notifications by their WORDING instead:
     walk the text, match the known phrasings, then climb to the smallest
     enclosing row. Works on the bell dropdown, the notifications page, and any
     future markup Fiverr ships. Reading the DOM is not a request to Fiverr. */

  /* Fiverr bolds words inside notification sentences:
   *   You have a new <b>order</b> and instructions from <b>samuellad</b>. Get started.
   * so the page holds that as five separate text fragments and NO single one
   * matches a whole-sentence pattern. Testing text nodes directly finds nothing.
   *
   * Two stages instead:
   *   1. cheap scan for an anchor WORD ("order", "brief", "review"…)
   *   2. climb from there to the smallest element whose full text reads like a
   *      notification, and test that.
   */
  const ANCHOR_RE = /\b(order|orders|brief|briefs|review|reviews|message|offer|requirements|started|delivered|revision|cancelled|completed)\b/i;

  /* Every row in the panel carries its age — "now", "1m", "5h", "2d". Without
   * reading it, the first sweep would alert on the ENTIRE notification history,
   * which is worse than missing one. Anything older than the cutoff is treated
   * as already-seen and skipped silently.
   *
   * Returns age in minutes, or null when there's no timestamp to read (in which
   * case we allow it — missing a real alert costs more than one stale ping). */
  function rowAgeMins(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(just now|now)\b/.test(t)) return 0;
    if (/\byesterday\b/.test(t)) return 60 * 24;

    // Compact form Fiverr uses: 3m, 2h, 1d, 4w
    let m = /(?:^|\s)(\d{1,3})\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)(?:\s|$|\.)/.exec(t);
    if (!m) {
      // Long form: "2 hours ago"
      m = /(\d{1,3})\s*(minute|hour|day|week)s?\s+ago/.exec(t);
    }
    if (!m) return null;

    const n = +m[1];
    const unit = m[2][0];
    if (unit === 'm') return n;
    if (unit === 'h') return n * 60;
    if (unit === 'd') return n * 60 * 24;
    if (unit === 'w') return n * 60 * 24 * 7;
    return null;
  }

  let maxNotifAgeMins = 60;
  chrome.storage.local.get({ maxNotifAgeMins: 60 }).then(c => { maxNotifAgeMins = c.maxNotifAgeMins; });
  chrome.storage.onChanged.addListener(ch => {
    if (ch.maxNotifAgeMins) maxNotifAgeMins = ch.maxNotifAgeMins.newValue;
  });

  function rowFor(node) {
    let el = node.parentElement;
    // First ancestor whose COMBINED text reads like a notification wins — that's
    // the row itself. Going further up starts swallowing neighbouring rows.
    for (let i = 0; el && i < 8; i++, el = el.parentElement) {
      const t = clean(el.innerText);
      if (!t) continue;
      if (t.length > 700) break;                 // now a container, not a row
      if (t.length >= 12 && looksLikeNotification(t)) return el;
    }
    return null;
  }

  /* Test mode: collect what WOULD be detected, ignoring the age cutoff and
     without sending anything. Lets you prove detection works using yesterday's
     notifications, which is the only way to test it when nothing new has come in. */
  function sweepNotifications(reason, testMode) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const rows = new Map();
    let n, scanned = 0;

    while ((n = walker.nextNode())) {
      const t = (n.data || '').trim();
      if (t.length < 3 || t.length > 300) continue;
      if (!ANCHOR_RE.test(t)) continue;          // stage 1 — cheap
      scanned++;

      const row = rowFor(n);                     // stage 2 — the real test
      if (!row) continue;
      const text = clean(row.innerText);
      if (!text || isJunk(text) || rows.has(text)) continue;

      // Skip a row that merely contains another row we already captured.
      let nested = false;
      rows.forEach((el) => { if (row !== el && row.contains(el)) nested = true; });
      if (nested) continue;

      rows.set(text, row);
    }

    let sent = 0, stale = 0;
    const found = [];

    rows.forEach((row, text) => {
      const age = rowAgeMins(text);
      const old = age !== null && age > maxNotifAgeMins;
      if (old && !testMode) { stale++; return; }

      const href = row.querySelector?.('a[href]')?.getAttribute('href')
                || row.closest?.('a[href]')?.getAttribute('href');
      const abs = href
        ? (href.startsWith('http') ? href : 'https://www.fiverr.com' + href)
        : null;

      // "…from samuellad." / "…from **buyer**" — pull the buyer out when present.
      const who = /\bfrom\s+([A-Za-z0-9_.-]{3,30})\b/i.exec(text)?.[1] || null;

      const evt = {
        type: classify(text),
        from: who || 'Fiverr',
        fromUser: who,
        text,
        url: abs || (who ? inboxLink(who) : 'https://www.fiverr.com/inbox')
      };

      if (testMode) {
        found.push({ type: evt.type, from: evt.from, text: text.slice(0, 180), age, old });
        return;
      }

      sent++;
      send(evt);
    });

    if (sent || stale || reason === 'poll') {
      dbg('sweep-notifications', { reason, candidates: rows.size, sent, skippedAsOld: stale, cutoffMins: maxNotifAgeMins });
    }
    return found;
  }

  /* ===================================================== reply from Telegram (page side)
   * Runs only when the extension asks for it (the reply feature is off by default).
   * Every step is checked before the next: right account, right conversation, ONE
   * message box, an empty box, the text read back correctly, ONE send button. Anything
   * unclear aborts and says why. A send is never retried, so a message can't go twice. */
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));
  const normSp = s => String(s || '').replace(/\s+/g, ' ').trim();
  const shown = el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 24 && r.height > 12 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  function composerCandidates() {
    const els = [...document.querySelectorAll(
      'textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"], input[type="text"]')];
    return els.filter(shown).map(el => {
      const r = el.getBoundingClientRect();
      const label = [el.getAttribute('placeholder'), el.getAttribute('aria-label'),
                     el.getAttribute('data-placeholder'), el.getAttribute('name')].join(' ').toLowerCase();
      const near = ((el.parentElement && el.parentElement.innerText) || '').toLowerCase().slice(0, 200);
      let score = 0;
      if (/message|type a|write a|reply/.test(label)) score += 10;
      if (/type a message/.test(near)) score += 10;          // placeholder drawn as text beside the box
      if (/search|filter|offer|price|title|email|name/.test(label)) score -= 50;
      if (r.top > innerHeight * 0.5) score += 3;             // the message box sits at the bottom
      return { el, label, score, top: r.top };
    }).sort((a, b) => b.score - a.score || b.top - a.top);
  }
  function findComposer() {
    const c = composerCandidates();
    if (!c.length || c[0].score < 3) return { error: 'I could not find the message box on this page.' };
    if (c[1] && c[1].score === c[0].score && Math.abs(c[1].top - c[0].top) > 4) {
      return { error: 'More than one possible message box on this page, so I stopped rather than guess.' };
    }
    return { el: c[0].el };
  }
  const boxText = el => normSp(el.value !== undefined ? el.value : (el.innerText || el.textContent)).replace(/​/g, '');

  function typeInto(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);   // React ignores a plain .value =
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const sel = getSelection(), range = document.createRange();
    range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
    if (!document.execCommand('insertText', false, text) || !boxText(el)) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }
  function clearBox(el) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const sel = getSelection(), range = document.createRange();
      range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
      document.execCommand('delete');
      if (boxText(el)) { el.textContent = ''; el.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    }
  }

  function findSendButton(box) {
    let node = box;
    for (let i = 0; i < 7 && node; i++, node = node.parentElement) {
      const hits = [...node.querySelectorAll('button, [role="button"]')].filter(b => {
        if (!shown(b)) return false;
        const l = [b.getAttribute('aria-label'), b.getAttribute('title'), b.innerText,
                   b.getAttribute('data-testid')].join(' ').toLowerCase();
        return /\bsend\b/.test(l) && !/offer|attach|file|emoji|quick|schedule|translate/.test(l);
      });
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return 'ambiguous';
    }
    return null;
  }

  function pressEnter(el) {
    const o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }
  const countIn = (hay, needle) => needle ? hay.split(needle).length - 1 : 0;

  async function doReply(job) {
    const acct = refreshAccount();
    if (!acct || acct.toLowerCase() !== String(job.account).toLowerCase()) {
      return { ok: false, error: 'This Fiverr tab is signed in as ' + (acct || 'an unknown account') + ', not ' + job.account + '.' };
    }
    if (!location.pathname.toLowerCase().includes('/inbox/' + String(job.buyer).toLowerCase())) {
      return { ok: false, error: 'The conversation with ' + job.buyer + ' did not open.' };
    }
    let f = {}; const t0 = Date.now();
    while (Date.now() - t0 < 15000) { f = findComposer(); if (f.el) break; await sleepMs(500); }
    if (!f.el) return { ok: false, error: f.error };
    const box = f.el;
    if (boxText(box)) return { ok: false, error: 'There is already an unsent draft in that conversation, so I did not touch it.' };

    const want = normSp(job.text);
    typeInto(box, job.text);
    await sleepMs(400);
    if (boxText(box) !== want) { clearBox(box); return { ok: false, error: 'The text did not go into the box correctly, so nothing was sent.' }; }

    if (job.mode !== 'live') {
      await sleepMs(5000);                 // long enough to see it if you are watching
      clearBox(box);
      return { ok: true, sent: false };
    }

    const probe = want.slice(0, 40);
    const before = countIn(normSp(document.body.innerText), probe);
    const btn = findSendButton(box);
    if (btn === 'ambiguous') { clearBox(box); return { ok: false, error: 'More than one possible Send button, so I stopped rather than guess.' }; }
    if (btn) btn.click(); else pressEnter(box);

    const t1 = Date.now();
    while (Date.now() - t1 < 12000) {
      await sleepMs(400);
      if (!boxText(box) && countIn(normSp(document.body.innerText), probe) > before) return { ok: true, sent: true };
    }
    if (!boxText(box)) return { ok: true, sent: true, unconfirmed: true };
    clearBox(box);
    return { ok: false, error: 'I pressed Send but the message did not go through. It was NOT retried.' };
  }

  function composerReport() {
    const f = findComposer();
    const b = f.el ? findSendButton(f.el) : null;
    return {
      ok: true, account, page: location.pathname,
      message_box: f.el ? 'found' : f.error,
      send_button: b === 'ambiguous' ? 'more than one match' : b ? 'found: ' + normSp(b.getAttribute('aria-label') || b.innerText || 'unlabelled').slice(0, 30) : 'none (it would press Enter)',
      top_candidates: composerCandidates().slice(0, 3).map(c => c.score + ' · ' + (c.label.trim() || '(no label)').slice(0, 40))
    };
  }

  chrome.runtime.onMessage.addListener((m, sender, respond) => {
    if (m.kind === 'fvn-do-reply') { doReply(m).then(respond, e => respond({ ok: false, error: String(e) })); return true; }
    if (m.kind === 'fvn-composer-test') { respond(composerReport()); }
  });

  /* The popup asks the page directly — the content script is the only thing that
     can see the notification panel. */
  chrome.runtime.onMessage.addListener((m, sender, respond) => {
    if (m.kind !== 'fvn-test-scan') return;
    let rows = [];
    try { rows = sweepNotifications('test', true) || []; } catch (e) { /* report empty */ }
    respond({
      ok: true,
      account,
      url: location.href,
      cutoffMins: maxNotifAgeMins,
      bellCount: readBellCount(),     // what the ping system actually watches
      rows
    });
    return true;
  });

  /* ------------------------------------------------ NOTIFICATION BELL
   *
   * Reading the CONTENT of Fiverr's notification panel proved unreliable: rows
   * glue together, the inbox list preview gets mistaken for notifications (and
   * leaks your own "Me:" replies), and old history replays.
   *
   * So notifications are no longer read at all. Instead we watch the bell's
   * unread COUNT. When it goes up, you get one short ping — "you have a new
   * notification, go check" — and you read it on Fiverr yourself. A number can't
   * leak your messages, can't merge rows, and can't replay history.
   *
   * The count is only compared against what we saw earlier in THIS page load, so
   * a reload re-baselines instead of re-alerting on everything already unread.
   * ------------------------------------------------------------------- */

  let bellBaseline = null;          // count at first read; null = not read yet

  /* Finds the bell's badge number. Fiverr's class names are obfuscated, so this
     looks for anything labelled as notifications and reads the bare number in it. */
  function readBellCount() {
    const sel = [
      '[aria-label*="otification" i]',
      '[title*="otification" i]',
      '[data-testid*="otification" i]',
      'a[href*="notification" i]',
      'button[class*="otification" i]',
      '[class*="notification-bell" i]',
      '[class*="notifications-icon" i]'
    ].join(',');

    /* Fiverr HIDES the badge when nothing is unread. So "found the bell, no
       number on it" means 0 — not "no bell". Treating it as "no bell" meant the
       first notification after a quiet spell only set the baseline and never
       pinged. */
    let sawBell = false;

    for (const el of document.querySelectorAll(sel)) {
      sawBell = true;
      // The badge is a leaf node whose whole text is a number: "3", "12", "99+"
      const nodes = [el, ...el.querySelectorAll('*')];
      for (const n of nodes) {
        if (n.children && n.children.length) continue;
        const t = (n.textContent || '').trim();
        if (/^\d{1,3}\+?$/.test(t)) return parseInt(t, 10);
      }
      // Some badges carry the number only in an attribute.
      const attr = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const m = /(\d{1,3})\s*(unread|new)/i.exec(attr);
      if (m) return +m[1];
    }
    // An open panel says "Notifications (2)" in its header.
    for (const el of document.querySelectorAll('h1,h2,h3,h4,header,[role="heading"]')) {
      const m = /^\s*Notifications\s*\((\d{1,3})\)\s*$/i.exec(el.textContent || '');
      if (m) return +m[1];
    }
    return sawBell ? 0 : null;        // bell with no badge = 0; no bell at all = null
  }

  function checkBell(reason) {
    const n = readBellCount();
    if (n === null) return;

    if (bellBaseline === null || Date.now() - bootTime < SETTLE) {
      bellBaseline = n;               // first sight: remember, don't alert
      return;
    }
    if (n > bellBaseline) {
      const added = n - bellBaseline;
      dbg('bell-up', { reason, from: bellBaseline, to: n });
      send({
        type: 'notification',
        from: 'Fiverr',
        noDedupe: true,
        // Timestamped so two separate rises never dedupe into one alert.
        text: `You have ${added} new Fiverr notification${added > 1 ? 's' : ''} ` +
              `(${n} unread). Open the bell on Fiverr to see ${added > 1 ? 'them' : 'it'}. ` +
              `[${new Date().toLocaleTimeString()}]`,
        url: account
          ? `https://www.fiverr.com/users/${account}/seller_dashboard`
          : 'https://www.fiverr.com'
      });
    }
    bellBaseline = n;                 // also tracks drops, when you read them
  }

  setInterval(() => checkBell('poll'), 4000);
  setTimeout(() => checkBell('initial'), SETTLE + 500);

  // New message bubbles inside an open thread are still read — that path has a
  // real sender attached, so it can't be confused with your own replies.
  new MutationObserver((muts) => {
    if (Date.now() - bootTime < SETTLE) return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const cls = (n.className || '') + '';

        // New message bubble inside an open thread.
        if (/message|bubble|chat-item|thread-item/i.test(cls)) {
          // A single new message is ONE bubble. A node holding several is the whole thread being drawn.
          if (n.querySelectorAll('[class*="message"],[class*="bubble"],[class*="chat-item"]').length > 2) { dbg('skipped-thread-container', { cls: cls.slice(0, 80) }); continue; }
          const sender = bubbleSender(n);
          const text = clean(n.innerText);
          dbg('bubble', { cls: cls.slice(0, 120), sender, text: text.slice(0, 160) });
          send({
            type: 'message',
            from: sender,
            fromUser: threadPartner(),
            text: stripSender(text, sender),
            url: inboxLink(threadPartner())
          });
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // (The old panel-content scraper no longer runs on its own. It survives only
  //  behind the popup's Test button, which reads and reports but never sends.)

  /* --------------------------------------------------------------- helpers */

  function bubbleSender(node) {
    const el = node.querySelector?.('[class*="username"], [class*="sender"], strong, b, h3, h4');
    let s = clean(el?.textContent);
    if (!s) s = clean(node.innerText).split('\n')[0];
    if (!s || s.length > 60) return null;
    return s;
  }

  function threadPartner() {
    const m = /\/inbox\/([A-Za-z0-9_.-]+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  function stripSender(text, sender) {
    if (!sender) return text;
    return text.startsWith(sender) ? (text.slice(sender.length).trim() || text) : text;
  }

  /* -------------------------------------------------------------- liveness */

  /* Only check in once we know WHICH account this tab is. A heartbeat under a
     placeholder name creates a phantom account in the watchdog that goes
     "offline" forever and can never come back. */
  const ping = () => {
    refreshAccount();
    if (!account) return;
    chrome.runtime.sendMessage({ kind: 'fvn-alive', account }).catch(() => {});
  };
  ping();
  setInterval(ping, 60000);
})();
