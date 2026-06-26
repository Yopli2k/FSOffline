/**
 * This file is part of the FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 */
"use strict";

/**
 * FSOffline is a small, reusable facade over IndexedDB.
 *
 * It hides every IndexedDB detail (open, transaction, objectStore, ...) behind a
 * simple model:
 *     Database
 *      └─ Store (logical)
 *          └─ Key => Value
 *
 * This is the ONLY file a consumer plugin needs to load:
 *     AssetManager::add('js', Tools::config('route') . '/Dinamic/Assets/JS/FSOffline.js');
 *
 * The internal classes live in the FSOffline/ folder as ES modules and are loaded lazily.
 *
 * Public API:
 *     await FSOffline.use('MyDatabase');
 *
 *     const products = FSOffline.store('products');
 *     await products.set('REF001', data);
 *     const item = await products.get('REF001');
 *     const all  = await products.all();
 *     await products.delete('REF001');
 *     await products.clear();
 */

// Base URL and version query of THIS script.
// document.currentScript is only available while the script runs synchronously, so we read it now.
// - ASSETS_BASE:
//     resolves the modules regardless of the FacturaScripts installation path (root or subdirectory).
// - VERSION:
//     propagates the cache-busting query (e.g. "?v=...") the consumer used to load this file, so the modules share the same cache lifecycle.
const FS_OFFLINE_BASE = new URL('.', document.currentScript.src).href;
const FS_OFFLINE_VERSION = new URL(document.currentScript.src).search;

// Publish global namespace
window.FSOffline = window.FSOffline || {};

