// Per-transcript memory (position, settings, fixes, paired video) in IndexedDB. The database name
// carries the app's prefix because every GitHub Pages project of an account shares one origin.
const DB_NAME = "lecture-karaoke", STORE = "transcripts";
let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function load(id) {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const req = d.transaction(STORE).objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || {});
      req.onerror = () => resolve({});
    });
  } catch {
    return {};
  }
}

export async function save(id, record) {
  try {
    const d = await db();
    await new Promise((resolve) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record, id);
      tx.oncomplete = tx.onerror = tx.onabort = resolve;
    });
  } catch {
    /* storage unavailable (private mode): the app still works, it just won't remember */
  }
}
