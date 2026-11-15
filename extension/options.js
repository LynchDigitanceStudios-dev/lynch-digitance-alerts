/* Tabs: Home / Settings / Help — one screen at a time instead of everything stacked. */
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
  document.querySelectorAll('.pane').forEach(p => p.hidden = p.dataset.pane !== t.dataset.tab);
});
const DEFAULTS = {
  enabled: true, channel: 'telegram', waNumber: '', apiKey: '',
  tgToken: '', tgChatId: '', webhookUrl: '',
  accountLabels: {}, maxNotifAgeMins: 60,
  watchdog: true, watchdogMins: 20, heartbeatHours: 8, shareInstall: true,
  privacyMode: false, debugMode: false, desktopNotif: true, quietUntil: 0, maxLen: 500
};

/* Rows are rebuilt only when the set of known accounts actually changes —
   otherwise the 5s refresh would clear whatever you're mid-way through typing. */
let labelKeys = '';

function renderLabels(known, labels) {
  const keys = [...new Set([...known, ...Object.keys(labels)])].sort();
  const sig = keys.join('|');
  if (sig === labelKeys) return;
  if (document.activeElement && document.activeElement.closest('#labels')) return;
  labelKeys = sig;

  if (!keys.length) {
    document.getElementById('labels').innerHTML =
      '<div class="lbl-empty">No accounts seen yet — open a Fiverr tab.</div>';
    return;
  }
  document.getElementById('labels').innerHTML = keys.map(u => `
    <div class="lbl-row">
      <span class="u" title="${u}">${u}</span>
      <input type="text" data-user="${u}" maxlength="40"
             placeholder="e.g. Main account" value="${(labels[u] || '').replace(/"/g, '&quot;')}">
    </div>`).join('');
}

function collectLabels() {
  const out = {};
  document.querySelectorAll('#labels input[data-user]').forEach(i => {
    const v = i.value.trim();
    if (v) out[i.dataset.user] = v;
  });
  return out;
}

function showChannel() {
  const v = channel.value;
  document.getElementById('f-callmebot').style.display = v === 'callmebot' ? '' : 'none';
  document.getElementById('f-telegram').style.display  = v === 'telegram'  ? '' : 'none';
  document.getElementById('f-webhook').style.display   = v === 'webhook'   ? '' : 'none';
}
channel.onchange = showChannel;

/* Fields are populated once, on open. The 5s refresh below only updates the
   status + log — it must never rewrite inputs, or it wipes what you're typing. */
let fieldsLoaded = false;

async function load() {
  const c = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  if (!fieldsLoaded) {
    fieldsLoaded = true;
    enabled.checked = c.enabled;
    desktopNotif.checked = c.desktopNotif;
    privacyMode.checked = c.privacyMode;
    debugMode.checked = c.debugMode;
    maxNotifAgeMins.value = c.maxNotifAgeMins;
    channel.value = c.channel;
    waNumber.value = c.waNumber;
    apiKey.value = c.apiKey;
    tgToken.value = c.tgToken;
    tgChatId.value = c.tgChatId;
    webhookUrl.value = c.webhookUrl;
    maxLen.value = c.maxLen;
    watchdog.checked = c.watchdog;
    shareInstall.checked = c.shareInstall !== false;
    watchdogMins.value = c.watchdogMins;
    heartbeatHours.value = c.heartbeatHours;
    showChannel();
  }

  const { fvnAccounts = {}, fvnLog = [], fvnDebug = [] } =
    await chrome.storage.local.get(['fvnAccounts', 'fvnLog', 'fvnDebug']);
  debugCount.textContent = fvnDebug.length ? `${fvnDebug.length} captured` : '';
  const live = Object.entries(fvnAccounts)
    .filter(([, t]) => Date.now() - t < 5 * 60 * 1000)
    .map(([a]) => a);
  accounts.textContent = live.length
    ? live.map(a => c.accountLabels[a] ? `${c.accountLabels[a]} (${a})` : a).join(', ')
    : 'no Fiverr tab detected';

  renderLabels(Object.keys(fvnAccounts), c.accountLabels || {});

  log.innerHTML = fvnLog.slice(0, 25).map(e =>
    `<div><span class="${e.delivered ? 'ok' : 'bad'}">${e.delivered ? '✓' : '✗'}</span> ` +
    `${new Date(e.ts).toLocaleTimeString()} · ${e.account} · ${e.from}` +
    `${e.reason ? ' <i>(' + e.reason + ')</i>' : ''}</div>`
  ).join('') || '<i>no events yet</i>';
}

