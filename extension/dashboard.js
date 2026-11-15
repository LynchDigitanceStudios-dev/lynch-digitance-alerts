/* Advanced settings page. Every value saves the moment it changes.
 * Switches and numbers live in one object (fvnAdv); the background worker layers it over its
 * defaults. Delivery fields use the same storage keys the popup uses. */
const $ = id => document.getElementById(id);
const ADV_DEF = { enabled: true, desktopNotif: true, privacyMode: false, watchdog: true,
                  watchdogMins: 20, heartbeatHours: 8, debugMode: false, accountLabels: {} };
const USER_OK = u => /^[A-Za-z0-9_.-]{3,40}$/.test(u) && !['unknown', 'unidentified', 'system'].includes(u.toLowerCase());
let adv = { ...ADV_DEF };
let toastTimer;

function toast() {
  const t = $('toast'); t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 1100);
}

async function saveAdv(patch) {
  adv = { ...adv, ...patch };
  await chrome.storage.local.set({ fvnAdv: adv });
  if ('debugMode' in patch) await chrome.storage.local.set({ debugMode: !!patch.debugMode });   // the page scripts read this key directly
  toast();
}

const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number.isFinite(+v) && v !== '' ? +v : d));

function showChannel(ch) {
  document.querySelectorAll('[data-ch]').forEach(r => { r.style.display = r.dataset.ch === ch ? '' : 'none'; });
}

function bindSwitch(id) { $(id).onchange = () => saveAdv({ [id]: $(id).checked }); }
function bindNumber(id, lo, hi, d) {
  $(id).onchange = () => { const v = clamp($(id).value, lo, hi, d); $(id).value = v; saveAdv({ [id]: v }); };
}

async function renderLabels(seen) {
  const box = $('labels'); box.textContent = '';
  const users = Object.keys(seen || {}).filter(USER_OK);
  if (!users.length) {
    const d = document.createElement('div'); d.className = 'empty';
    d.textContent = 'No Fiverr accounts seen yet. Open a Fiverr tab and one will appear here.';
    box.appendChild(d); return;
  }
  users.forEach(u => {
    const row = document.createElement('div'); row.className = 'row';
    const left = document.createElement('div');
    const b = document.createElement('b'); b.textContent = u; left.appendChild(b);
    const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'wide';
    inp.placeholder = 'Friendly name (optional)'; inp.maxLength = 40; inp.value = (adv.accountLabels || {})[u] || '';
    inp.onchange = () => {
      const labels = { ...(adv.accountLabels || {}) };
      const v = inp.value.trim();
      if (v) labels[u] = v; else delete labels[u];
      saveAdv({ accountLabels: labels });
    };
    row.append(left, inp); box.appendChild(row);
  });
}

async function load() {
  const s = await chrome.storage.local.get(['fvnAdv', 'channel', 'waNumber', 'apiKey', 'webhookUrl',
    'maxNotifAgeMins', 'fvnAccounts', 'fvnDebug']);
  adv = { ...ADV_DEF, ...(s.fvnAdv || {}) };
  ['enabled', 'desktopNotif', 'privacyMode', 'watchdog', 'debugMode'].forEach(id => { $(id).checked = !!adv[id]; bindSwitch(id); });
  $('watchdogMins').value = adv.watchdogMins; bindNumber('watchdogMins', 5, 240, 20);
  $('heartbeatHours').value = adv.heartbeatHours; bindNumber('heartbeatHours', 0, 168, 8);

  const ch = s.channel || 'telegram';
  $('channel').value = ch; showChannel(ch);
  $('channel').onchange = async () => { await chrome.storage.local.set({ channel: $('channel').value }); showChannel($('channel').value); toast(); };
  $('waNumber').value = s.waNumber || '';
  $('apiKey').value = s.apiKey || '';
  $('webhookUrl').value = s.webhookUrl || '';
  $('waNumber').onchange = async () => { $('waNumber').value = $('waNumber').value.replace(/[^0-9]/g, ''); await chrome.storage.local.set({ waNumber: $('waNumber').value }); toast(); };
  $('apiKey').onchange = async () => { await chrome.storage.local.set({ apiKey: $('apiKey').value.trim() }); toast(); };
  $('webhookUrl').onchange = async () => { await chrome.storage.local.set({ webhookUrl: $('webhookUrl').value.trim() }); toast(); };

  $('maxNotifAgeMins').value = s.maxNotifAgeMins || 60;
  $('maxNotifAgeMins').onchange = async () => {
    const v = clamp($('maxNotifAgeMins').value, 5, 1440, 60); $('maxNotifAgeMins').value = v;
    await chrome.storage.local.set({ maxNotifAgeMins: v }); toast();
  };

  await renderLabels(s.fvnAccounts);
  const n = (s.fvnDebug || []).length;
  $('dbgCount').textContent = n ? n + ' captured' : 'Nothing captured';
}

$('copyDbg').onclick = async () => {
  const { fvnDebug = [] } = await chrome.storage.local.get('fvnDebug');
  try { await navigator.clipboard.writeText(JSON.stringify(fvnDebug, null, 2)); $('copyDbg').textContent = 'Copied ' + fvnDebug.length; }
  catch { $('copyDbg').textContent = 'Could not copy'; }
  setTimeout(() => ($('copyDbg').textContent = 'Copy'), 2200);
};
$('clearDbg').onclick = async () => { await chrome.storage.local.set({ fvnDebug: [] }); $('dbgCount').textContent = 'Nothing captured'; toast(); };
$('resetAdv').onclick = async () => {
  if (!confirm('Put every setting on this page back to its default?')) return;
  await chrome.storage.local.remove('fvnAdv');
  await chrome.storage.local.set({ debugMode: false });
  location.reload();
};

const v = chrome.runtime.getManifest().version;
$('ver').textContent = 'v' + v;
$('aboutVer').textContent = 'Version ' + v;

/* highlight the section being read */
const links = [...document.querySelectorAll('nav a')];
const io = new IntersectionObserver(es => {
  es.forEach(e => { if (e.isIntersecting) links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id)); });
}, { rootMargin: '-20% 0px -70% 0px' });
document.querySelectorAll('main section').forEach(s => io.observe(s));

/* Studio maintenance: the whole page is replaced while it is on. */
(function () {
  const scr = $('maintScreen');
  const show = m => {
    const on = !!(m && m.on);
    document.body.classList.toggle('maint', on);
    scr.hidden = !on;
    if (on && m.msg) $('maintMsg').textContent = m.msg;
  };
  chrome.storage.local.get('fvnMaint', d => show(d.fvnMaint));
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.fvnMaint) show(ch.fvnMaint.newValue); });
})();

load();
