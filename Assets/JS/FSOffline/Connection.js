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
 * Single source of truth for the online/offline state.
 *
 * Design notes:
 * - Only a real NETWORK failure flips the state to OFFLINE (fetch throws or the
 *   timeout aborts). An HTTP error response (4xx/5xx) means the server answered,
 *   so we stay ONLINE. FSOffline.Http enforces this contract when it reports.
 * - While OFFLINE we do NOT probe on every action. Recovery is decoupled from
 *   business activity: a backoff timer pings on its own ([10,30,60,120,300]s),
 *   the browser 'online' event triggers an immediate ping, and an opportunistic
 *   probe fires on activity only when enough time has passed since the last ping
 *   (probeMinGap), so it never adds traffic during the early backoff stages.
 *
 * This class is exported as a singleton instance so FSOffline.Http imports the
 * very same object the facade exposes as FSOffline.Connection.
 */
class ConnectionManager {
    constructor() {
        // Defaults (overridable through init()).
        this.pingUrl = null;
        this.pingTimeout = 4000;
        this.backoff = [10000, 30000, 60000, 120000, 300000];
        this.probeMinGap = 30000;
        this.failureThreshold = 1;

        // State.
        this.online = true;
        this.consecutiveFailures = 0;
        this.backoffIndex = 0;
        this.lastCheckAt = 0;
        this.recoveryTimer = null;
        this.inflight = null;          // shared in-flight ping promise.
        this.listeners = new Set();
        this.initialized = false;
    }

    /**
     * Configures the manager. Idempotent: a second call only updates options
     * (it never binds the window listeners twice).
     *
     * @param {object} options
     * @returns {ConnectionManager}
     */
    init(options = {}) {
        if (typeof options.pingUrl === 'string') this.pingUrl = options.pingUrl;
        if (typeof options.pingTimeout === 'number') this.pingTimeout = options.pingTimeout;
        if (Array.isArray(options.backoff) && options.backoff.length) this.backoff = options.backoff;
        if (typeof options.probeMinGap === 'number') this.probeMinGap = options.probeMinGap;
        if (typeof options.failureThreshold === 'number') this.failureThreshold = options.failureThreshold;

        if (this.initialized) {
            return this;
        }

        this.online = typeof options.startOnline === 'boolean'
            ? options.startOnline
            : (navigator.onLine !== false);

        // The OS regained a network interface: confirm with a ping, do not trust blindly.
        window.addEventListener('online', () => {
            this.backoffIndex = 0;
            this.check();
        });

        // The OS lost the network interface: cheap, immediate negative signal.
        window.addEventListener('offline', () => this._setOffline());

        this.initialized = true;
        return this;
    }

    /**
     * @returns {boolean}
     */
    isOnline() {
        return this.online;
    }

    /**
     * @returns {string} 'online' | 'offline'
     */
    state() {
        return this.online ? 'online' : 'offline';
    }

    /**
     * Subscribes to state changes. Returns an unsubscribe function.
     *
     * @param {function({online:boolean, state:string})} callback
     * @returns {function(): void}
     */
    onChange(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    /**
     * Reported by Http after a request that GOT a response (any HTTP status):
     * the server is alive, so we are online.
     */
    reportSuccess() {
        this.consecutiveFailures = 0;
        if (!this.online) {
            this._setOnline();
        }
    }

    /**
     * Reported by Http after a real network failure (throw or timeout). Flips to
     * OFFLINE once the consecutive-failure threshold is reached.
     */
    reportFailure() {
        this.consecutiveFailures++;
        if (this.online && this.consecutiveFailures >= this.failureThreshold) {
            this._setOffline();
        }
    }

    /**
     * Opportunistic probe. Http calls it when it short-circuits an offline
     * request: it nudges a background ping only if enough time has passed since
     * the last one, so it stays quiet during the early (frequent) backoff stages.
     */
    notifyActivity() {
        if (this.online) {
            return;
        }
        if (Date.now() - this.lastCheckAt < this.probeMinGap) {
            return;
        }
        // Fire and forget: never blocks the caller. If it succeeds, _setOnline
        // clears the pending recovery timer.
        this._attempt();
    }

    /**
     * Forces an immediate ping (e.g. a "retry" button). Resets the backoff.
     *
     * @returns {Promise<boolean>}
     */
    async check() {
        this._clearRecovery();
        this.backoffIndex = 0;
        const ok = await this._attempt();
        if (!ok && !this.online) {
            this._scheduleRecovery();
        }
        return ok;
    }

    /* ----------------------------- private ----------------------------- */

    _setOnline() {
        this._clearRecovery();
        this.backoffIndex = 0;
        this.consecutiveFailures = 0;
        if (this.online) {
            return;
        }
        this.online = true;
        this._emit();
    }

    _setOffline() {
        if (!this.online) {
            return;
        }
        this.online = false;
        this.backoffIndex = 0;
        this._emit();
        this._scheduleRecovery();
    }

    _scheduleRecovery() {
        this._clearRecovery();
        const delay = this.backoff[Math.min(this.backoffIndex, this.backoff.length - 1)];
        this.recoveryTimer = setTimeout(() => this._recoveryTick(), delay);
    }

    _clearRecovery() {
        if (this.recoveryTimer) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = null;
        }
    }

    async _recoveryTick() {
        const ok = await this._attempt();
        if (!ok && !this.online) {
            this.backoffIndex = Math.min(this.backoffIndex + 1, this.backoff.length - 1);
            this._scheduleRecovery();
        }
    }

    /**
     * Runs a single ping. Concurrent callers share the same in-flight promise so
     * we never have two pings racing. On success the state becomes ONLINE.
     *
     * @returns {Promise<boolean>}
     */
    _attempt() {
        if (this.inflight) {
            return this.inflight;
        }
        this.inflight = (async () => {
            this.lastCheckAt = Date.now();
            const ok = await this._ping();
            this.inflight = null;
            if (ok) {
                this._setOnline();
            }
            return ok;
        })();
        return this.inflight;
    }

    /**
     * Raw reachability ping. Uses fetch directly (not Http) to stay independent
     * of the connection state and avoid recursion.
     *
     * @returns {Promise<boolean>}
     */
    async _ping() {
        if (!this.pingUrl) {
            return false;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.pingTimeout);
        try {
            const response = await fetch(this.pingUrl, {
                method: 'HEAD',
                cache: 'no-store',
                signal: controller.signal
            });
            return response.ok;
        } catch (error) {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }

    _emit() {
        const detail = { online: this.online, state: this.state() };
        this.listeners.forEach(callback => {
            try {
                callback(detail);
            } catch (error) {
                console.error('FSOffline.Connection listener error:', error);
            }
        });
        window.dispatchEvent(new CustomEvent('fsoffline:connection', { detail }));
    }
}

export const Connection = new ConnectionManager();