(function (FSOffline) {
    const databases = new Map();       // Cache of opened databases.
    let activeDatabase = null;                  // Currently active database.
    let OfflineDatabase = null;                 // Lazily imported OfflineDatabase class (loaded once).

    /**
     * Loads the internal core modules on first use through dynamic import().
     * OfflineDatabase pulls IndexedDBDriver and OfflineStore via its own static
     * imports, so a single dynamic import bootstraps the whole graph.
     *
     * @returns {Promise<Function>} The OfflineDatabase class.
     */
    async function loadCore() {
        if (!OfflineDatabase) {
            const module = await import(FS_OFFLINE_BASE + 'FSOffline/OfflineDatabase.js' + FS_OFFLINE_VERSION);
            OfflineDatabase = module.OfflineDatabase;
        }
        return OfflineDatabase;
    }

    /**
     * Resolves a logical store for a NAMED database WITHOUT changing the active
     * database. It reuses the same pool of opened databases as use()/store(), so
     * data is shared, but it never touches activeDatabase. This is the primitive
     * FSOffline.Cache and the offline write hook rely on, so several plugins can
     * cache and mutate in parallel safely.
     *
     * @param {string} dbName
     * @param {string} storeName
     * @returns {Promise<object>} An OfflineStore instance.
     */
    async function scopedStore(dbName, storeName) {
        if (!dbName || !storeName) {
            throw new Error('FSOffline: scopedStore() requires a database name and a store name.');
        }

        const DatabaseClass = await loadCore();
        let database = databases.get(dbName);
        if (!database) {
            database = new DatabaseClass(dbName);
            databases.set(dbName, database);
        }

        await database.open();
        return database.store(storeName);
    }

    /**
     * Installation root URL (no trailing slash).
     * FS_OFFLINE_BASE looks like ".../[subdir/]Dinamic/Assets/JS/FSOffline/", so we
     * cut at "/Dinamic/" to get the root. Works whether FacturaScripts lives at the
     * domain root or in a subdirectory.
     *
     * @returns {string}
     */
    function installRoot() {
        const marker = '/Dinamic/';
        const index = FS_OFFLINE_BASE.indexOf(marker);
        return index >= 0 ? FS_OFFLINE_BASE.substring(0, index) : window.location.origin;
    }

    /**
     * Default ping URL for FSOffline.Connection (the AppPing route).
     *
     * @returns {string}
     */
    function defaultPingUrl() {
        return installRoot() + '/AppPing';
    }

    /**
     * Runtime context for FSOffline.Media: the absolute URL of the /MediaCache
     * controller that serves the service worker, and the install-root scope it is
     * registered at ("/" at the domain root, "/subdir/" in a subdirectory). The
     * scope matches the Service-Worker-Allowed header the controller sends.
     *
     * @returns {{workerUrl: string, scope: string}}
     */
    function mediaContext() {
        const root = installRoot();
        return {
            workerUrl: root + '/MediaCache',
            scope: new URL(root + '/').pathname
        };
    }

    /**
     * Selects (and opens, creating it if needed) the active database.
     * Every database name lives as an independent IndexedDB database, so several
     * plugins (PortalAgente, ComprasRemotas, ...) can coexist without collisions.
     *
     * @param {string} databaseName
     * @returns {Promise<object>} The FSOffline facade, to allow chaining.
     */
    FSOffline.use = async function (databaseName) {
        if (!databaseName) {
            throw new Error('FSOffline.use() requires a database name.');
        }

        const DatabaseClass = await loadCore();
        let database = databases.get(databaseName);
        if (!database) {
            database = new DatabaseClass(databaseName);
            databases.set(databaseName, database);
        }

        await database.open();
        activeDatabase = database;
        return FSOffline;
    };

    /**
     * Returns a logical store from the active database.
     * The returned reference can be stored and reused for several operations.
     * It is synchronous: FSOffline.use() must have been awaited first.
     *
     * @param {string} storeName
     * @returns {object} An OfflineStore instance.
     */
    FSOffline.store = function (storeName) {
        if (!activeDatabase) {
            throw new Error('FSOffline: no active database. Call FSOffline.use(name) first.');
        }
        if (!storeName) {
            throw new Error('FSOffline.store() requires a store name.');
        }
        return activeDatabase.store(storeName);
    };

    /**
     * Returns the name of the active database, or null when none is selected.
     *
     * @returns {string|null}
     */
    FSOffline.database = function () {
        return activeDatabase ? activeDatabase.name : null;
    };

    /**
     * Bootstraps the offline layer: loads the Http module (which statically pulls
     * Connection and Cache and re-exports them), publishes the three as
     * FSOffline.Http / FSOffline.Connection / FSOffline.Cache, wires Cache to the
     * store resolver and initializes Connection. Call it once at app startup;
     * afterward everything is available synchronously.
     *
     * A SINGLE dynamic import of Http.js is used on purpose: it guarantees one
     * shared instance of each singleton. Importing Connection.js / Cache.js here
     * with the version query would create duplicate instances, because Http.js
     * imports them statically without the query.
     *
     * @param {object} [options] Connection options (pingUrl, pingTimeout, backoff,
     *                           probeMinGap, failureThreshold, startOnline).
     * @returns {Promise<object>} The FSOffline facade, to allow chaining.
     */
    FSOffline.connect = async function (options = {}) {
        const module = await import(FS_OFFLINE_BASE + 'FSOffline/Http.js' + FS_OFFLINE_VERSION);

        FSOffline.Http = module.Http;
        FSOffline.Connection = module.Connection;
        FSOffline.Cache = module.Cache;

        FSOffline.Cache.configure(scopedStore);
        FSOffline.Connection.init(Object.assign({ pingUrl: defaultPingUrl() }, options));

        // Media (image/static) offline cache facade. Loaded as its own singleton;
        // nothing else imports Media.js, so there is no duplicate-instance risk.
        // Publishing it here only makes FSOffline.Media available: no service
        // worker is registered until a consumer calls FSOffline.Media.register().
        const mediaModule = await import(FS_OFFLINE_BASE + 'FSOffline/Media.js' + FS_OFFLINE_VERSION);
        FSOffline.Media = mediaModule.Media;

        const media = mediaContext();
        FSOffline.Media.configure({ storeResolver: scopedStore, workerUrl: media.workerUrl, scope: media.scope });

        // Sync (offline write queue): resends queued writes on reconnect and lets the
        // consumer reconcile. Loaded as its own singleton; nothing else imports
        // Sync.js, so there is no duplicate-instance risk. The shared Http/Connection
        // singletons and the store resolver are INJECTED (not imported) on purpose,
        // for the same reason noted above. No queue is touched until a consumer calls
        // FSOffline.Sync.register().
        const syncModule = await import(FS_OFFLINE_BASE + 'FSOffline/Sync.js' + FS_OFFLINE_VERSION);
        FSOffline.Sync = syncModule.Sync;
        FSOffline.Sync.configure({
            storeResolver: scopedStore,
            http: FSOffline.Http,
            connection: FSOffline.Connection
        });
        return FSOffline;
    };

    /**
     * Future extensions can be added as their own ES modules under the FSOffline/
     * folder and loaded here with dynamic import(), the same way as loadCore() and
     * connect() do. They should rely only on the public facade above, keeping the
     * public API stable and the internal classes private.
     */
})(window.FSOffline);
