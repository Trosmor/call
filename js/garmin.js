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

  /**
   * Re-fetches garmin.json, bypassing the session cache — used when the PWA is resumed
   * after a suspend, since the sync workflow may have committed new data meanwhile.
   * Resolves to true if the data actually changed.
   */
  async refresh() {
    // Keep serving the current data while re-fetching: clearing the cache up front made the
    // Garmin card and the active-calorie bonus vanish mid-refresh, and for good if the fetch
    // failed (offline, flaky network on resume).
    try {
      const res = await fetch("data/garmin.json", { cache: "no-store" });
      if (!res.ok) return false;
      const data = await res.json();
      const changed = !cache || data.syncedAt !== cache.syncedAt;
      cache = data;
      loadPromise = Promise.resolve(data);
      return changed;
    } catch (e) {
      return false;
    }
  },

  /** Hours since the sync workflow last wrote new data, or null if unknown. */
  hoursSinceSync() {
    if (!cache || !cache.syncedAt) return null;
    const t = Date.parse(cache.syncedAt);
    return Number.isNaN(t) ? null : (Date.now() - t) / 3600000;
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