/* Tokens get pasted with stray spaces, newlines, or the placeholder word
   "from" in front of them. Strip that before storing. */
const clean = v => v.replace(/\s+/g, ' ').replace(/^from\s+/i, '').trim();

save.onclick = async () => {
  tgToken.value = clean(tgToken.value);
  tgChatId.value = clean(tgChatId.value);
  await chrome.storage.local.set({
    enabled: true,
    desktopNotif: true,
    privacyMode: false,
    debugMode: false,
    channel: channel.value,
    waNumber: waNumber.value.replace(/[^0-9]/g, ''),
    apiKey: apiKey.value.trim(),
    tgToken: clean(tgToken.value),
    tgChatId: clean(tgChatId.value).replace(/[^0-9-]/g, ''),
    webhookUrl: webhookUrl.value.trim(),
    accountLabels: {},
    watchdog: true,
    shareInstall: true,
    watchdogMins: 20,
    heartbeatHours: 8,
    maxLen: Math.max(100, Math.min(2000, +maxLen.value || 500)),
    maxNotifAgeMins: Math.max(5, Math.min(1440, +maxNotifAgeMins.value || 60)),
  });
  save.textContent = 'Saved';
  setTimeout(() => (save.textContent = 'Save'), 1200);
};

debugMode.onchange = () => chrome.storage.local.set({ debugMode: debugMode.checked });

/* ------------------------------------------------------- unread since check
   Opening this popup is what marks alerts seen. We grab the snapshot first and
   keep it on screen for this popup session, so the numbers are actually
   readable rather than vanishing the instant you look at them. */
async function renderUnseen() {
  const r = await chrome.runtime.sendMessage({ kind: 'fvn-mark-seen' });
  const snap = (r && r.snapshot) || {};
  const entries = Object.entries(snap).filter(([, n]) => n > 0);
  if (!entries.length) { unseen.style.display = 'none'; return; }

  const { accountLabels = {} } = await chrome.storage.local.get('accountLabels');
  const total = entries.reduce((a, [, n]) => a + n, 0);

  unseen.innerHTML =
    `<div class="h">${total} new since you last checked</div>` +
    entries.sort((a, b) => b[1] - a[1]).map(([u, n]) =>
      `<div class="r"><span>${accountLabels[u] || u}</span><b>${n}</b></div>`
    ).join('') +
    `<div class="f">Cleared — the toolbar badge is reset.</div>`;
  unseen.style.display = 'block';
}

/* ------------------------------------------------------------- diagnostics
   Each finding can carry a one-click fix, so the user isn't told what's wrong
   and then left to work out where the control is. */
const DX_ACTIONS = {
  enable:     { label: 'Turn alerts on',      run: async () => { enabled.checked = true; await save.onclick(); } },
  unmute:     { label: 'Unmute now',          run: async () => { await chrome.storage.local.set({ quietUntil: 0 }); } },
  detect:     { label: 'Detect chat ID',      run: async () => detect.onclick() },
  test:       { label: 'Send test again',     run: async () => test.onclick() },
  purge:      { label: 'Clean it up',         run: async () => chrome.runtime.sendMessage({ kind: 'fvn-purge' }) },
  nodebug:    { label: 'Turn debug off',      run: async () => { debugMode.checked = false; debugMode.onchange(); } },
  openfiverr: { label: 'Open Fiverr inbox',   run: async () => chrome.tabs.create({ url: 'https://www.fiverr.com/inbox' }) }
};

