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
 *
 *     Database
 *      └─ Store (logical)
 *          └─ Key => Value
 *
 * Public API:
 *
 *     await FSOffline.use('PortalAgente');
 *
 *     const products = FSOffline.store('products');
 *     await products.set('REF001', data);
 *     const item = await products.get('REF001');
 *     const all  = await products.all();
 *     await products.delete('REF001');
 *     await products.clear();
 *
 * Design notes:
 *  - Every database name maps to its own IndexedDB database.
 *  - Each IndexedDB database uses a SINGLE physical object store. Logical stores
 *    are emulated through composite keys ("storeName:key"). This avoids dynamic
 *    object store creation and the IndexedDB versioning / migration problems
 *    that come with it.
 *  - All public methods are asynchronous and return Promises.
 */
window.FSOffline = window.FSOffline || {};

(function (FSOffline) {

    /**
     * Low level IndexedDB wrapper.
     *
     * Manages a single connection and a single physical object store. It only
     * knows about physical keys; it has no concept of logical stores.
     */
    class IndexedDBDriver {

        /**
         * @param {string} databaseName - Name of the IndexedDB database.
         * @param {string} objectStoreName - Name of the single physical object store.
         */
        constructor(databaseName, objectStoreName) {
            this.databaseName = databaseName;
            this.objectStoreName = objectStoreName;
            this.connection = null;
            this.openPromise = null;
        }

        /**
         * Opens (or reuses) the database connection.
         *
         * @returns {Promise<IDBDatabase>}
         */
        open() {
            if (this.connection) {
                return Promise.resolve(this.connection);
            }
            if (this.openPromise) {
                return this.openPromise;
            }

            this.openPromise = new Promise((resolve, reject) => {
                const request = indexedDB.open(this.databaseName, 1);

                // Create the single physical object store on first use.
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (false === db.objectStoreNames.contains(this.objectStoreName)) {
                        db.createObjectStore(this.objectStoreName);
                    }
                };

                request.onsuccess = (event) => {
                    this.connection = event.target.result;
                    resolve(this.connection);
                };

                request.onerror = (event) => reject(event.target.error);
                request.onblocked = () => reject(new Error('FSOffline: database "' + this.databaseName + '" is blocked.'));
            });

            return this.openPromise;
        }

        /**
         * Runs a callback inside a transaction and resolves with the request result.
         *
         * @param {string} mode - "readonly" or "readwrite".
         * @param {function(IDBObjectStore): (IDBRequest|null)} callback
         * @returns {Promise<*>}
         */
        async run(mode, callback) {
            const db = await this.open();

            return new Promise((resolve, reject) => {
                const transaction = db.transaction(this.objectStoreName, mode);
                const store = transaction.objectStore(this.objectStoreName);
                const request = callback(store);

                let result;
                if (request) {
                    request.onsuccess = () => {
                        result = request.result;
                    };
                    request.onerror = () => reject(request.error);
                }

                transaction.oncomplete = () => resolve(result);
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error);
            });
        }

        /**
         * @param {IDBValidKey} key
         * @returns {Promise<*>}
         */
        get(key) {
            return this.run('readonly', (store) => store.get(key));
        }

        /**
         * @param {IDBKeyRange} range
         * @returns {Promise<Array>}
         */
        getAll(range) {
            return this.run('readonly', (store) => store.getAll(range));
        }

        /**
         * @param {IDBValidKey} key
         * @param {*} value
         * @returns {Promise<void>}
         */
        put(key, value) {
            return this.run('readwrite', (store) => store.put(value, key));
        }

        /**
         * Deletes a single key or every key inside a key range.
         *
         * @param {IDBValidKey|IDBKeyRange} keyOrRange
         * @returns {Promise<void>}
         */
        delete(keyOrRange) {
            return this.run('readwrite', (store) => store.delete(keyOrRange));
        }
    }

    /**
     * A logical store inside a database.
     *
     * It maps logical keys to physical composite keys ("name:key") and exposes
     * the simple key/value operations the public API offers.
     */
    class OfflineStore {

        /**
         * @param {IndexedDBDriver} driver
         * @param {string} name - Logical store name.
         */
        constructor(driver, name) {
            this.driver = driver;
            this.name = name;
            this.separator = ':';
        }

        /**
         * Builds the physical composite key for a logical key.
         *
         * @param {string|number} key
         * @returns {string}
         */
        physicalKey(key) {
            return this.name + this.separator + key;
        }

        /**
         * Builds the key range that matches every physical key belonging to this
         * logical store ("name:" prefix).
         *
         * @returns {IDBKeyRange}
         */
        keyRange() {
            const prefix = this.name + this.separator;
            return IDBKeyRange.bound(prefix, prefix + '￿', false, false);
        }

        /**
         * Returns the value stored under a key, or null when it does not exist.
         *
         * @param {string|number} key
         * @returns {Promise<*>}
         */
        async get(key) {
            const value = await this.driver.get(this.physicalKey(key));
            return value === undefined ? null : value;
        }

        /**
         * Stores a value under a key. Returns the stored value.
         *
         * @param {string|number} key
         * @param {*} value
         * @returns {Promise<*>}
         */
        async set(key, value) {
            await this.driver.put(this.physicalKey(key), value);
            return value;
        }

        /**
         * Deletes a single key.
         *
         * @param {string|number} key
         * @returns {Promise<void>}
         */
        async delete(key) {
            return this.driver.delete(this.physicalKey(key));
        }

        /**
         * Returns every value stored in this logical store.
         *
         * @returns {Promise<Array>}
         */
        async all() {
            return this.driver.getAll(this.keyRange());
        }

        /**
         * Removes every value of this logical store, leaving other stores intact.
         *
         * @returns {Promise<void>}
         */
        async clear() {
            return this.driver.delete(this.keyRange());
        }
    }

    /**
     * Represents a single offline database.
     *
     * Owns one IndexedDBDriver (one physical object store) and creates logical
     * stores on demand.
     */
    class OfflineDatabase {

        /**
         * @param {string} name
         */
        constructor(name) {
            this.name = name;
            this.driver = new IndexedDBDriver(name, OfflineDatabase.OBJECT_STORE_NAME);
        }

        /**
         * Opens the underlying connection.
         *
         * @returns {Promise<IDBDatabase>}
         */
        open() {
            return this.driver.open();
        }

        /**
         * Returns a logical store bound to this database.
         *
         * @param {string} storeName
         * @returns {OfflineStore}
         */
        store(storeName) {
            return new OfflineStore(this.driver, storeName);
        }
    }

    // Name of the single physical object store used inside every database.
    OfflineDatabase.OBJECT_STORE_NAME = 'keyValueStore';

    // Cache of opened databases, keyed by database name.
    const databases = new Map();

    // Currently active database, selected through FSOffline.use().
    let activeDatabase = null;

    /**
     * Selects (and opens, creating it if needed) the active database.
     *
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

        let database = databases.get(databaseName);
        if (!database) {
            database = new OfflineDatabase(databaseName);
            databases.set(databaseName, database);
        }

        await database.open();
        activeDatabase = database;
        return FSOffline;
    };

    /**
     * Returns a logical store from the active database.
     *
     * The returned reference can be stored and reused for several operations.
     *
     * @param {string} storeName
     * @returns {OfflineStore}
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
     * Future extensions (FSOffline.Cache, FSOffline.Queue, FSOffline.Sync,
     * FSOffline.Connection, ...) can be attached to this same FSOffline object
     * in separate files. They may reuse the public facade above without touching
     * the private classes, keeping the public API stable.
     */

})(window.FSOffline);
