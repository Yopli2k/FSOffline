/**
 * This file is part of the FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 *
 * Media service worker for FSOffline.Media.
 *
 * It is NOT an ES module of FSOffline.js and is never loaded with import(): the
 * browser's service worker runtime runs it in its own ServiceWorkerGlobalScope,
 * served by the /MediaCache controller (which adds the Service-Worker-Allowed
 * header so it can claim the install-root scope).
 *
 * For image GET requests whose path matches one of the configured prefixes, it
 * applies cache-first + expiration + fallback against the Cache API, stripping
 * the authorization query token from the cache key (the same image is cached
 * once regardless of the ?token=... it was downloaded with). Any other request
 * is left untouched (no respondWith), so the browser handles it as if no worker
 * existed.
 *
 * The configuration travels from FSOffline.Media.register() through IndexedDB
 * (base FSOffline, physical store keyValueStore, keys "media-config:<id>"),
 * because the browser kills and restarts the worker, so its config cannot live in
 * memory. This worker only READS that database; it never creates it (see
 * readConfigEntries).
 */
"use strict";

// Bump to invalidate old caches on activate (cleanupOldCaches).
const MEDIA_WORKER_VERSION = 'v1';

// IndexedDB coordinates of the per-plugin media config (mirror of OfflineDatabase
// / OfflineStore, which the page side writes through). Part of the contract.
const CONFIG_DB = 'FSOffline';
const CONFIG_DB_VERSION = 1;
const CONFIG_STORE = 'keyValueStore';     // single physical object store
const CONFIG_PREFIX = 'media-config:';    // logical store prefix in composite keys

// Soft in-memory TTL for the config snapshot, so we do not hit IndexedDB on every
// image. Config changes (register/unregister) show up within this window, or
// instantly via the 'fsoffline:media:reload' message.
const CONFIG_MEMORY_TTL = 30000;

// Header used to stamp the save time, since the Cache API stores no usable date.
const CACHED_AT_HEADER = 'x-cached-at';

// Sentinel entry written into every cache we create, so we can tell our caches
// apart from any other Cache Storage bucket (a PWA shell, another plugin, ...)
// and clean up only our own old versions. Never served and never evicted.
const OWN_MARKER = '/__fsoffline-media-cache__';

// Quota safety net: when the origin storage usage crosses this ratio, trim a
// chunk of the oldest entries from the cache we just wrote to.
const QUOTA_SOFT_LIMIT = 0.9;
const QUOTA_TRIM_RATIO = 0.1;

// In-memory config snapshot: { at: <ms>, entries: <array|null> }.
let configCache = { at: 0, entries: null };

// Cache names already marked as ours during this worker's life (avoids re-checking
// the sentinel on every write).
const markedCaches = new Set();

/* ------------------------------ lifecycle ------------------------------ */

// Take over as soon as installed, without waiting for every tab to close.
self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

// Claim the open pages, warm the config and drop our own stale caches.
self.addEventListener('activate', (event) => {
    event.waitUntil(Promise.all([self.clients.claim(), cleanupOldCaches()]));
});

// Control channel: kill-switch and config reload pushed by FSOffline.Media.
self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'fsoffline:media:unregister') {
        event.waitUntil(self.registration.unregister());
    } else if (data.type === 'fsoffline:media:reload') {
        configCache = { at: 0, entries: null };
        // A config change may have retired a cacheName: clean it up promptly.
        event.waitUntil(cleanupOldCaches());
    }
});

/* -------------------------------- fetch -------------------------------- */

self.addEventListener('fetch', (event) => {
    const request = event.request;

    // Only same-origin image GETs are candidates; everything else is untouched.
    if (request.method !== 'GET' || request.destination !== 'image') {
        return;
    }
    let url;
    try {
        url = new URL(request.url);
    } catch (error) {
        return;
    }
    if (url.origin !== self.location.origin) {
        return;
    }

    const entries = configCache.entries;

    // Cold start (worker just (re)started): decide after loading the config, so we
    // do not miss caching on the first paint.
    if (entries === null) {
        event.respondWith(handleCold(request, url));
        return;
    }

    // Warm: refresh in the background if the snapshot is stale, but decide now.
    if (Date.now() - configCache.at >= CONFIG_MEMORY_TTL) {
        getConfig();
    }

    const match = findMatch(url, entries);
    if (!match) {
        return; // not a catalog image: let the browser handle it normally.
    }
    event.respondWith(cacheFirst(request, url, match));
});