async function runDiagnose() {
  dx.innerHTML = '<div class="dx-head">Checking…</div>';
  const r = await chrome.runtime.sendMessage({ kind: 'fvn-diagnose' });
  if (!r || !r.ok) { dx.innerHTML = '<div class="dx-i fail"><div class="t">Check failed</div></div>'; return; }

  const order = { fail: 0, warn: 1, ok: 2 };
  const items = r.results.sort((a, b) => order[a.level] - order[b.level]);
  const bad = items.filter(i => i.level !== 'ok').length;

  dx.innerHTML =
    `<div class="dx-head">${bad ? bad + ' issue' + (bad > 1 ? 's' : '') + ' found' : 'No problems found'} · v${r.version}</div>` +
    items.map((i, n) => `
      <div class="dx-i ${i.level}">
        <div class="t">${i.title}</div>
        <div class="d">${i.detail}</div>
        ${i.action && DX_ACTIONS[i.action]
          ? `<button class="sec-btn" data-dx="${n}">${DX_ACTIONS[i.action].label}</button>` : ''}
      </div>`).join('');

  dx.querySelectorAll('button[data-dx]').forEach(btn => {
    btn.onclick = async () => {
      const item = items[+btn.dataset.dx];
      btn.textContent = 'Working…';
      try { await DX_ACTIONS[item.action].run(); } catch {}
      setTimeout(runDiagnose, 900);
    };
  });
}

diagnose.onclick = runDiagnose;

/* ---------------------------------------------------------------- account */
async function renderAcct() {
  const { acctToken, acctEmail: who } = await chrome.storage.local.get(['acctToken', 'acctEmail']);
  acctIn.style.display = acctToken ? 'block' : 'none';
  acctOut.style.display = acctToken ? 'none' : 'block';
  acctWho.textContent = who || '';
}
// Redraw the fields from storage IN PLACE. A page reload used to throw you back to the Home tab.
async function refreshFields() { fieldsLoaded = false; await load(); await renderAcct(); }

async function acctDo(op, extra) {
  acctMsg.textContent = 'Working…';
  const r = await chrome.runtime.sendMessage({ kind: 'fvn-acct', op, ...extra });
  acctMsg.textContent = r?.ok ? '' : (r?.error || 'Something went wrong.');
  await renderAcct();
  if (r?.ok && op === 'login') await refreshFields();
  return r;
}
acctLogin.onclick = () => acctDo('login', { email: acctEmail.value, password: acctPass.value });
acctRegister.onclick = () => acctDo('register', { email: acctEmail.value, password: acctPass.value });
acctLogout.onclick = () => acctDo('logout');
acctSync.onclick = async () => {
  acctMsg.textContent = 'Syncing…';
  await save.onclick();      // what you've typed isn't stored until it's saved, so save it first
  const r = await chrome.runtime.sendMessage({ kind: 'fvn-acct', op: 'sync' });
  if (r?.ok && r.changed) await refreshFields();
  acctMsg.textContent = !r?.ok ? (r?.error || 'Sync failed.')
    : r.pushed ? 'Synced — your changes are on your account.'
    : r.changed ? 'Synced — pulled the latest from your account.'
    : 'Already up to date.';
};
renderAcct();

/* Sign-up prompt: pops up when not signed in. "Maybe later" hides it for 3 days. */
(async () => {
  const { acctToken, acctPromptLater = 0 } = await chrome.storage.local.get(['acctToken', 'acctPromptLater']);
  if (acctToken || Date.now() < acctPromptLater) return;
  acctModal.hidden = false;
  const go = async op => {
    mMsg.textContent = 'Working…';
    const r = await chrome.runtime.sendMessage({ kind: 'fvn-acct', op, email: mEmail.value, password: mPass.value });
    if (r?.ok) { acctModal.hidden = true; await refreshFields(); }
    else mMsg.textContent = r?.error || 'Something went wrong.';
  };
  mRegister.onclick = () => go('register');
  mLogin.onclick = () => go('login');
  mLater.onclick = async () => {
    acctModal.hidden = true;
    await chrome.storage.local.set({ acctPromptLater: Date.now() + 3 * 86400e3 });
  };
})();

