// The marketing catalogue, fetched rather than bundled.
//
// WHAT THIS USED TO BE: 31 items transcribed from the Marketing Materials &
// Merch Master Tracker, compiled into this file as a literal. Every correction
// -- a changed supplier, a discontinued sticker, a new sell sheet -- was a
// deploy, so in practice nobody made them, and reps were ordering things that
// had not existed for months.
//
// WHAT IT IS NOW: a thin store over /api/marketing/catalog, which reads the
// catalogue ops maintains at ops.tlmbg.co/marketing/catalog. Edits reach the
// field on the next load.
//
// THE SHAPE is the Field Supply Board's, field for field:
//
//   { id, sku, name, brand, category, type, description,
//     specs, unit, supplier, leadTime, imageUrl }
//
// -- so a rep reads the same words in the app that marketing reads on the
// board. The old tracker's `LM-054` ids are gone; `sku` ("CNT-POS-COAST4") is
// what a request now references, and what a purchase order reconciles against.
//
// OFFLINE. A rep with no signal must still be able to see what he could order
// and stage a request, so the last good catalogue is cached in localStorage
// and served immediately on open, with a background refresh behind it. The
// artwork is under /marketing/ in this app's own origin and is precached by
// the service worker for the same reason -- an <img> that 404s in a cellar is
// worse than no image.
(function () {
  var CACHE_KEY = 'lm_marketing_catalog_v1';
  var API = '/api/marketing/catalog';

  // Mirrors MARKETING_CATEGORIES in lib/marketing/catalog.ts. Held here as a
  // fallback ordering only: the server sends the authoritative list with every
  // response, and this is what groups the cached copy if that response has
  // never arrived on this phone.
  var FALLBACK_CATEGORIES = [
    'Sell Sheets',
    'Apparel & Accessories',
    'Banners & Signage',
    'Table & Event Displays',
    'Draft & On-Premise',
    'Logos & Brand Marks',
    'Photography',
    'Sales Decks',
    'Templates',
    'Other'
  ];

  // Carried over verbatim from the old LM_MARKETING_PURPOSES so a request
  // still reconciles against the marketing calendar's Activity Type
  // vocabulary. The server sends these too; this is the offline fallback.
  var FALLBACK_PURPOSES = [
    'Account Visit',
    'Launch',
    'Sampling',
    'Festival',
    'Giveaway',
    'Promo',
    'Sponsorship',
    'Content Drop',
    'Photo/Video Shoot',
    'Rep Field Kit / Restock',
    'Other'
  ];

  var store = {
    items: [],
    categories: FALLBACK_CATEGORIES.slice(),
    brands: [],
    purposes: FALLBACK_PURPOSES.slice(),
    // null until something has been loaded from anywhere; the form uses this
    // to tell "empty catalogue" apart from "not loaded yet".
    loadedAt: null,
    // true when what is on screen came out of localStorage rather than the
    // network, so the form can say so rather than implying it is current.
    fromCache: false
  };

  function readCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(payload) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch (e) {
      // A full quota is not worth failing a load over -- the catalogue still
      // works for this session, it just will not survive a cold start.
    }
  }

  function adopt(payload, fromCache) {
    if (!payload || !Array.isArray(payload.items)) return false;
    store.items = payload.items;
    store.categories = payload.categories && payload.categories.length ? payload.categories : FALLBACK_CATEGORIES.slice();
    store.brands = payload.brands || [];
    store.purposes = payload.purposes && payload.purposes.length ? payload.purposes : FALLBACK_PURPOSES.slice();
    store.loadedAt = payload.cachedAt || Date.now();
    store.fromCache = !!fromCache;
    return true;
  }

  /**
   * Load the catalogue. Resolves as soon as there is something to render --
   * from cache if there is one -- and refreshes from the network behind it.
   *
   * `onUpdate` fires only when the network copy differs from what was already
   * adopted, so a rep whose catalogue has not changed does not watch the list
   * flicker every time he opens the form.
   */
  function load(token, onUpdate, onError) {
    var cached = readCache();
    var hadCache = adopt(cached, true);

    var network = fetch(API, {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      cache: 'no-store'
    })
      .then(function (r) {
        if (!r.ok) {
          // The status rides on the error: a 401 means this device needs to
          // reconnect and the caller can offer that, where any other failure
          // is just "no signal".
          var err = new Error('catalog ' + r.status);
          err.status = r.status;
          throw err;
        }
        return r.json();
      })
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || 'catalog unavailable');
        var changed = !cached || cached.version !== res.version;
        res.cachedAt = Date.now();
        adopt(res, false);
        writeCache(res);
        if (changed && typeof onUpdate === 'function') onUpdate(store);
        return store;
      })
      .catch(function (err) {
        // Offline with a cache is a normal state in this app, not an error --
        // except for a 401, which a cache cannot paper over: the rep could
        // browse a stale catalogue and then fail at submit.
        if (hadCache && err && err.status !== 401) return store;
        throw err;
      });

    // With a cache in hand the caller is resolved immediately, so a failure on
    // the background refresh would otherwise be an unhandled rejection that
    // never reaches anyone -- and a 401 there is exactly the case the caller
    // most needs to hear about (stale catalogue on screen, dead token behind
    // it). Hand it to onError instead of dropping it.
    if (hadCache) {
      network.catch(function (err) { if (typeof onError === 'function') onError(err); });
      return Promise.resolve(store);
    }
    return network;
  }

  function byCategory() {
    var order = {};
    store.categories.forEach(function (c, i) { order[c] = i; });
    var groups = {};
    store.items.forEach(function (item) {
      if (!groups[item.category]) groups[item.category] = [];
      groups[item.category].push(item);
    });
    return Object.keys(groups)
      .sort(function (a, b) {
        var ra = order[a] === undefined ? 999 : order[a];
        var rb = order[b] === undefined ? 999 : order[b];
        return ra - rb || a.localeCompare(b);
      })
      .map(function (name) { return { name: name, items: groups[name] }; });
  }

  function bySku(sku) {
    for (var i = 0; i < store.items.length; i++) {
      if (store.items[i].sku === sku) return store.items[i];
    }
    return null;
  }

  window.LM_MARKETING = {
    load: load,
    state: store,
    byCategory: byCategory,
    bySku: bySku
  };
})();
