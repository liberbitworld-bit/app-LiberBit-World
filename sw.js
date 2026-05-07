// LiberBit World — Service Worker v1.1
// Estrategia: cache-first para assets estáticos, network-first para index.html
// CACHE_NAME bumpeado a lbw-v2 para invalidar versiones cacheadas de JS
// previas al despliegue de NIP-49 (lbw-passlock.js).

const CACHE_NAME = 'lbw-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/main.css',
  '/js/config.js',
  '/js/nostr.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.json'
];

// Instalar: pre-cachear assets críticos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        // Ignorar errores de assets individuales — no bloquear instalación
        console.warn('[SW] Pre-cache parcial:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activar: limpiar caches viejos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-first para HTML, cache-first para el resto
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Solo interceptar same-origin + https
  if (url.origin !== location.origin) return;

  if (request.destination === 'document') {
    // HTML: network-first (siempre intentar la versión fresca)
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
  } else {
    // Assets (CSS, JS, imágenes): cache-first
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, clone));
          }
          return response;
        });
      })
    );
  }
});