// Every Save also goes up to the account.
save.addEventListener('click', () => setTimeout(async () => {
  const r = await chrome.runtime.sendMessage({ kind: 'fvn-acct', op: 'sync' });
  if (r?.ok && r.changed) refreshFields();      // another computer changed something: show it
}, 400));

// Opening the popup also syncs, so a change made elsewhere shows up straight away.
(async () => {
  const { acctToken } = await chrome.storage.local.get('acctToken');
  if (!acctToken) return;
  const r = await chrome.runtime.sendMessage({ kind: 'fvn-acct', op: 'sync' });
  if (r?.ok && r.changed && !document.activeElement?.matches?.('input,textarea,select')) refreshFields();
})();


/* Reads whatever is in the notification panel right now, ignoring the age
   cutoff and sending nothing. The only way to verify detection when no new
   notification has arrived — old ones prove it just as well. */
scanTest.onclick = async () => {
  scanTest.textContent = 'Reading…';
  scanOut.innerHTML = '';
  const r = await chrome.runtime.sendMessage({ kind: 'fvn-test-scan' });
  scanTest.textContent = '🔍 Test: read my notifications now';

  if (!r?.ok) {
    scanOut.innerHTML = '<div class="dx-i fail"><div class="t">No Fiverr tab open</div>' +
      '<div class="d">Open fiverr.com and try again.</div></div>';
    return;
  }

  const html = r.results.map(res => {
    if (res.error) {
      return `<div class="dx-i warn"><div class="t">Tab not responding</div>
              <div class="d">${res.url}<br>${res.error}</div></div>`;
    }
    /* The bell count is what actually triggers notification pings now, so it's
       the first thing to confirm. null means the badge couldn't be located. */
    const bell = res.bellCount === null || res.bellCount === undefined
      ? `<div class="dx-i fail"><div class="t">Bell counter NOT found — ${res.account || 'account'}</div>
         <div class="d">Notification pings can't fire until the badge is located.
         Turn on Debug mode and send the dump.</div></div>`
      : `<div class="dx-i ok"><div class="t">Bell counter found — ${res.bellCount} unread</div>
         <div class="d">You'll be pinged whenever this number goes up.</div></div>`;
    if (!res.rows.length) {
      // No panel rows is normal when the panel is closed. It is NOT a failure —
      // pings come from the bell counter above, which works with it closed.
      return bell + `<div class="dx-i"><div class="t">Panel contents: not shown (optional)</div>
              <div class="d">You don't need the panel open for alerts — the bell counter above is
              what triggers them. Opening the bell only lets this test list what's inside it.</div></div>`;
    }
    const live = res.rows.filter(x => !x.old).length;
    return bell + `<div class="dx-i ok">
        <div class="t">${res.rows.length} found — ${res.account || 'account'}</div>
        <div class="d">${live} would alert now · ${res.rows.length - live} too old
        (over ${res.cutoffMins} min)</div>
      </div>` +
      res.rows.map(x => `
        <div class="dx-i ${x.old ? 'warn' : 'ok'}">
          <div class="t">${x.type.toUpperCase()} · from ${x.from}${x.old ? ' · too old' : ''}</div>
          <div class="d">${x.text.replace(/</g, '&lt;')}
          ${x.age === null ? '<br><i>no timestamp found</i>' : `<br><i>${x.age} min ago</i>`}</div>
        </div>`).join('');
  }).join('');

  scanOut.innerHTML = html;
};

/* --------------------------------------------------------- LYNCH AI ASSISTANT
   Questions are sent with a sanitised snapshot of the extension's state — never
   tokens or keys — so the assistant answers from what is actually wrong rather
   than from the user's description of it. */
