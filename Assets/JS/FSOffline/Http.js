/**
 * This file is part of the FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 *
 * ES module: loaded through dynamic import() from FSOffline.js (via FSOffline.connect()).
 *
 * It statically imports Connection and Cache and RE-EXPORTS them, so a single
 * dynamic import of this file bootstraps the whole offline layer with one shared
 * instance of each (the facade must NOT import Connection.js / Cache.js with a
 * different URL query, or the browser would create duplicate singletons).
 */
"use strict";

import { Connection } from './Connection.js';
import { Cache } from './Cache.js';

export { Connection, Cache };

/**
 * The single network gateway for the app.
 *
 * It wraps fetch with a timeout, feeds the connection state into Connection and
 * normalizes the result. It never throws to the caller: every call resolves to a
 * Result object.
 *
 * Result shape:
 *   {
 *     ok:           boolean,  // response.ok, or true for an applied offline write
 *     status:       number,   // HTTP status, 0 when there was no response
 *     data:         *,        // parsed JSON, text, cached value or apply() output
 *     networkError: boolean,  // true on fetch throw / timeout (no response)
 *     offline:      boolean,  // true when not even attempted (Connection OFFLINE)
 *     fromCache:    boolean,  // true when data comes from cache / offline apply
 *     applied:      boolean,  // true when an offline write hook mutated local state
 *     aborted:      boolean,  // true when the request was aborted
 *     cancelled:    boolean   // true when aborted by the caller's own signal
 *   }
 *
 * Per-request options (besides method/body/headers/timeout/signal/force):
 *   - cache:   { db, store, key, ttl?, transform? }  read-through response cache.
 *   - offline: { db, store, apply(ctx), queue? }     local handler for writes.
 *
 * Connectivity contract:
 * - Got a response (even 4xx/5xx) -> Connection.reportSuccess() (server alive).
 * - Network throw / timeout       -> Connection.reportFailure().
 * - Caller-cancelled (external signal, not our timeout) -> neither.
 */
class HttpClient {
    constructor() {
        this.defaultTimeout = 15000;
    }

