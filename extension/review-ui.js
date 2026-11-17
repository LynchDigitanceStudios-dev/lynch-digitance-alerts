/* Lynch Digitance Alerts: the review window, the "what's new" note and the Reviews tab (popup side).
 *
 * Everything the server returns goes into the page with textContent only, never as HTML. This script
 * talks to the background worker (fvn-review-* messages); the popup never holds the account token.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var send = function (m) { return chrome.runtime.sendMessage(m); };
  var LABELS = ['', 'Poor', 'Could be better', 'Okay', 'Good', 'Excellent'];
  var NOTE = [
    'Reply to buyers from Telegram: tap ↩️ Reply under any alert, type, and confirm. Optional, one switch in Settings.',
    'A "Back online" message tells you how many unread messages are waiting after your browser was closed.',
    'Long messages arrive in full, and Settings is much simpler (more under the new Advanced button).',
    'A Reviews tab, so you can tell us how it is working for you.'
  ];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // five stars: n bright ones, the rest dim
  function stars(n) {
    var s = el('span', 'rvstars', '★★★★★'.slice(0, n));
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', n + ' out of 5 stars');
    if (n < 5) s.appendChild(el('i', '', '★★★★★'.slice(0, 5 - n)));
    return s;
  }

  function when(at) {
    try { return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch (e) { return ''; }
  }

  /* ---------- the window ---------- */

  var rating = 0;
  var prompting = false;   // opened by itself (true) or from the Reviews tab (false)
  var hasMine = false;
  var busy = false;
  var lastMine = null;
  var noteShown = false;
  var picks = [].slice.call(document.querySelectorAll('#rvPick button'));

  function paintPick(upTo, hover) {
    picks.forEach(function (b) {
      var v = Number(b.dataset.v);
      b.classList.toggle('on', !hover && v <= upTo);
      b.classList.toggle('hov', !!hover && v <= upTo);
      b.setAttribute('aria-checked', String(!hover && v === upTo));
    });
    $('rvPickLabel').textContent = upTo ? LABELS[upTo] : 'Tap a star';
  }

  function setRating(n) {
    rating = n;
    paintPick(n, false);
    $('rvSubmit').disabled = !n || busy;
  }

  picks.forEach(function (b) {
    b.addEventListener('click', function () { setRating(Number(b.dataset.v)); });
    b.addEventListener('mouseenter', function () { paintPick(Number(b.dataset.v), true); });
  });
  $('rvPick').addEventListener('mouseleave', function () { paintPick(rating, false); });
  $('rvPick').addEventListener('keydown', function (e) {
    var step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    var n = Math.min(5, Math.max(1, (rating || (step > 0 ? 0 : 6)) + step));
    setRating(n);
    picks[n - 1].focus();
  });

  $('rvText').addEventListener('input', function () { $('rvLen').textContent = $('rvText').value.length; });

  function showErr(text) {
    $('rvErr').textContent = text || '';
    $('rvErr').hidden = !text;
  }

  // the "what's new" list, built with textContent
  (function buildNote() {
    var ul = $('rvNoteList');
    NOTE.forEach(function (t) { ul.appendChild(el('li', '', t)); });
  })();

  async function openModal(o) {
    prompting = !!o.prompt;
    var mine = o.mine || null;
    hasMine = !!mine;
    var withNote = !!o.note;
    var withForm = o.form !== false;
    noteShown = withNote;
    var signedIn = o.signedIn;
    if (signedIn === undefined) {
      try { signedIn = !!((await chrome.storage.local.get('acctToken')).acctToken); } catch (e) { signedIn = false; }
    }
    var ver = '';
    try { ver = chrome.runtime.getManifest().version; } catch (e) { /* none */ }
    $('rvNote').hidden = !withNote;
    $('rvNoteTitle').textContent = 'Updated to ' + ver + '. What’s new:';
    $('rvDiv').hidden = !(withNote && withForm);
    $('rvFormBody').hidden = !withForm;
    $('rvGotBtn').hidden = !(withNote && !withForm);

    $('rvTitle').textContent = mine ? 'Your review' : prompting ? 'How is Lynch Digitance Alerts working for you?' : 'Write a review';
    $('rvSub').textContent = mine ? 'You can change it any time.' : 'Your review helps other people decide, and helps us make it better.';
    $('rvText').value = mine && mine.text ? mine.text : '';
    $('rvLen').textContent = $('rvText').value.length;
    $('rvFine').textContent = signedIn
      ? 'Shown publicly in the extension and on our website, with a short name made from your account email. Nothing else is shared.'
      : 'Shown publicly in the extension and on our website as "Alerts user", because you are not signed in. Sign in first and it uses a short name made from your account email. Nothing else is shared.';
    busy = false;
    showErr('');
    $('rvSubmit').textContent = mine ? 'Save changes' : 'Send review';
    setRating(mine ? mine.rating : 0);
    $('rvLinks').hidden = !prompting;
    $('rvCancelRow').hidden = prompting;
    $('rvForm').hidden = false;
    $('rvThanks').hidden = true;
    $('rvModal').hidden = false;
    $('rvBox').focus();
  }

  function closeModal() {
    if (busy) return;
    $('rvModal').hidden = true;
    if (noteShown) {                                  // the note is shown once
      noteShown = false;
      try { send({ kind: 'fvn-note-seen' }); } catch (e) { /* background asleep: it will show again once */ }
    }
  }

  async function submit() {
    if (busy || !rating) return;
    busy = true;
    $('rvSubmit').disabled = true;
    $('rvSubmit').textContent = 'Sending…';
    showErr('');
    var r = null;
    try { r = await send({ kind: 'fvn-review-submit', rating: rating, text: $('rvText').value }); } catch (e) { /* no answer */ }
    busy = false;
    if (!r || !r.ok) {
      showErr((r && r.error) || 'Could not send your review. Try again.');
      $('rvSubmit').textContent = hasMine ? 'Save changes' : 'Send review';
      $('rvSubmit').disabled = !rating;
      return;
    }
    $('rvForm').hidden = true;
    $('rvThanks').hidden = false;
    $('rvThanksText').textContent = (r.created === false ? 'Your review was updated. ' : 'Your review was sent. ') +
      'It shows in the Reviews tab and on our website' + (r.name ? ' as ' + r.name : '') + '.';
    if (!$('paneReviews').hidden) load();
  }

  $('rvSubmit').addEventListener('click', submit);
  $('rvThanksBtn').addEventListener('click', closeModal);
  $('rvCancel').addEventListener('click', closeModal);
  $('rvGotBtn').addEventListener('click', closeModal);
  $('rvLater').addEventListener('click', async function () {
    try { await send({ kind: 'fvn-review-later' }); } catch (e) { /* ignore */ }
    closeModal();
  });
  $('rvNever').addEventListener('click', async function () {
    try { await send({ kind: 'fvn-review-never' }); } catch (e) { /* ignore */ }
    closeModal();
  });
  $('rvModal').addEventListener('click', function (e) { if (e.target === $('rvModal')) closeModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('rvModal').hidden) closeModal();
  });

  /* ---------- the Reviews tab ---------- */

  var seq = 0;

  function say(text) {
    $('rvMsg').textContent = text || '';
    $('rvMsg').hidden = !text;
  }

  function item(r, tag) {
    var box = el('div', 'rvitem');
    var top = el('div', 'rvitem__top');
    top.appendChild(stars(r.rating));
    if (r.at) top.appendChild(el('span', 'rvitem__date', when(r.at)));
    box.appendChild(top);
    var who = el('div', 'rvitem__name', r.name || 'Alerts user');
    if (tag) { who.appendChild(document.createTextNode(' ')); who.appendChild(el('span', 'rvtag', tag)); }
    box.appendChild(who);
    if (r.text) box.appendChild(el('p', 'rvitem__text', r.text));
    return box;
  }

  async function load() {
    var mySeq = ++seq;
    say('');
    $('rvCount').textContent = 'Loading…';
    var r = null;
    try { r = await send({ kind: 'fvn-review-list' }); } catch (e) { /* no answer */ }
    if (mySeq !== seq) return;                         // a newer load is already running
    var list = $('rvList');
    list.textContent = '';
    if (!r || !r.ok) {
      $('rvAvg').textContent = '–';
      $('rvAvgStars').textContent = '';
      $('rvCount').textContent = '';
      say((r && r.error) || "Couldn't load the reviews. Check your connection and try again.");
      return;
    }
    lastMine = r.mine || null;
    $('rvAvg').textContent = r.count ? Number(r.average).toFixed(1) : '–';
    $('rvAvgStars').textContent = '';
    if (r.count) $('rvAvgStars').appendChild(stars(Math.round(r.average)));
    $('rvCount').textContent = r.count ? r.count + (r.count === 1 ? ' review' : ' reviews') : 'No reviews yet';
    $('rvWrite').textContent = lastMine ? 'Edit your review' : 'Write a review';

    // this install's own review comes first and is marked, even if the owner has hidden it from everyone else
    if (lastMine) {
      var mineBox = item({ rating: lastMine.rating, name: lastMine.name, text: lastMine.text }, 'your review');
      mineBox.classList.add('rvitem--mine');
      list.appendChild(mineBox);
    }
    var others = (r.reviews || []).filter(function (x) { return !(lastMine && lastMine.id && x.id === lastMine.id); });
    others.forEach(function (x) { list.appendChild(item(x)); });
    if (!others.length && !lastMine) list.appendChild(el('div', 'rvempty', 'No reviews yet. Be the first to write one.'));
  }

  $('rvWrite').addEventListener('click', function () { openModal({ prompt: false, mine: lastMine, form: true }); });
  var tab = document.querySelector('.tab[data-tab="reviews"]');
  if (tab) tab.addEventListener('click', load);

  /* asked at every popup open: the background says whether it is time (3 days of use, or just updated) */
  async function maybePrompt() {
    var r = null;
    try { r = await send({ kind: 'fvn-review-prompt' }); } catch (e) { /* ignore */ }
    if (r && (r.show || r.note)) openModal({ prompt: true, mine: r.mine, signedIn: r.signedIn, note: r.note, form: r.show });
  }

  window.LynchReviewsUI = { opened: load, maybePrompt: maybePrompt };
  maybePrompt();
})();
