// Reads the static data/garmin.json produced daily by .github/workflows/garmin-sync.yml.
// Same-origin static file on GitHub Pages — no auth, no CORS issues, just a fetch.

let cache = null;
let loadPromise = null;

async function load() {
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = fetch("data/garmin.json", { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      cache = data;
      return data;
    })
    .catch(() => {
      cache = null;
      return null;
    });
  return loadPromise;
}

export const Garmin = {
  /** Call once at startup; safe to call multiple times, only fetches once. */
  async preload() {
    return load();
  },

  /** Synchronous lookup — call after preload() has resolved. Returns null if unavailable. */
  dayFor(dateKey) {
    if (!cache || !cache.days) return null;
    return cache.days.find((d) => d.date === dateKey) || null;
  },

  isAvailable() {
    return !!(cache && cache.days && cache.days.length);
  },

  syncedAt() {
    return cache ? cache.syncedAt : null;
  },

  allDays() {
    return cache && cache.days ? cache.days : [];
  }
};
