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
 * Resends the offline write queue (__queue__) and lets the consumer reconcile with
 * the server, which is the source of truth.
 *
 * Writes captured while offline by FSOffline.Http (the `offline` hook with
 * `queue: true`) pile up in each database's __queue__ store as
 * { id, url, method, body, ts }. When the connection comes back, Sync RESENDS them
 * to the server IN ORDER, removing each one only once the server accepts it, and
 * finally hands control to the consumer so it can refresh its authoritative state.
 *
 * It is published by FSOffline.connect(), which injects the shared Http / Connection
 * singletons and the store resolver through configure(). Injecting them (instead of
 * importing Http.js / Connection.js here) is deliberate: the facade loads the
 * modules WITH a version query, so a direct import without the query would create
 * duplicate singletons — the very pitfall connect() warns about.
 *
 * It owns NO domain logic: how to resend a request, what a server rejection means
 * and how to reconcile are all consumer decisions, provided as hooks with safe
 * defaults.
 *
 * Default policy per resent entry:
 *   - ok (2xx)                  -> remove (the server accepted it; now it is safe).
 *   - networkError / offline    -> keep and STOP (transient; retried on the next
 *                                  reconnection, preserving FIFO order).
 *   - any other (4xx/5xx, ...)  -> fail: move the entry to the FAILED bucket and
 *                                  notify, instead of discarding it. Valuable
 *                                  business data is never dropped silently.
 *
 * Durability guarantees (same browser/device): an entry leaves __queue__ only when
 * the server confirms it (removed) or it is parked for review (failed); the queue is
 * never cleared blindly; persistent storage is requested to resist eviction; and a
 * beforeunload guard warns before leaving with unsent writes.
 *
 * Exported as a singleton so the facade exposes the same object as FSOffline.Sync.
 */
class SyncManager {
    constructor() {
        this._resolve = null;        // (db, store) => Promise<OfflineStore>
        this._http = null;           // FSOffline.Http
        this._connection = null;     // FSOffline.Connection
        this._registry = new Map();  // db => hooks
        this._draining = new Map();  // db => in-flight resend promise (one per database)
        this._counts = new Map();    // db => cached pending count (synchronous source for hasPending)
        this._guardUnload = true;    // warn on beforeunload while there are pending writes
        this._configured = false;
    }

    /**
     * Injects the shared singletons and starts the durability safeguards. Called once
     * by FSOffline.connect(). Subscribes to Connection (a reconnection resends every
     * auto-registered database), listens for new enqueues, installs the beforeunload
     * guard and requests persistent storage. Idempotent: later calls only refresh the
     * references.
     *
     * @param {object} context
     * @param {function(string, string): Promise<object>} context.storeResolver
     * @param {object} context.http        FSOffline.Http
     * @param {object} context.connection  FSOffline.Connection
     * @param {boolean} [context.guardUnload=true]
     * @returns {SyncManager}
     */
    configure({ storeResolver, http, connection, guardUnload } = {}) {
        this._resolve = storeResolver || this._resolve;
        this._http = http || this._http;
        this._connection = connection || this._connection;
        if (typeof guardUnload === 'boolean') {
            this._guardUnload = guardUnload;
        }

        if (this._configured) {
            return this;
        }

        if (this._connection && typeof this._connection.onChange === 'function') {
            this._connection.onChange((state) => {
                if (state.online) {
                    this._resendAuto();
                }
            });
        }

        // FSOffline.Http emits this after queuing a write: bump the synchronous
        // counter so hasPending() is correct right away (the exact value is
        // recomputed by the next resend / refresh).
        window.addEventListener('fsoffline:enqueued', (event) => {
            const db = event.detail && event.detail.db;
            if (db) {
                this._bump(db, 1);
            }
        });

        window.addEventListener('beforeunload', (event) => {
            if (this._guardUnload && this.hasPending()) {
                event.preventDefault();
                event.returnValue = '';   // browsers show their own generic message.
            }
        });

        this._requestPersistentStorage();
        this._configured = true;
        return this;
    }