(function () {
  const history = [];
  let busy = false, pendingImage = null, greeted = false;

  const bubble = (role, content) => {
    const el = document.createElement('div');
    el.className = 'ai-msg ' + role;
    el.textContent = content;
    aiLog.appendChild(el);
    aiLog.scrollTop = aiLog.scrollHeight;
    return el;
  };

  const typing = () => {
    const el = document.createElement('div');
    el.className = 'ai-typing';
    el.innerHTML = '<i></i><i></i><i></i>';
    aiLog.appendChild(el);
    aiLog.scrollTop = aiLog.scrollHeight;
    return el;
  };

  aiOpen.onclick = () => {
    const showing = aiBox.style.display === 'block';
    aiBox.style.display = showing ? 'none' : 'block';
    if (showing) return;
    if (!greeted) {
      greeted = true;
      bubble('bot', "I can see this extension's settings and its recent delivery log. " +
                    'Describe what went wrong, or attach a screenshot.');
    }
    setTimeout(() => aiText.focus(), 60);
  };
  aiClose.onclick = () => { aiBox.style.display = 'none'; };

  aiChips.addEventListener('click', e => {
    if (!e.target.classList.contains('ai-chip')) return;
    aiText.value = e.target.textContent;
    ask();
  });

  aiText.addEventListener('input', () => {
    aiText.style.height = 'auto';
    aiText.style.height = Math.min(aiText.scrollHeight, 80) + 'px';
  });
  aiText.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
  });
  aiSend.onclick = ask;

  aiShot.onclick = async () => {
    aiShot.textContent = 'Capturing…';
    const r = await chrome.runtime.sendMessage({ kind: 'fvn-screenshot' });
    if (r?.ok) {
      pendingImage = r.image;
      aiShot.textContent = '📷 Screenshot attached';
      aiShotNote.textContent = 'Sent with your next message.';
    } else {
      aiShot.textContent = '📷 Attach screenshot';
      aiShotNote.textContent = 'Could not capture this tab.';
    }
  };

  /* ---- applying what the assistant decided to change ----------------------
     Every field is validated here, and the confirmation text is OUR wording,
     never the model's, so nothing unchecked reaches the screen. A malformed
     action is skipped rather than thrown, so one bad entry doesn't block the
     rest. Tokens, chat IDs and keys can never be set this way. */
  const ACTION_FENCE = /```lynch-action\s*([\s\S]*?)```/i;
  const num = (v, lo, hi) => (Number.isFinite(+v) && +v >= lo && +v <= hi ? +v : null);

  // Hides everything from the first ``` onward, so raw JSON never shows.
  function stripFence(text) {
    const at = text.indexOf('```');
    return at === -1 ? text : text.slice(0, at).trimEnd();
  }

  function parseActions(text) {
    const m = text.match(ACTION_FENCE);
    if (!m) return [];
    try { const d = JSON.parse(m[1]); return Array.isArray(d) ? d : [d]; }
    catch { return []; }
  }

  async function applyOne(a) {
    if (!a || typeof a !== 'object' || typeof a.type !== 'string') return null;
    const bool = typeof a.value === 'boolean' ? a.value : null;

    switch (a.type) {
      case 'set_enabled':
        if (bool === null) return null;
        enabled.checked = bool;
        await chrome.storage.local.set({ enabled: bool });
        return bool ? 'Alerts turned on.' : 'Alerts turned off.';

      case 'set_privacy':
        if (bool === null) return null;
        privacyMode.checked = bool;
        await chrome.storage.local.set({ privacyMode: bool });
        return 'Privacy mode ' + (bool ? 'on' : 'off') + '.';

      case 'set_debug':
        if (bool === null) return null;
        debugMode.checked = bool;
        await chrome.storage.local.set({ debugMode: bool });
        return 'Debug mode ' + (bool ? 'on' : 'off') + '.';

      case 'set_desktop_notif':
        if (bool === null) return null;
        desktopNotif.checked = bool;
        await chrome.storage.local.set({ desktopNotif: bool });
        return 'Desktop notifications ' + (bool ? 'on' : 'off') + '.';

      case 'set_watchdog':
        if (bool === null) return null;
        await chrome.storage.local.set({ watchdog: bool });
        return 'Offline warnings ' + (bool ? 'on' : 'off') + '.';

      case 'mute': {
        const h = num(a.hours, 1, 24);
        if (h === null) return null;
        await chrome.storage.local.set({ quietUntil: Date.now() + h * 3600e3 });
        return 'Muted for ' + h + ' hour' + (h > 1 ? 's' : '') + '.';
      }

      case 'unmute':
        await chrome.storage.local.set({ quietUntil: 0 });
        return 'Unmuted.';

      case 'set_account_label': {
        const u = String(a.username || '').trim();
        const l = String(a.label || '').trim().slice(0, 40);
        if (!/^[A-Za-z0-9_.-]{3,40}$/.test(u) || !l) return null;
        const { accountLabels = {} } = await chrome.storage.local.get('accountLabels');
        accountLabels[u] = l;
        await chrome.storage.local.set({ accountLabels });
        labelKeys = '';                         // force the label rows to redraw
        return 'Named ' + u + ' "' + l + '".';
      }

      case 'set_max_len': {
        const n = num(a.chars, 100, 2000);
        if (n === null) return null;
        maxLen.value = n;
        await chrome.storage.local.set({ maxLen: n });
        return 'Alerts now show up to ' + n + ' characters.';
      }

      case 'set_notif_age': {
        const n = num(a.minutes, 5, 1440);
        if (n === null) return null;
        maxNotifAgeMins.value = n;
        await chrome.storage.local.set({ maxNotifAgeMins: n });
        return 'Ignoring notifications older than ' + n + ' minutes.';
      }

      case 'purge_phantoms': {
        const r = await chrome.runtime.sendMessage({ kind: 'fvn-purge' });
        return r?.removed
          ? 'Cleaned up ' + r.removed + ' leftover account entr' + (r.removed > 1 ? 'ies' : 'y') + '.'
          : 'Nothing left to clean up.';
      }

      case 'send_test': {
        const r = await chrome.runtime.sendMessage({ kind: 'fvn-test' });
        return r?.ok ? 'Sent a test alert.' : 'Test failed: ' + (r?.reason || 'unknown');
      }

      case 'check_update': {
        const r = await chrome.runtime.sendMessage({ kind: 'fvn-check-update' });
        await renderUpdate();
        return r?.available ? 'Update available: v' + r.version + '.' : "You're on the latest version.";
      }

      default:
        return null;
    }
  }

  async function applyActions(text) {
    const acts = parseActions(text).slice(0, 8);
    const done = [];
    for (const a of acts) {
      try { const s = await applyOne(a); if (s) done.push(s); } catch {}
    }
    if (done.length) { await refreshFields(); chrome.runtime.sendMessage({ kind: 'fvn-acct', op: 'sync' }); }
    return done;
  }

  async function ask() {
    const q = aiText.value.trim();
    if (!q || busy) return;

    busy = true;
    aiSend.disabled = true;
    aiText.value = '';
    aiText.style.height = 'auto';
    aiChips.style.display = 'none';

    bubble('me', pendingImage ? q + '  [screenshot attached]' : q);
    history.push({ role: 'user', content: q });
    const dots = typing();

    const image = pendingImage;
    pendingImage = null;
    aiShot.textContent = '📷 Attach screenshot';
    aiShotNote.textContent = '';

    const r = await chrome.runtime.sendMessage({ kind: 'fvn-ai', messages: history, image });
    dots.remove();

    const full = r?.reply || 'No response.';
    // The action block is hidden from the chat — the user sees the sentence,
    // not the JSON behind it.
    bubble(r?.ok ? 'bot' : 'err', (r?.ok ? stripFence(full) : full) || 'Done.');

    if (r?.ok) {
      history.push({ role: 'assistant', content: full });
      const done = await applyActions(full);
      if (done.length) {
        const el = bubble('bot', '✓ ' + done.join(' '));
        el.style.borderColor = 'var(--gold)';
        el.style.color = 'var(--gold)';
      }
    }

    busy = false;
    aiSend.disabled = false;
    aiText.focus();
  }
})();

