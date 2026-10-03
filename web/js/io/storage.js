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
  /**
   * Writes a complete autosave in one transaction: the project, the media records that
   * changed and the removal of media no longer referenced. If anything fails (for example
   * the storage quota) nothing is written and the previous complete autosave is kept.
   */
  async saveSnapshot(projectJson, mediaPuts, keepIds) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(['kv', 'media'], 'readwrite');
      const kv = t.objectStore('kv');
      const media = t.objectStore('media');
      kv.put(projectJson, 'project');
      for (const { id, record } of mediaPuts) media.put(record, id);
      const keysReq = media.getAllKeys();
      keysReq.onsuccess = () => {
        for (const key of keysReq.result) if (!keepIds.has(key)) media.delete(key);
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('aborted'));
    });
  },
  async get(key) {
    return tx('kv', 'readonly', (s) => reqP(s.get(key)));
  },
  async getMedia(id) {
    return tx('media', 'readonly', (s) => reqP(s.get(id)));
  },
  async requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
    } catch { /* ignore */ }
    return false;
  },
};