    /**
     * Registers a database for syncing.
     *
     * Hooks (all optional):
     *   - resend(entry): async. Sends one queued write. Must resolve to an Http-like
     *     Result ({ ok, status, networkError, offline, ... }). Default: rebuild a
     *     FormData from entry.body and POST it through Http to entry.url.
     *   - resolve(entry, result): returns 'remove' | 'keep' | 'fail' | 'drop' to
     *     override the default policy for a single entry. Anything else falls back to
     *     the default policy.
     *   - onComplete(summary): async. Called once after a resend that touched the
     *     server (>=1 entry removed or failed), so the consumer can reconcile
     *     (re-fetch authoritative state and patch the UI in place).
     *   - onFailed(entry, result): async. Called for every entry parked in the FAILED
     *     bucket, so the consumer can warn the user.
     *   - auto (default true): resend automatically when the connection comes back.
     *
     * If currently online, an initial resend is kicked off to flush any leftovers
     * from a previous session.
     *
     * @param {string} db
     * @param {object} [hooks]
     * @returns {SyncManager}
     */
    register(db, hooks = {}) {
        if (!db) {
            throw new Error('FSOffline.Sync.register() requires a database name.');
        }
        this._ensureConfigured();

        this._registry.set(db, {
            resend: typeof hooks.resend === 'function' ? hooks.resend : null,
            resolve: typeof hooks.resolve === 'function' ? hooks.resolve : null,
            onComplete: typeof hooks.onComplete === 'function' ? hooks.onComplete : null,
            onFailed: typeof hooks.onFailed === 'function' ? hooks.onFailed : null,
            auto: hooks.auto !== false
        });

        // Seed the synchronous counter and either flush leftovers (online) or just
        // publish the current pending count (offline) for the consumer indicator.
        this._refresh(db).then(() => {
            if (this._connection && this._connection.isOnline()) {
                this.sync(db);
            }
        });
        return this;
    }

    /**
     * Stops syncing a database (does NOT touch its queue or failed bucket).
     *
     * @param {string} db
     * @returns {SyncManager}
     */
    unregister(db) {
        this._registry.delete(db);
        return this;
    }

    /**
     * Resends a database's queue NOW (e.g. a "retry" button). Concurrent calls for
     * the same database share the in-flight promise, so it is never resent twice at
     * once.
     *
     * @param {string} db
     * @returns {Promise<object>} A summary { db, removed, failed, kept }.
     */
    sync(db) {
        if (this._draining.has(db)) {
            return this._draining.get(db);
        }
        const promise = this._resend(db).finally(() => this._draining.delete(db));
        this._draining.set(db, promise);
        return promise;
    }

    /**
     * Number of writes still queued for a database (exact; reads the store).
     *
     * @param {string} db
     * @returns {Promise<number>}
     */
    async pending(db) {
        const store = await this._resolve(db, SyncManager.QUEUE_STORE);
        const entries = await store.all();
        return entries.length;
    }

