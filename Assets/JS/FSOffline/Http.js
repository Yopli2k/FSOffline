/**
 * This file is part of the FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 *
 * ES module: loaded through dynamic import() from FSOffline.js (via FSOffline.connect()).
 * It pulls the Connection singleton with a static import, so a single dynamic
 * import of this file bootstraps both modules sharing the same Connection instance.
 */
"use strict";

import { Connection } from './Connection.js';

/**
 * The single network gateway for the app.
 *
 * It wraps fetch with a timeout (AbortController), normalizes the result and
 * feeds the connection state into Connection. It never throws to the caller:
 * every call resolves to a Result object.
 *
 * Result shape:
 *   {
 *     ok:           boolean,  // response.ok (HTTP 2xx)
 *     status:       number,   // HTTP status, 0 when there was no response
 *     data:         *,        // parsed JSON, or text, or null
 *     networkError: boolean,  // true on fetch throw / timeout (no response)
 *     offline:      boolean,  // true when the request was not even attempted
 *     aborted:      boolean,  // true when the request was aborted
 *     cancelled:    boolean   // true when aborted by the caller's own signal
 *   }
 *
 * Connectivity contract:
 * - Got a response (even 4xx/5xx) -> Connection.reportSuccess() (server alive).
 * - Network throw / timeout       -> Connection.reportFailure().
 * - Caller-cancelled (external signal, not our timeout) -> neither, it is not a
 *   connectivity signal.
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
     * @param {string} [options.method='GET']
     * @param {*} [options.body=null]
     * @param {object} [options.headers={}]
     * @param {number} [options.timeout=15000]
     * @param {AbortSignal} [options.signal=null]  Caller signal to cancel.
     * @param {boolean} [options.force=false]      Bypass the offline short-circuit.
     * @returns {Promise<object>} Result
     */
    async request(url, options = {}) {
        const {
            method = 'GET',
            body = null,
            headers = {},
            timeout = this.defaultTimeout,
            signal = null,
            force = false
        } = options;

        // 1. Offline short-circuit: do not waste a timeout. Serve from cache now.
        //    Activity nudges Connection to (maybe) probe in the background.
        if (!force && !Connection.isOnline()) {
            Connection.notifyActivity();
            return this._result({ networkError: true, offline: true });
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
            return this._result({ ok: response.ok, status: response.status, data });
        } catch (error) {
            const aborted = error && error.name === 'AbortError';

            // Caller-cancelled (not our timeout): not a connectivity signal.
            if (aborted && !timedOut) {
                return this._result({ aborted: true, cancelled: true });
            }

            Connection.reportFailure();
            return this._result({ networkError: true, aborted });
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

export const Http = new HttpClient();
