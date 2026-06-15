/**
 * This file is part of the FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 *
 * ES module: loaded through dynamic import() from FSOffline.js.
 * It pulls its own dependencies (IndexedDBDriver, OfflineStore) with static imports,
 * which resolve relative to this module's URL.
 */
"use strict";

import { IndexedDBDriver } from './IndexedDBDriver.js';
import { OfflineStore } from './OfflineStore.js';

/**
 * Represents a single offline database.
 *
 * Owns one IndexedDBDriver (one physical object store) and creates logical stores
 * on demand.
 */
export class OfflineDatabase {
    // Name of the single physical object store used inside every database.
    static OBJECT_STORE_NAME = 'keyValueStore';

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