/* ---------------------------------------------------------------- updates */
async function renderUpdate() {
  const local = chrome.runtime.getManifest().version;
  const { fvnUpdate = {} } = await chrome.storage.local.get('fvnUpdate');
  verLine.textContent = 'Installed version ' + local;

  if (fvnUpdate.available && fvnUpdate.version) {
    upVer.textContent = fvnUpdate.version;
    upVer2.textContent = fvnUpdate.version;
    upNotes.textContent = fvnUpdate.notes || '';
    upLink.href = fvnUpdate.url || '#';
    // "Full instructions" and the site link both derive from the URL the
    // release advertised, so they follow the site if it ever moves.
    try {
      const origin = new URL(fvnUpdate.url).origin;
      upHelp.href = origin + '/#updates';
      siteLink.href = origin;
    } catch {
      upHelp.style.display = 'none';
    }
    updateBanner.style.display = 'block';
  } else {
    updateBanner.style.display = 'none';
  }
}

/* One click puts the zip in Downloads — no browser tab, no right-click-save.
   Chrome won't let an extension replace its own files, so step 2 stays manual,
   but the reload button removes the trip to chrome://extensions. */
upGet.onclick = async () => {
  upGet.textContent = 'Downloading…';
  const r = await chrome.runtime.sendMessage({ kind: 'fvn-download-update' });
  upGet.textContent = r?.ok ? 'Saved to Downloads ✓' : 'Failed — use the link below';
  setTimeout(() => {
    const { fvnUpdate } = { fvnUpdate: null };
    upGet.innerHTML = '1 · Download v<span id="upVer2">' + (upVer.textContent || '') + '</span>';
  }, 5000);
};

