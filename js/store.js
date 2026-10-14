// Tiny IndexedDB key/value store. Takes and lyrics stay on this machine only.
const DB = "mv-booth";
const STORE = "kv";

let dbPromise = null;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn("storage unavailable", err);
    return undefined;
  }
}

export const get = (key) => run("readonly", (s) => s.get(key));
export const set = (key, value) => run("readwrite", (s) => s.put(value, key));
export const del = (key) => run("readwrite", (s) => s.delete(key));