async function handleCold(request, url) {
    const entries = await getConfig();
    const match = findMatch(url, entries);
    return match ? cacheFirst(request, url, match) : fetch(request);
}

/* ----------------------------- strategy -------------------------------- */

/**
 * Cache-first with expiration and fallback.
 * - Fresh hit in cache -> serve it (no network).
 * - Miss or expired     -> go to the network (with the original token), refresh
 *                          the cache, serve the fresh response.
 * - Network unreachable  -> serve the stale copy if any, else the fallback.
 */
async function cacheFirst(request, url, config) {
    const cache = await caches.open(config.cacheName || 'media-cache');
    const cacheKey = stripToken(url);

    const cached = await cache.match(cacheKey);
    if (cached && !isExpired(cached, config.ttl)) {
        return cached;
    }

    try {
        const network = await fetch(request);
        if (network && network.ok) {
            const dated = await withCachedAt(network);
            await cache.put(cacheKey, dated.clone());
            await afterWrite(cache, config);
            return dated;
        }
        // Server answered but not OK (e.g. 404/410): prefer a stale copy, else fallback.
        return cached || serveFallback(cache, config);
    } catch (error) {
        // Network failure (offline): stale copy if we have one, else fallback.
        return cached || serveFallback(cache, config);
    }
}

/**
 * Returns the fallback image: from cache, then from the network (caching it), and
 * as a last resort an error response so the <img> just shows broken (never throws).
 */
async function serveFallback(cache, config) {
    if (config.fallback) {
        const cachedFallback = await cache.match(config.fallback);
        if (cachedFallback) {
            return cachedFallback;
        }
        try {
            const fetched = await fetch(config.fallback);
            if (fetched && fetched.ok) {
                await cache.put(config.fallback, fetched.clone());
                return fetched;
            }
        } catch (error) {
            // ignore: fall through to the error response
        }
    }
    return Response.error();
}

/* ------------------------------ eviction ------------------------------- */

/**
 * Bookkeeping after a successful write: mark the cache as ours and keep it within
 * the configured entry limit and under quota pressure. Expired entries are NOT
 * pruned on purpose: a stale copy is still the offline fallback for that image.
 */
async function afterWrite(cache, config) {
    await ensureOwned(cache, config.cacheName || 'media-cache');
    await enforceEntryLimit(cache, config);
    await enforceQuota(cache, config);
}

/**
 * Writes the ownership sentinel once per cache (per worker life), so cleanup can
 * recognise our caches without touching unrelated Cache Storage buckets.
 */
async function ensureOwned(cache, cacheName) {
    if (markedCaches.has(cacheName)) {
        return;
    }
    const existing = await cache.match(OWN_MARKER);
    if (!existing) {
        await cache.put(OWN_MARKER, new Response(MEDIA_WORKER_VERSION, { headers: { 'content-type': 'text/plain' } }));
    }
    markedCaches.add(cacheName);
}

/**
 * Keeps the cache within config.maxEntries by deleting the oldest entries first
 * (FIFO over keys(), which is insertion/refresh order ≈ least recently written).
 * The sentinel and the fallback are protected. A null/zero maxEntries disables it.
 */
async function enforceEntryLimit(cache, config) {
    const max = typeof config.maxEntries === 'number' ? config.maxEntries : null;
    if (max === null || max <= 0) {
        return;
    }
    const keys = await cache.keys();
    const evictable = keys.filter((request) => false === isProtected(request, config));
    const overflow = evictable.length - max;
    for (let i = 0; i < overflow; i++) {
        await cache.delete(evictable[i]);
    }
}

/**
 * Best-effort safety net: when origin storage usage crosses QUOTA_SOFT_LIMIT, trim
 * a chunk of the oldest evictable entries from this cache. estimate() is
 * origin-wide, so this only bounds our own growth, but that is the part we control.
 */
async function enforceQuota(cache, config) {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') {
        return;
    }
    let estimate;
    try {
        estimate = await navigator.storage.estimate();
    } catch (error) {
        return;
    }
    if (!estimate || !estimate.quota || (estimate.usage / estimate.quota) < QUOTA_SOFT_LIMIT) {
        return;
    }
    const keys = await cache.keys();
    const evictable = keys.filter((request) => false === isProtected(request, config));
    const remove = Math.ceil(evictable.length * QUOTA_TRIM_RATIO);
    for (let i = 0; i < remove; i++) {
        await cache.delete(evictable[i]);
    }
}

/**
 * True for entries that must never be evicted: the ownership sentinel and the
 * configured fallback image.
 */
