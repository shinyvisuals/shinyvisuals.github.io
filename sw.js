/**
 * ShinyVisuals — Service Worker для мгновенной загрузки статики и кэширования
 */
const CACHE_NAME = 'shinyvisuals-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
  './favicon.png',
  './logo.png',
  './twofactor.css?v=2',
  './twofactor.js?v=2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = req.url;

  // Игнорируем запросы к Firebase и не-GET запросы
  if (req.method !== 'GET' || url.includes('firebaseio.com') || url.includes('qrserver.com')) {
    return;
  }

  // Network-first для HTML, Cache-first для тяжёлой статики (JS, CSS, PNG)
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const toCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, toCache));
        }
        return networkResponse;
      });
    })
  );
});