upReload.onclick = async () => {
  upReload.textContent = 'Reloading…';
  await chrome.runtime.sendMessage({ kind: 'fvn-reload-extension' });
};

checkUp.onclick = async () => {
  checkUp.textContent = 'Checking…';
  const r = await chrome.runtime.sendMessage({ kind: 'fvn-check-update' });
  await renderUpdate();
  checkUp.textContent = r?.ok
    ? (r.available ? 'Update found!' : "You're up to date")
    : 'Check failed';
  setTimeout(() => (checkUp.textContent = 'Check for update'), 3500);
};

copyDebug.onclick = async () => {
  const { fvnDebug = [] } = await chrome.storage.local.get('fvnDebug');
  await navigator.clipboard.writeText(JSON.stringify(fvnDebug, null, 2));
  copyDebug.textContent = `Copied ${fvnDebug.length}`;
  setTimeout(() => (copyDebug.textContent = 'Copy debug data'), 2500);
};

clearDebug.onclick = async () => {
  await chrome.storage.local.set({ fvnDebug: [] });
  clearDebug.textContent = 'Cleared';
  setTimeout(() => (clearDebug.textContent = 'Clear'), 1500);
};

detect.onclick = async () => {
  detect.textContent = 'Detecting…';
  const r = await chrome.runtime.sendMessage({ kind: 'fvn-tg-detect' });
  if (r?.ok) {
    tgChatId.value = r.chatId;
    detect.textContent = `Found: ${r.name}`;
  } else {
    detect.textContent = 'Failed';
    log.innerHTML = `<div class="bad">${r?.reason || 'unknown'}</div>` + log.innerHTML;
  }
  setTimeout(() => (detect.textContent = 'Detect chat ID'), 6000);
};

test.onclick = async () => {
  test.textContent = 'Sending…';
  const r = await chrome.runtime.sendMessage({ kind: 'fvn-test' });
  test.textContent = r?.ok ? 'Sent ✓' : 'Failed: ' + (r?.reason || '?');
  setTimeout(() => (test.textContent = 'Send test'), 4000);
};