function isProtected(request, config) {
    if (request.url.endsWith(OWN_MARKER)) {
        return true;
    }
    return Boolean(config.fallback) && request.url.endsWith(config.fallback);
}

/**
 * Deletes OUR caches whose name is no longer referenced by any current config
 * (e.g. a cacheName bumped from v1 to v2). It only removes caches carrying our
 * sentinel, never third-party buckets, and bails out when no config is loaded, so
 * a transient empty read can never wipe live caches.
 */
async function cleanupOldCaches() {
    const entries = await getConfig();
    if (entries.length === 0) {
        return;
    }
    const current = new Set(entries.map((entry) => entry.cacheName || 'media-cache'));
    const names = await caches.keys();
    await Promise.all(names.map(async (name) => {
        if (current.has(name)) {
            return;
        }
        const cache = await caches.open(name);
        const owned = await cache.match(OWN_MARKER);
        if (owned) {
            await caches.delete(name);
        }
    }));
}

/* ------------------------------ helpers -------------------------------- */

/**
 * Cache key without the query string: the same image is stored once regardless of
 * the ?token=... it was downloaded with (the token only authorizes the download).
 */
function stripToken(url) {
    return url.origin + url.pathname;
}

/**
 * Rebuilds the response with an x-cached-at header so expiration can be checked
 * later (the Cache API keeps no usable save date).
 */
async function withCachedAt(response) {
    const headers = new Headers(response.headers);
    headers.set(CACHED_AT_HEADER, Date.now().toString());
    const body = await response.blob();
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * True when the cached response is older than the configured ttl. A null ttl means
 * no time-based expiration (cache-first until evicted).
 */
function isExpired(response, ttl) {
    if (ttl === null || ttl === undefined) {
        return false;
    }
    const cachedAt = Number(response.headers.get(CACHED_AT_HEADER));
    if (!cachedAt) {
        return true;
    }
    return (Date.now() - cachedAt) > ttl;
}

/**
 * First config entry whose patterns prefix-match the request path, or null.
 */
function findMatch(url, entries) {
    for (const entry of entries) {
        const patterns = Array.isArray(entry.patterns) ? entry.patterns : [];
        for (const prefix of patterns) {
            if (prefix && url.pathname.startsWith(prefix)) {
                return entry;
            }
        }
    }
    return null;
}

/**
 * Returns the config snapshot, reloading from IndexedDB when stale.
 */
async function getConfig() {
    const now = Date.now();
    if (configCache.entries !== null && (now - configCache.at) < CONFIG_MEMORY_TTL) {
        return configCache.entries;
    }
    const entries = await readConfigEntries();
    configCache = { at: now, entries };
    return entries;
}

/**
 * Reads every "media-config:<id>" entry from the FSOffline IndexedDB database.
 *
 * It opens at the SAME version the page uses and, crucially, ABORTS any upgrade:
 * the database and its object store must be created by the page side. This way the
 * worker never leaves an empty v1 database that would stop the page from creating
 * the keyValueStore. Any error resolves to an empty list (the worker stays inert).
 *
 * @returns {Promise<Array>}
 */
function readConfigEntries() {
    return new Promise((resolve) => {
        let request;
        try {
            request = indexedDB.open(CONFIG_DB, CONFIG_DB_VERSION);
        } catch (error) {
            resolve([]);
            return;
        }

        // The DB did not exist (or needs an upgrade): do NOT create anything here.
        request.onupgradeneeded = (event) => {
            try {
                event.target.transaction.abort();
            } catch (error) {
                // abort surfaces as onerror below
            }
        };

        request.onerror = () => resolve([]);

        request.onsuccess = (event) => {
            const db = event.target.result;
            if (false === db.objectStoreNames.contains(CONFIG_STORE)) {
                db.close();
                resolve([]);
                return;
            }
            try {
                const transaction = db.transaction(CONFIG_STORE, 'readonly');
                const store = transaction.objectStore(CONFIG_STORE);
                const range = IDBKeyRange.bound(CONFIG_PREFIX, CONFIG_PREFIX + '￿', false, false);
                const getAll = store.getAll(range);
                getAll.onsuccess = () => resolve(Array.isArray(getAll.result) ? getAll.result : []);
                getAll.onerror = () => resolve([]);
                transaction.oncomplete = () => db.close();
            } catch (error) {
                resolve([]);
                try {
                    db.close();
                } catch (closeError) {
                    // ignore
                }
            }
        };
    });
}
