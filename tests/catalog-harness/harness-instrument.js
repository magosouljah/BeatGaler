// T02 / V01-B — Contadores del navegador inyectados SOLO en el build del harness (no en producto).
// fetch, listeners, timers, observers, blob URLs y montaje/desmontaje de BeatCards.
(function () {
  if (window.__catalogHarness) return;
  var c = { fetch: {}, listenersAdded: 0, listenersRemoved: 0, timeouts: 0, timeoutsCleared: 0, intervals: 0, intervalsCleared: 0,
    observers: {}, observersDisconnected: 0, blobCreated: 0, blobRevoked: 0, cardsMounted: 0, cardsUnmounted: 0 };
  window.__catalogHarness = c;
  var of = window.fetch;
  window.fetch = function (input, init) {
    try { var u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href); var k = u.host + u.pathname.replace(/\/__catalog\/fixtures\/.*/, '/__catalog/fixtures/:id'); c.fetch[k] = (c.fetch[k] || 0) + 1; } catch (e) { c.fetch['?'] = (c.fetch['?'] || 0) + 1; }
    return of.apply(this, arguments);
  };
  var ael = EventTarget.prototype.addEventListener, rel = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function () { c.listenersAdded++; return ael.apply(this, arguments); };
  EventTarget.prototype.removeEventListener = function () { c.listenersRemoved++; return rel.apply(this, arguments); };
  var st = window.setTimeout, ct = window.clearTimeout, si = window.setInterval, ci = window.clearInterval;
  window.setTimeout = function () { c.timeouts++; return st.apply(this, arguments); };
  window.clearTimeout = function () { c.timeoutsCleared++; return ct.apply(this, arguments); };
  window.setInterval = function () { c.intervals++; return si.apply(this, arguments); };
  window.clearInterval = function () { c.intervalsCleared++; return ci.apply(this, arguments); };
  var OrigMO = window.MutationObserver; // el observador propio del harness no se cuenta
  ['MutationObserver', 'ResizeObserver', 'IntersectionObserver'].forEach(function (name) {
    var O = window[name]; if (!O) return;
    var W = function (cb, opts) { c.observers[name] = (c.observers[name] || 0) + 1; var o = new O(cb, opts); var d = o.disconnect.bind(o); o.disconnect = function () { c.observersDisconnected++; return d(); }; return o; };
    W.prototype = O.prototype; window[name] = W;
  });
  var cou = URL.createObjectURL, rou = URL.revokeObjectURL;
  URL.createObjectURL = function () { c.blobCreated++; return cou.apply(URL, arguments); };
  URL.revokeObjectURL = function () { c.blobRevoked++; return rou.apply(URL, arguments); };
  var CARD = "[aria-label^='Play '], [aria-label^='Pause ']";
  function walk(nodes, key) { for (var i = 0; i < nodes.length; i++) { var n = nodes[i]; if (n.nodeType !== 1) continue; if (n.matches && n.matches(CARD)) c[key]++; if (n.querySelectorAll) c[key] += n.querySelectorAll(CARD).length; } }
  new OrigMO(function (records) { records.forEach(function (r) { walk(r.addedNodes, 'cardsMounted'); walk(r.removedNodes, 'cardsUnmounted'); }); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
