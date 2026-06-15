/**
 * This file is part of the FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 *
 * ES module: loaded only through dynamic import() from FSOffline.js.
 */
"use strict";

/**
 * Low level IndexedDB wrapper.
 *
 * Manages a single connection and a single physical object store. It only knows
 * about physical keys; it has no concept of logical stores.
 */
export class IndexedDBDriver {
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
     * Return the value for indicated key.
     *
     * @param {IDBValidKey} key
     * @returns {Promise<*>}
     */
    get(key) {
        return this.run('readonly', (store) => store.get(key));
    }

    /**
     * Return all stored values.
     *
     * @param {IDBKeyRange} range
     * @returns {Promise<Array>}
     */
    getAll(range) {
        return this.run('readonly', (store) => store.getAll(range));
    }

    /**
     * Saved the data and associated to key.
     *
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
