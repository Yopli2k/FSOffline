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
 *     await FSOffline.use('PortalAgente');
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
     * Future extensions (FSOffline.Cache, FSOffline.Queue, FSOffline.Sync, FSOffline.Connection, ...)
     * can be added as their own ES modules under the FSOffline/ folder
     * and loaded here with dynamic import(), the same way as loadCore() does.
     * They should rely only on the public facade above, keeping
     * the public API stable and the internal classes private.
     */
})(window.FSOffline);
