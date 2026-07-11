// Offline shell cache with a NETWORK-FIRST strategy.
// Cache-first (the previous approach) meant an installed PWA kept serving the old
// version until iOS decided to re-check sw.js — updates appeared to never arrive.
// Network-first serves the freshest files whenever online and only falls back to
// the cache when the network is unreachable, which is the right trade-off for a
// personal app that is usually online.
const CACHE_NAME = "colorize-shell-v7";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/app.js",
  "./js/storage.js",
  "./js/claude.js",
  "./js/calc.js",
  "./js/garmin.js",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Never touch API calls — always hit the network for Claude.
  if (event.request.url.includes("api.anthropic.com")) return;
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Keep the cache fresh so the offline fallback is as recent as possible.
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
