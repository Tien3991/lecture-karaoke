// On-device memory in IndexedDB. The database name carries the app's prefix because every GitHub
// Pages project of an account shares one origin.
//   transcripts: per transcript id: position, sync, language, fixes and the ones not yet on
//                GitHub, the paired video (name, size, fingerprint), title, last opened
//   files:       copies of transcripts (from GitHub with their ETag, or picked on this device),
//                so a lecture reopens offline and without re-downloading
const DB_NAME = "lecture-karaoke", RECORDS = "transcripts", FILES = "files";
let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const name of [RECORDS, FILES]) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn, fallback) {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      if (mode === "readonly") {
        req.onsuccess = () => resolve(req.result ?? fallback);
        req.onerror = () => resolve(fallback);
      } else {
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve(undefined);
      }
    });
  } catch {
    return fallback;   // storage unavailable (private mode): the app still works, it just won't remember
  }
}

export const load = (id) => run(RECORDS, "readonly", (s) => s.get(id), {});
export const save = (id, record) => run(RECORDS, "readwrite", (s) => s.put(record, id));
/** Every record with its id, for the list of recent lectures. */
export async function list() {
  const [keys, values] = await Promise.all([run(RECORDS, "readonly", (s) => s.getAllKeys(), []),
    run(RECORDS, "readonly", (s) => s.getAll(), [])]);
  return keys.map((id, i) => ({ id, ...values[i] }));
}
export const getFile = (key) => run(FILES, "readonly", (s) => s.get(key), null);
export const putFile = (key, value) => run(FILES, "readwrite", (s) => s.put(value, key));