    /**
     * Performs a request through the gateway.
     *
     * @param {string} url
     * @param {object} [options]
     * @returns {Promise<object>} Result
     */
    async request(url, options = {}) {
        const {
            method = 'GET',
            body = null,
            headers = {},
            timeout = this.defaultTimeout,
            signal = null,
            force = false,
            cache = null,
            offline = null
        } = options;

        // 1. Offline short-circuit: do not waste a timeout. Serve cache / apply now.
        if (!force && !Connection.isOnline()) {
            Connection.notifyActivity();
            return this._fallback({ url, method, body, options, cache, offline, offlineFlag: true, networkError: false });
        }

        // 2. Timeout via AbortController. We flag our own timeout so a caller
        //    cancellation is not mistaken for a connectivity failure.
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeout);
        if (signal) {
            signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        try {
            const response = await fetch(url, { method, body, headers, signal: controller.signal });

            // There was a response (any status) -> the server is alive.
            Connection.reportSuccess();

            const data = await this._parse(response);

            // Read-through cache: store successful responses.
            if (cache && response.ok) {
                const toStore = typeof cache.transform === 'function' ? cache.transform(data) : data;
                await Cache.scope(cache.db, cache.store).set(this._cacheKey(cache, url, options), toStore, { ttl: cache.ttl });
            }

            return this._result({ ok: response.ok, status: response.status, data });
        } catch (error) {
            const aborted = error && error.name === 'AbortError';

            // Caller-cancelled (not our timeout): not a connectivity signal.
            if (aborted && !timedOut) {
                return this._result({ aborted: true, cancelled: true });
            }

            Connection.reportFailure();
            return this._fallback({ url, method, body, options, cache, offline, offlineFlag: false, networkError: true });
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * @param {string} url
     * @param {object} [options]
     * @returns {Promise<object>}
     */
    get(url, options = {}) {
        return this.request(url, { ...options, method: 'GET' });
    }

    /**
     * POST helper. A FormData body is sent as-is (the browser sets the boundary);
     * a plain object is JSON-encoded.
     *
     * @param {string} url
     * @param {FormData|object|string|null} [body=null]
     * @param {object} [options]
     * @returns {Promise<object>}
     */
    post(url, body = null, options = {}) {
        let payload = body;
        let headers = options.headers || {};

        if (body && !(body instanceof FormData) && typeof body === 'object') {
            payload = JSON.stringify(body);
            headers = { 'Content-Type': 'application/json', ...headers };
        }

        return this.request(url, { ...options, method: 'POST', body: payload, headers });
    }

    /* ----------------------------- private ----------------------------- */

    /**
     * Resolves what to return when the server could not be reached, either by the
     * offline short-circuit (offlineFlag true) or by a network failure mid-request
     * (offlineFlag false). Writes are applied locally; reads are served from cache.
     *
     * @param {object} ctx
     * @returns {Promise<object>}
     */
    async _fallback({ url, method, body, options, cache, offline, offlineFlag, networkError }) {
        // WRITE: hand it to the plugin to apply against local state.
        if (offline && typeof offline.apply === 'function') {
            const store = await Cache.rawStore(offline.db, offline.store);
            const data = await offline.apply({ url, method, body: this._bodyToObject(body), store, online: false });

            if (offline.queue) {
                await this._enqueue(offline.db, { url, method, body });
            }

            return this._result({ ok: true, data, fromCache: true, offline: offlineFlag, networkError, applied: true });
        }

        // READ: serve from cache (stale allowed, since we could not refresh).
        if (cache) {
            const value = await Cache.scope(cache.db, cache.store).get(this._cacheKey(cache, url, options), { allowStale: true });
            return this._result({ ok: value !== null, data: value, fromCache: true, offline: offlineFlag, networkError });
        }

        // Nothing to serve.
        return this._result({ offline: offlineFlag, networkError });
    }

    /**
     * Appends a write to the replay queue. The format is locked, but nothing drains
     * it yet: FSOffline.Sync (replay + reconciliation on reconnect) is a later phase.
     *
     * @param {string} db
     * @param {object} request
     * @returns {Promise<string>} The queued entry id.
     */
    async _enqueue(db, request) {
        const store = await Cache.rawStore(db, HttpClient.QUEUE_STORE);
        const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        await store.set(id, {
            id,
            url: request.url,
            method: request.method,
            body: this._bodyToObject(request.body),
            ts: Date.now()
        });
        return id;
    }

    /**
     * @param {object} cache The cache spec.
     * @param {string} url
     * @param {object} options
     * @returns {string}
     */
    _cacheKey(cache, url, options) {
        return typeof cache.key === 'function' ? cache.key(url, options) : cache.key;
    }

    /**
     * Normalizes a request body into a plain object for the offline hook / queue.
     *
     * @param {*} body
     * @returns {object}
     */
    _bodyToObject(body) {
        if (!body) {
            return {};
        }
        if (body instanceof FormData) {
            return Object.fromEntries(body.entries());
        }
        if (typeof body === 'string') {
            try {
                return JSON.parse(body);
            } catch (error) {
                return { _raw: body };
            }
        }
        if (typeof body === 'object') {
            return body;
        }
        return {};
    }

    /**
     * Builds a normalized Result, filling defaults.
     *
     * @param {object} partial
     * @returns {object}
     */
    _result(partial) {
        return Object.assign({
            ok: false,
            status: 0,
            data: null,
            networkError: false,
            offline: false,
            fromCache: false,
            applied: false,
            aborted: false,
            cancelled: false
        }, partial);
    }

    /**
     * Parses the response body: JSON when the content-type says so, text otherwise.
     *
     * @param {Response} response
     * @returns {Promise<*>}
     */
    async _parse(response) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            try {
                return await response.json();
            } catch (error) {
                return null;
            }
        }
        return response.text();
    }
}

// Logical store name for the offline write queue (seam for FSOffline.Sync).
HttpClient.QUEUE_STORE = '__queue__';

export const Http = new HttpClient();
