/**
 * This file is part of the FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 *
 * ES module: loaded through dynamic import() from FSOffline.js (via FSOffline.connect()).
 *
 * Public entry point that manages the media (image) offline cache (facade
 * pattern). FSOffline provides the generic engine (this module + the
 * media-worker.js service worker + the /MediaCache controller that serves it);
 * each consumer plugin supplies its own configuration through register(), so the
 * same engine works for PortalAgente, ComprasRemotas, etc. without any
 * hard-coded path.
 *
 * The actual request interception lives in the service worker. This module is
 * the page-side half: it registers/unregisters the worker (only on a secure
 * context) and persists each plugin's configuration into IndexedDB, the channel
 * the worker reads from (a service worker is killed and restarted by the browser,
 * so its config cannot live in memory).
 *
 * PHASE 1 (this file): secure-context guard, worker registration/unregistration
 * and config persistence. The worker does not intercept anything yet (phase 2).
 *
 * Exported as a singleton so FSOffline.connect() publishes a single FSOffline.Media.
 */
"use strict";

// IndexedDB location of the per-plugin media config. The phase 2 worker reads
// these same names, so they are part of the contract between both halves.
const CONFIG_DB = 'FSOffline';
const CONFIG_STORE = 'media-config';

class MediaManager {
    constructor() {
        // Injected by FSOffline.connect() (configure()).
        this._resolve = null;     // (db, store) => Promise<OfflineStore>
        this._workerUrl = null;   // absolute URL of the /MediaCache controller
        this._scope = null;       // install-root scope ("/" or "/subdir/")

        // Active ServiceWorkerRegistration once registered.
        this._registration = null;
    }

    /**
     * Injects the runtime context. Called once by FSOffline.connect().
     *
     * @param {object} context
     * @param {function(string, string): Promise<object>} context.storeResolver
     * @param {string} context.workerUrl
     * @param {string} context.scope
     * @returns {MediaManager}
     */
    configure({ storeResolver, workerUrl, scope }) {
        this._resolve = storeResolver;
        this._workerUrl = workerUrl;
        this._scope = scope;
        return this;
    }

    /**
     * True when service workers can actually run: the API exists AND the page is
     * a secure context (HTTPS or localhost). A custom host over plain HTTP (e.g.
     * http://local.fs2025) is NOT secure, so this returns false there.
     *
     * @returns {boolean}
     */
    supported() {
        return typeof navigator !== 'undefined'
            && 'serviceWorker' in navigator
            && typeof window !== 'undefined'
            && window.isSecureContext === true;
    }

    /**
     * Registers the media service worker and persists this plugin's config.
     * Idempotent and safe to call on every page load. A silent no-op (returns
     * null) when the context is not secure, so callers never need to guard.
     *
     * @param {object} [options]
     * @param {string}   [options.id]         Config key; defaults to cacheName.
     * @param {string}   [options.cacheName]  Cache bucket name (phase 2).
     * @param {string[]} [options.patterns]   URL path prefixes to cache (phase 2).
     * @param {number}   [options.ttl]        Freshness in ms (phase 2).
     * @param {string}   [options.fallback]   Fallback image URL (phase 2).
     * @param {number}   [options.maxEntries] Eviction cap (phase 3).
     * @returns {Promise<ServiceWorkerRegistration|null>}
     */
    async register(options = {}) {
        if (!this.supported()) {
            return null;
        }
        this._assertConfigured();

        await this._saveConfig(options);

        try {
            this._registration = await navigator.serviceWorker.register(this._workerUrl, { scope: this._scope });
            this._notifyReload();
            return this._registration;
        } catch (error) {
            return null;
        }
    }

    /**
     * Kill-switch: removes this plugin's config and, when no config remains,
     * unregisters the worker so it stops controlling the pages. Safe to call even
     * if nothing was registered.
     *
     * @param {object} [options]
     * @param {string} [options.id]        Config key to drop; defaults to cacheName.
     * @param {string} [options.cacheName]
     * @returns {Promise<boolean>} True when the worker was unregistered.
     */
    async unregister(options = {}) {
        if (!this.supported()) {
            return false;
        }
        this._assertConfigured();

        await this._deleteConfig(this._configKey(options));

        const remaining = await this._allConfigs();
        if (remaining.length > 0) {
            return false;
        }

        const registrations = await navigator.serviceWorker.getRegistrations();
        let removed = false;
        for (const registration of registrations) {
            if (this._ownsRegistration(registration)) {
                removed = (await registration.unregister()) || removed;
            }
        }
        this._registration = null;
        return removed;
    }

    /* ----------------------------- private ----------------------------- */

    _assertConfigured() {
        if (!this._resolve || !this._workerUrl || !this._scope) {
            throw new Error('FSOffline.Media is not configured. Call FSOffline.connect() first.');
        }
    }

    _configKey(options) {
        return options.id || options.cacheName || 'default';
    }

    async _saveConfig(options) {
        const store = await this._resolve(CONFIG_DB, CONFIG_STORE);
        const key = this._configKey(options);
        return store.set(key, {
            id: key,
            cacheName: options.cacheName || key,
            patterns: Array.isArray(options.patterns) ? options.patterns : [],
            ttl: typeof options.ttl === 'number' ? options.ttl : null,
            fallback: options.fallback || null,
            maxEntries: typeof options.maxEntries === 'number' ? options.maxEntries : null,
            t: Date.now()
        });
    }

    async _deleteConfig(key) {
        const store = await this._resolve(CONFIG_DB, CONFIG_STORE);
        return store.delete(key);
    }

    async _allConfigs() {
        const store = await this._resolve(CONFIG_DB, CONFIG_STORE);
        return store.all();
    }

    _ownsRegistration(registration) {
        const worker = registration.active || registration.waiting || registration.installing;
        return Boolean(worker) && worker.scriptURL === this._workerUrl;
    }

    /**
     * Best-effort nudge so the worker re-reads its config now instead of waiting
     * for its soft refresh. A no-op when no worker is controlling yet (the worker
     * will load the freshly persisted config on its cold start anyway).
     */
    _notifyReload() {
        const worker = (this._registration && this._registration.active) || navigator.serviceWorker.controller;
        if (worker) {
            worker.postMessage({ type: 'fsoffline:media:reload' });
        }
    }
}

export const Media = new MediaManager();
