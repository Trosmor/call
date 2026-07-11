// Minimal offline shell cache — personal app, no need for anything fancier.
const CACHE_NAME = "colorize-shell-v5";
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
  // Never cache API calls — always hit the network for Claude.
  if (event.request.url.includes("api.anthropic.com")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
