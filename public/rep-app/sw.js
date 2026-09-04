var CACHE = 'lmb-orders-v5';
var ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'assets/css/app.css',
  'assets/js/config.js',
  'assets/js/products.js',
  'assets/js/marketing-materials.js',
  'assets/js/customers.js',
  'assets/js/app.js',
  'assets/img/cantinesca.png',
  'assets/img/sunlight-groove.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/brand/logo-alt.svg',
  'assets/icons/brand/logo-lmc.svg',
  'assets/icons/brand/logo-lmc-light.svg',
  'assets/fonts/Bogart-Semibold.woff',
  'assets/fonts/BoweryLane-Medium.woff',
  'assets/fonts/Produkt-Regular.woff',
  'assets/fonts/TomatoGrotesk-Medium.woff',
  'assets/fonts/TomatoGrotesk-Regular.woff'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Network-first: always try the live server so deploys show up immediately.
// Only fall back to the cache when the network is unavailable (offline).
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return; // never cache POSTs to Apps Script
  e.respondWith(
    fetch(e.request).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      return res;
    }).catch(function () {
      return caches.match(e.request);
    })
  );
});
