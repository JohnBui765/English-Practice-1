// Offline support. The precache list and VERSION are rewritten by
// `node tools/update-sw.mjs` — run it after changing any app file so installed
// apps pick up the new version.
const VERSION = '78706b6d6c';
const PRECACHE = [
  './',
  'css/app.css',
  'css/screens/families.css',
  'css/screens/import.css',
  'css/screens/list-detail.css',
  'css/screens/lists.css',
  'css/screens/mode-cloze.css',
  'css/screens/mode-dictation.css',
  'css/screens/mode-family.css',
  'css/screens/mode-flashcard.css',
  'css/screens/mode-formation.css',
  'css/screens/mode-meaning.css',
  'css/screens/practice.css',
  'css/screens/sentences.css',
  'css/screens/settings.css',
  'css/screens/today.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon.svg',
  'icons/maskable-512.png',
  'index.html',
  'js/app.js',
  'js/core/cloze.js',
  'js/core/families.js',
  'js/core/grade.js',
  'js/core/json.js',
  'js/core/parse.js',
  'js/core/srs.js',
  'js/core/text.js',
  'js/core/util.js',
  'js/data/db.js',
  'js/data/sample.js',
  'js/data/store.js',
  'js/screens/families.js',
  'js/screens/import.js',
  'js/screens/index.js',
  'js/screens/list-detail.js',
  'js/screens/lists.js',
  'js/screens/practice/cloze.js',
  'js/screens/practice/dictation.js',
  'js/screens/practice/family.js',
  'js/screens/practice/flashcard.js',
  'js/screens/practice/formation.js',
  'js/screens/practice/meaning.js',
  'js/screens/practice/practice.js',
  'js/screens/practice/results.js',
  'js/screens/practice/session.js',
  'js/screens/sentences.js',
  'js/screens/settings.js',
  'js/screens/today.js',
  'js/ui/clipboard.js',
  'js/ui/components.js',
  'js/ui/dom.js',
  'js/ui/icons.js',
  'js/ui/router.js',
  'js/ui/speech.js',
  'js/ui/viewport.js',
  'manifest.webmanifest',
];

const CACHE = `vocab-studio-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('vocab-studio-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // App navigations always get the cached shell (works offline).
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = (await cache.match('index.html')) || (await cache.match('./'));
        if (cached) return cached;
        return fetch(request);
      })(),
    );
    return;
  }

  // Static files: cache first, then network (and remember the response).
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') cache.put(request, response.clone());
        return response;
      } catch (err) {
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }
    })(),
  );
});
