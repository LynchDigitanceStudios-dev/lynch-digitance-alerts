/*
 * fiverr-hook.js  —  runs in the PAGE world.
 *
 * SAFETY CONTRACT: this file never issues a request to Fiverr. It only reads
 * the responses the Fiverr page was already going to fetch on its own. If you
 * ever feel tempted to add a setInterval that calls a Fiverr endpoint, don't —
 * that is the behaviour that gets accounts flagged.
 */
(() => {
  // Re-injection guard: without this, a manual inject on top of the automatic
  // one would wrap fetch twice and emit every payload twice.
  if (window.__fvn_hooked) return;
  window.__fvn_hooked = true;

  const INTEREST = /(conversation|message|inbox|notification|activity|order)/i;

  function emit(url, text, serverDate) {
    if (!text || text.length > 400000) return;
    let json;
    try { json = JSON.parse(text); } catch { return; }
    window.dispatchEvent(new CustomEvent('__fvn_payload', {
      detail: { url, json, serverDate: serverDate || null }
    }));
  }

  // --- fetch ---------------------------------------------------------------
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';
      if (INTEREST.test(url)) {
        const sd = res.headers.get('date');
        res.clone().text().then(t => emit(url, t, sd)).catch(() => {});
      }
    } catch {}
    return res;
  };

  // --- XMLHttpRequest ------------------------------------------------------
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__fvn_url = url;
    return _open.call(this, method, url, ...rest);
  };
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (this.__fvn_url && INTEREST.test(this.__fvn_url) &&
            typeof this.responseText === 'string') {
          emit(this.__fvn_url, this.responseText, this.getResponseHeader('date'));
        }
      } catch {}
    });
    return _send.apply(this, args);
  };

  // --- WebSocket (Fiverr pushes some live events over ws) ------------------
  const _WS = window.WebSocket;
  if (_WS) {
    window.WebSocket = function (...args) {
      const ws = new _WS(...args);
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string' && ev.data[0] === '{') {
          emit('ws:' + args[0], ev.data);
        }
      });
      return ws;
    };
    window.WebSocket.prototype = _WS.prototype;
    Object.assign(window.WebSocket, _WS);
  }
})();
