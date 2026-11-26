/* Service worker: приложение работает без интернета после первого открытия.
 * Файлы приложения отдаются из кэша и обновляются в фоне (новая версия — при следующем запуске).
 */
'use strict';

const CACHE = 'lexi-app-v4';
const FONTS = 'lexi-fonts-v1';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/util.js', 'js/platform.js', 'js/db.js', 'js/parsers.js', 'js/dict.js', 'js/cards.js', 'js/notes.js', 'js/speech.js', 'js/reader.js', 'js/app.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/jszip.min.js', 'vendor/mammoth.browser.min.js',
  'dict/en-ru.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // шрифты Google — из кэша, если есть
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== self.location.origin) return; // переводчики и прочие API — напрямую

  e.respondWith(caches.open(CACHE).then(async (c) => {
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const hit = await c.match(key, { ignoreSearch: true });
    const update = fetch(req).then((res) => {
      if (res.ok) c.put(key, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(update); return hit; }
    return (await update) || new Response('Нет соединения', { status: 503 });
  }));
});
