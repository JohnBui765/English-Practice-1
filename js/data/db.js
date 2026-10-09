// Minimal promise wrapper around IndexedDB, with an in-memory fallback for
// browsers/modes where IndexedDB is unavailable (data then lasts one session).

const DB_NAME = 'vocab-studio';
const VERSION = 1;

export const STORES = {
  lists: { keyPath: 'id' },
  progress: { keyPath: 'itemId', indexes: [['listId', 'listId']] },
  settings: { keyPath: 'key' },
  history: { autoIncrement: true, keyPath: 'id', indexes: [['listId', 'listId'], ['at', 'at']] },
};

let dbPromise = null;
let memory = null; // Map<storeName, Map<key, value>> when IndexedDB is unavailable

const reqToPromise = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const store = db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: !!def.autoIncrement });
        for (const [indexName, keyPath] of def.indexes || []) store.createIndex(indexName, keyPath);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgraded the schema: close so it can proceed, and open
      // again on the next call. WebKit can also drop the connection while the
      // app is in the background ("Connection to Indexed Database server lost").
      db.onversionchange = () => {
        db.close();
        forget(db);
      };
      db.onclose = () => forget(db);
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

let current = null; // the open IDBDatabase
let opened = false; // IndexedDB worked once: a later failure is an error, not a switch to memory

function forget(db) {
  if (current === db) {
    current = null;
    dbPromise = null;
  }
}

export function open() {
  if (!dbPromise) {
    if (memory) return Promise.resolve(null);
    const attempt = typeof indexedDB === 'undefined' ? Promise.reject(new Error('no indexedDB')) : openIndexedDB();
    dbPromise = attempt.then(
      (db) => {
        opened = true;
        current = db;
        return db;
      },
      (err) => {
        if (opened) {
          dbPromise = null;
          throw err;
        }
        console.warn('IndexedDB unavailable, using memory storage', err);
        memory = new Map(Object.keys(STORES).map((n) => [n, new Map()]));
        return null;
      },
    );
  }
  return dbPromise;
}

export function isPersistentStorage() {
  return memory === null;
}

// Errors that mean the connection is gone (closed, or lost by WebKit).
const DEAD = new Set(['InvalidStateError', 'UnknownError', 'TransactionInactiveError']);

// Runs fn(db) — db is null in memory mode — and retries once on a fresh
// connection if the cached one has died.
async function withDb(fn) {
  const db = await open();
  try {
    return await fn(db);
  } catch (err) {
    if (!db || !DEAD.has(err?.name)) throw err;
    forget(db);
    return fn(await open());
  }
}

let memCounter = 1;

function memKey(store, value) {
  const def = STORES[store];
  if (def.autoIncrement && value[def.keyPath] === undefined) value[def.keyPath] = memCounter++;
  return value[def.keyPath];
}

const clone = (v) => (v === undefined ? v : structuredClone(v));

const memPut = (store, value) => {
  const v = clone(value);
  memory.get(store).set(memKey(store, v), v);
  return v[STORES[store].keyPath];
};

export function get(store, key) {
  return withDb((db) => {
    if (!db) return clone(memory.get(store).get(key));
    return reqToPromise(db.transaction(store).objectStore(store).get(key));
  });
}

export function getAll(store, { index, query } = {}) {
  return withDb((db) => {
    if (!db) {
      const values = [...memory.get(store).values()].map(clone);
      if (!index) return values;
      return values.filter((v) => v[index] === query);
    }
    const os = db.transaction(store).objectStore(store);
    const src = index ? os.index(index) : os;
    return reqToPromise(src.getAll(query === undefined ? undefined : IDBKeyRange.only(query)));
  });
}

export function put(store, value) {
  return withDb((db) => {
    if (!db) return memPut(store, value);
    return runTx(db, [store], 'readwrite', (tx) => tx.objectStore(store).put(value));
  });
}

export function putMany(store, values) {
  return withDb(async (db) => {
    if (!db) {
      for (const value of values) memPut(store, value);
      return;
    }
    await runTx(db, [store], 'readwrite', (tx) => {
      const os = tx.objectStore(store);
      values.forEach((v) => os.put(v));
    });
  });
}

export function del(store, key) {
  return withDb(async (db) => {
    if (!db) {
      memory.get(store).delete(key);
      return;
    }
    await runTx(db, [store], 'readwrite', (tx) => tx.objectStore(store).delete(key));
  });
}

export function delWhere(store, index, query) {
  return withDb(async (db) => {
    if (!db) {
      const map = memory.get(store);
      for (const [k, v] of map) if (v[index] === query) map.delete(k);
      return;
    }
    await runTx(db, [store], 'readwrite', (tx) => {
      const req = tx.objectStore(store).index(index).openKeyCursor(IDBKeyRange.only(query));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        tx.objectStore(store).delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  });
}

export function clearStore(store) {
  return withDb(async (db) => {
    if (!db) {
      memory.get(store).clear();
      return;
    }
    await runTx(db, [store], 'readwrite', (tx) => tx.objectStore(store).clear());
  });
}

// Replaces the contents of several stores in ONE transaction, so a restore is
// all-or-nothing. `replace`: { storeName: values[] } — cleared first;
// `add`: { storeName: values[] } — put without clearing.
export function replaceAll(replace, add = {}) {
  const stores = [...new Set([...Object.keys(replace), ...Object.keys(add)])];
  return withDb(async (db) => {
    if (!db) {
      for (const [store, values] of Object.entries(replace)) {
        memory.get(store).clear();
        values.forEach((v) => memPut(store, v));
      }
      for (const [store, values] of Object.entries(add)) values.forEach((v) => memPut(store, v));
      return;
    }
    await runTx(db, stores, 'readwrite', (tx) => {
      for (const [store, values] of Object.entries(replace)) {
        const os = tx.objectStore(store);
        os.clear();
        values.forEach((v) => os.put(v));
      }
      for (const [store, values] of Object.entries(add)) {
        const os = tx.objectStore(store);
        values.forEach((v) => os.put(v));
      }
    });
  });
}

// Runs fn(tx) and resolves with the result of fn's request (if any) once the
// transaction has committed. A synchronous throw (db.transaction() on a
// closed connection) becomes a rejection.
function runTx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    const req = fn(tx);
    if (req && 'onsuccess' in req) req.onsuccess = () => (result = req.result);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}
