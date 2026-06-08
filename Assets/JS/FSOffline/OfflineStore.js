/**
 * This file is part of the FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 *
 * ES module: loaded only through dynamic import(). It is never exposed on the
 * global object.
 */
"use strict";

/**
 * A logical store inside a database.
 *
 * It maps logical keys to physical composite keys ("name:key") and exposes the
 * simple key/value operations the public API offers. Several logical stores share
 * a single physical object store, so no dynamic object store creation (and no
 * IndexedDB versioning / migration) is ever needed.
 */
export class OfflineStore {

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
