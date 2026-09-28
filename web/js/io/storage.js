/*
 * MapMap Web - local persistence (IndexedDB): autosaved project and its media files.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

const DB_NAME = 'mapmap-web';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('no-indexeddb')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const storage = {
  async get(key) {
    return tx('kv', 'readonly', (s) => reqP(s.get(key)));
  },
  async set(key, value) {
    return tx('kv', 'readwrite', (s) => { s.put(value, key); });
  },
  async putMedia(id, record) {
    return tx('media', 'readwrite', (s) => { s.put(record, id); });
  },
  async getMedia(id) {
    return tx('media', 'readonly', (s) => reqP(s.get(id)));
  },
  async deleteMedia(id) {
    return tx('media', 'readwrite', (s) => { s.delete(id); });
  },
  async mediaKeys() {
    return tx('media', 'readonly', (s) => reqP(s.getAllKeys()));
  },
  async clearMedia() {
    return tx('media', 'readwrite', (s) => { s.clear(); });
  },
  async requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
    } catch { /* ignore */ }
    return false;
  },
};
