// Offline shell cache with a NETWORK-FIRST strategy.
// Cache-first (the previous approach) meant an installed PWA kept serving the old
// version until iOS decided to re-check sw.js — updates appeared to never arrive.
// Network-first serves the freshest files whenever online and only falls back to
// the cache when the network is unreachable, which is the right trade-off for a
// personal app that is usually online.
const CACHE_NAME = "colorize-shell-v9";
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

// On flaky mobile connections a plain network-first fetch can hang for 10+ seconds
// before failing, making the app feel frozen on open. Race the network against a
// timeout: past the deadline serve the cached copy immediately, while the network
// request keeps running in the background to refresh the cache for next time.
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("fetch", (event) => {
  // Never touch API calls — always hit the network for Claude.
  if (event.request.url.includes("api.anthropic.com")) return;
  if (event.request.method !== "GET") return;

  const networkPromise = fetch(event.request).then((response) => {
    // Keep the cache fresh so the offline fallback is as recent as possible.
    if (response.ok && new URL(event.request.url).origin === self.location.origin) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
    }
    return response;
  });
  // If the cached copy wins the race, the losing network promise would otherwise
  // reject with no handler attached when offline.
  networkPromise.catch(() => {});

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(async () => resolve(await caches.match(event.request)), NETWORK_TIMEOUT_MS);
  });

  event.respondWith(
    Promise.race([networkPromise, timeoutPromise]).then(
      // The timeout resolves undefined when there's no cached copy yet — in that case
      // keep waiting on the network rather than failing the request outright.
      (winner) => winner || networkPromise
    ).catch(() => caches.match(event.request))
  );
});