mute.onclick = async () => {
  await chrome.storage.local.set({ quietUntil: Date.now() + 3600e3 });
  mute.textContent = 'Muted 1h';
};

load();
renderUpdate();
renderUnseen();
setInterval(load, 5000);


/* ------------------------------------------------------- reply from Telegram */
(function () {
  const $ = id => document.getElementById(id);
  const USER_OK = u => /^[A-Za-z0-9_.-]{3,40}$/.test(u) && !['unknown', 'unidentified', 'system'].includes(u.toLowerCase());

  async function renderReply() {
    const s = await chrome.storage.local.get({ replyEnabled: false, replyAccounts: {}, replyMode: 'test',
      replyConfirm: true, fvnAccounts: {}, accountLabels: {} });
    $('replyEnabled').checked = s.replyEnabled;
    $('replyBody').style.display = s.replyEnabled ? 'block' : 'none';
    $('replyMode').value = s.replyMode;
    $('replyConfirm').checked = s.replyConfirm;

    const box = $('replyAccts');
    box.textContent = '';
    const users = Object.keys(s.fvnAccounts).filter(USER_OK);
    if (!users.length) {
      const d = document.createElement('div'); d.className = 'lbl-empty';
      d.textContent = 'No accounts seen yet. Open a Fiverr tab.'; box.appendChild(d); return;
    }
    users.forEach(u => {
      const row = document.createElement('div'); row.className = 'row';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'ra_' + u; cb.checked = !!s.replyAccounts[u];
      cb.onchange = async () => {
        const cur = (await chrome.storage.local.get({ replyAccounts: {} })).replyAccounts;
        cur[u] = cb.checked;
        await chrome.storage.local.set({ replyAccounts: cur });
      };
      const lb = document.createElement('label'); lb.htmlFor = cb.id;
      lb.textContent = s.accountLabels[u] ? s.accountLabels[u] + ' (' + u + ')' : u;
      row.append(cb, lb); box.appendChild(row);
    });
  }

  $('replyEnabled').onchange = async () => {
    const on = $('replyEnabled').checked;
    if (on) {
      $('replyMsg').textContent = 'Setting up…';
      const r = await chrome.runtime.sendMessage({ kind: 'fvn-reply-setup' });
      if (!r?.ok) {
        $('replyEnabled').checked = false;
        $('replyMsg').textContent = r?.error || 'Could not turn it on.';
        return;
      }
      $('replyMsg').textContent = 'On. Tick the Fiverr accounts you want below. It starts in test mode, so nothing is sent yet.';
    } else {
      $('replyMsg').textContent = '';
    }
    await chrome.storage.local.set({ replyEnabled: on });
    renderReply();
  };
  $('replyMode').onchange = () => chrome.storage.local.set({ replyMode: $('replyMode').value });
  $('replyConfirm').onchange = () => chrome.storage.local.set({ replyConfirm: $('replyConfirm').checked });

  $('replyCheck').onclick = async () => {
    $('replyMsg').textContent = 'Looking…';
    const r = await chrome.runtime.sendMessage({ kind: 'fvn-reply-composer-test' });
    $('replyMsg').textContent = !r?.ok ? (r?.error || 'No answer.')
      : 'Account: ' + r.account + '\nMessage box: ' + r.message_box + '\nSend button: ' + r.send_button +
        '\nBest matches: ' + (r.top_candidates.join('  |  ') || 'none');
  };

  renderReply();
})();


/* Studio maintenance: while ON the whole page is replaced by the maintenance screen (no home, no settings). */
(function () {
  const scr = document.getElementById('maintScreen');
  if (!scr) return;
  const show = m => {
    const on = !!(m && m.on);
    document.body.classList.toggle('maint', on);
    scr.hidden = !on;
    if (on && m.msg) document.getElementById('maintMsg').textContent = m.msg;
  };
  chrome.storage.local.get('fvnMaint', d => show(d.fvnMaint));
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.fvnMaint) show(ch.fvnMaint.newValue); });
})();