    /**
     * Whether there is any pending write across all registered databases. Synchronous
     * (reads the in-memory counter) so it can answer the beforeunload guard.
     *
     * @returns {boolean}
     */
    hasPending() {
        for (const count of this._counts.values()) {
            if (count > 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * Writes parked in the FAILED bucket (server rejected them). For consumer review.
     *
     * @param {string} db
     * @returns {Promise<Array>}
     */
    async failed(db) {
        const store = await this._resolve(db, SyncManager.FAILED_STORE);
        return store.all();
    }

    /**
     * Discards one parked failed entry (after a human reviewed it).
     *
     * @param {string} db
     * @param {string} id
     * @returns {Promise<void>}
     */
    async dismissFailed(db, id) {
        const store = await this._resolve(db, SyncManager.FAILED_STORE);
        return store.delete(id);
    }

    /* ----------------------------- private ----------------------------- */

    /**
     * Resends every database registered with auto:true (fired on reconnection).
     */
    _resendAuto() {
        for (const [db, hooks] of this._registry) {
            if (hooks.auto) {
                this.sync(db);
            }
        }
    }

    /**
     * Resends the queued writes of a database in FIFO order until the queue is empty,
     * the connection drops again or an entry must be kept. Removed/failed entries
     * leave the queue; a kept entry stops the resend (preserving order) and waits for
     * the next reconnection.
     *
     * @param {string} db
     * @returns {Promise<object>} summary
     */
    async _resend(db) {
        const summary = { db, removed: 0, failed: 0, kept: 0 };

        const hooks = this._registry.get(db);
        if (!hooks) {
            return summary;   // not registered: we have no resend/reconcile hooks.
        }
        if (!this._connection || !this._connection.isOnline()) {
            return summary;   // offline: defer to the next reconnection.
        }

        const store = await this._resolve(db, SyncManager.QUEUE_STORE);
        const entries = (await store.all()).sort((a, b) => (a.ts || 0) - (b.ts || 0));

        for (const entry of entries) {
            // Went offline again mid-resend: keep the rest for the next reconnection.
            if (!this._connection.isOnline()) {
                break;
            }

            let result;
            try {
                result = hooks.resend ? await hooks.resend(entry) : await this._defaultResend(entry);
            } catch (error) {
                console.warn('FSOffline.Sync: resend threw, keeping entry and stopping.', error, entry);
                break;
            }

            const action = this._decide(entry, result || {}, hooks);
            if (action === 'remove' || action === 'drop') {
                await store.delete(entry.id);
                if (action === 'remove') {
                    summary.removed++;
                }
            } else if (action === 'fail') {
                await this._park(db, entry, result || {}, hooks);
                await store.delete(entry.id);
                summary.failed++;
            } else {
                // 'keep': transient failure. Stop here so the queue stays ordered.
                summary.kept++;
                break;
            }
        }

        await this._refresh(db);
        if ((summary.removed > 0 || summary.failed > 0) && hooks.onComplete) {
            try {
                await hooks.onComplete(summary);
            } catch (error) {
                console.warn('FSOffline.Sync: onComplete threw.', error);
            }
        }
        return summary;
    }

    /**
     * Decides what to do with a resent entry: consumer hook first, then the default
     * policy (see the class doc).
     *
     * @param {object} entry
     * @param {object} result
     * @param {object} hooks
     * @returns {string} 'remove' | 'keep' | 'fail' | 'drop'
     */
    _decide(entry, result, hooks) {
        if (hooks.resolve) {
            const action = hooks.resolve(entry, result);
            if (action === 'remove' || action === 'keep' || action === 'fail' || action === 'drop') {
                return action;
            }
        }
        if (result.ok) {
            return 'remove';
        }
        if (result.networkError || result.offline) {
            return 'keep';
        }
        return 'fail';
    }

    /**
     * Default resend: rebuild a FormData from the stored body and POST it through
     * Http. FacturaScripts controllers read POST fields (not JSON), and the captured
     * write was a FormData, so this reproduces the original request faithfully.
     *
     * @param {object} entry
     * @returns {Promise<object>} Http Result
     */
    _defaultResend(entry) {
        const body = this._toFormData(entry.body);
        return this._http.request(entry.url, { method: entry.method || 'POST', body });
    }

    /**
     * Moves a rejected entry to the FAILED bucket and notifies the consumer. Parking
     * (instead of discarding) keeps valuable business data reviewable.
     *
     * @param {string} db
     * @param {object} entry
     * @param {object} result
     * @param {object} hooks
     * @returns {Promise<void>}
     */
    async _park(db, entry, result, hooks) {
        const store = await this._resolve(db, SyncManager.FAILED_STORE);
        await store.set(entry.id, Object.assign({}, entry, {
            failedAt: Date.now(),
            status: result.status || 0
        }));
        if (hooks.onFailed) {
            try {
                await hooks.onFailed(entry, result);
            } catch (error) {
                console.warn('FSOffline.Sync: onFailed threw.', error);
            }
        }
    }

    /**
     * Recomputes the exact pending count of a database from the store and publishes
     * it. Keeps the synchronous counter honest after enqueues and resends.
     *
     * @param {string} db
     * @returns {Promise<number>}
     */
    async _refresh(db) {
        const count = await this.pending(db);
        this._counts.set(db, count);
        this._emitChange(db, count);
        return count;
    }

    /**
     * Optimistically adjusts the cached pending count and publishes it. Used on the
     * 'fsoffline:enqueued' signal so hasPending() reacts immediately.
     *
     * @param {string} db
     * @param {number} delta
     */
    _bump(db, delta) {
        const count = Math.max(0, (this._counts.get(db) || 0) + delta);
        this._counts.set(db, count);
        this._emitChange(db, count);
    }

    /**
     * Notifies consumers (e.g. the "N unsent" indicator) that a queue size changed.
     *
     * @param {string} db
     * @param {number} pending
     */
    _emitChange(db, pending) {
        window.dispatchEvent(new CustomEvent('fsoffline:queue-changed', { detail: { db, pending } }));
    }

    /**
     * Rebuilds a FormData from a plain object (the queue stores bodies normalized to
     * objects). Non-object bodies yield an empty FormData.
     *
     * @param {*} body
     * @returns {FormData}
     */
    _toFormData(body) {
        const form = new FormData();
        if (body && typeof body === 'object') {
            for (const [key, value] of Object.entries(body)) {
                form.append(key, value);
            }
        }
        return form;
    }

    /**
     * Asks the browser to mark the origin's storage as persistent so IndexedDB is not
     * evicted under storage pressure. Best effort: the browser may decline. Fire and
     * forget; never blocks startup.
     */
    _requestPersistentStorage() {
        try {
            if (navigator.storage && typeof navigator.storage.persist === 'function') {
                navigator.storage.persisted().then((already) => {
                    if (!already) {
                        navigator.storage.persist();
                    }
                });
            }
        } catch (error) {
            // Not available (old browser / insecure context): ignore.
        }
    }

    _ensureConfigured() {
        if (!this._resolve || !this._http) {
            throw new Error('FSOffline.Sync is not configured. Call FSOffline.connect() first.');
        }
    }
}

// Logical store names. QUEUE_STORE mirrors HttpClient.QUEUE_STORE; the contract is
// documented in docs/http.md ("Cola de escrituras"). FAILED_STORE parks the writes
// the server rejected, for human review.
SyncManager.QUEUE_STORE = '__queue__';
SyncManager.FAILED_STORE = '__failed__';

export const Sync = new SyncManager();
