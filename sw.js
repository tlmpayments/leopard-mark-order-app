var CACHE = 'lmb-orders-v1';
var ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'assets/css/app.css',
  'assets/js/config.js',
  'assets/js/products.js',
  'assets/js/customers.js',
  'assets/js/app.js',
  'assets/img/cantinesca.png',
  'assets/img/sunlight-groove.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return; // never cache POSTs to Apps Script
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return cached || fetch(e.request).catch(function () { return cached; });
    })
  );
});
