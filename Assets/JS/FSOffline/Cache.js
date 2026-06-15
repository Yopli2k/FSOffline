/**
 * This file is part of the FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 *
 * ES module: loaded through dynamic import() from FSOffline.js (via FSOffline.connect()).
 */
"use strict";

/**
 * Response cache over the FSOffline key/value stores.
 *
 * It targets a given (db, store) WITHOUT changing the active database, so several
 * plugins can cache in parallel safely. The store is resolved through a resolver
 * injected by the facade at connect() time (configure()), reusing the facade's
 * pool of opened databases.
 *
 * Each entry is wrapped with metadata so TTL and pruning are possible:
 *     { k: <logical key>, v: <value>, t: <savedAt ms>, ttl: <ms|null> }
 *
 * Exported as a singleton so FSOffline.Http and FSOffline.Cache share it.
 */
class CacheManager {
    constructor() {
        // Store resolver injected by the facade: (db, store) => Promise<OfflineStore>.
        this._resolve = null;
    }

    /**
     * Injects the store resolver. Called once by FSOffline.connect().
     *
     * @param {function(string, string): Promise<object>} storeResolver
     * @returns {CacheManager}
     */
    configure(storeResolver) {
        this._resolve = storeResolver;
        return this;
    }

    /**
     * Returns a cache handle bound to a (db, store). Synchronous; the database is
     * opened lazily on the first operation.
     *
     * @param {string} db
     * @param {string} store
     * @returns {CacheScope}
     */
    scope(db, store) {
        return new CacheScope(this, db, store);
    }

    /**
     * Returns a PLAIN key/value store (no TTL wrapper) for a (db, store). Used by
     * the offline write hook (the local order) and by the write queue.
     *
     * @param {string} db
     * @param {string} store
     * @returns {Promise<object>} OfflineStore
     */
    rawStore(db, store) {
        if (!this._resolve) {
            throw new Error('FSOffline.Cache is not configured. Call FSOffline.connect() first.');
        }
        return this._resolve(db, store);
    }
}

/**
 * A cache handle bound to a single (db, store).
 */
class CacheScope {
    constructor(manager, db, store) {
        this.manager = manager;
        this.db = db;
        this.store = store;
    }

    /**
     * Stores a value with optional TTL. Returns the value.
     *
     * @param {string|number} key
     * @param {*} value
     * @param {object} [options]
     * @param {number} [options.ttl] Milliseconds.
     * @returns {Promise<*>}
     */
    async set(key, value, options = {}) {
        const ttl = typeof options.ttl === 'number' ? options.ttl : null;
        const store = await this._store();
        await store.set(key, { k: key, v: value, t: Date.now(), ttl });
        return value;
    }

    /**
     * Returns the cached value, or null when missing or expired. An expired entry
     * is still returned when allowStale is true (the offline fallback path).
     *
     * @param {string|number} key
     * @param {object} [options]
     * @param {boolean} [options.allowStale=false]
     * @returns {Promise<*>}
     */
    async get(key, options = {}) {
        const store = await this._store();
        const entry = await store.get(key);
        if (!entry) {
            return null;
        }
        if (this._expired(entry) && !options.allowStale) {
            return null;
        }
        return entry.v;
    }

    /**
     * Deletes a single entry.
     *
     * @param {string|number} key
     * @returns {Promise<void>}
     */
    async delete(key) {
        const store = await this._store();
        return store.delete(key);
    }

    /**
     * Removes every expired entry of this store. Returns the number removed.
     *
     * @returns {Promise<number>}
     */
    async prune() {
        const store = await this._store();
        const entries = await store.all();
        let removed = 0;
        for (const entry of entries) {
            if (entry && this._expired(entry)) {
                await store.delete(entry.k);
                removed++;
            }
        }
        return removed;
    }

    /**
     * Removes every entry of this store.
     *
     * @returns {Promise<void>}
     */
    async clear() {
        const store = await this._store();
        return store.clear();
    }

    /* ----------------------------- private ----------------------------- */

    _store() {
        return this.manager.rawStore(this.db, this.store);
    }

    _expired(entry) {
        return entry.ttl != null && (Date.now() - entry.t) > entry.ttl;
    }
}

export const Cache = new CacheManager();
