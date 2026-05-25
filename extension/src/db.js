// db.js — IndexedDB wrapper for StepCast
// Used by the background worker, the content script (indirectly through
// messages), and the editor page.
//
// Object stores:
//   recordings — { id, title, created_at, duration_ms, url_origin,
//                  step_ids, video_blob_id, source }
//   steps      — { id, recording_id, group_id, order_in_group,
//                  click, screenshot_blob_id, video_timestamp_ms,
//                  ai_title, ai_description, user_title, user_description,
//                  created_at }
//   blobs      — { id, type, data }   // type: 'screenshot' | 'video'

const DB_NAME = 'stepcast';
const DB_VERSION = 1;

let _dbPromise = null;

export function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('recordings')) {
        const s = db.createObjectStore('recordings', { keyPath: 'id' });
        s.createIndex('created_at', 'created_at');
      }
      if (!db.objectStoreNames.contains('steps')) {
        const s = db.createObjectStore('steps', { keyPath: 'id' });
        s.createIndex('recording_id', 'recording_id');
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function tx(store, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(store, mode).objectStore(store);
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- Recordings ----

export async function putRecording(rec) {
  return reqAsPromise((await tx('recordings', 'readwrite')).put(rec));
}

export async function getRecording(id) {
  return reqAsPromise((await tx('recordings')).get(id));
}

export async function listRecordings() {
  const store = await tx('recordings');
  return new Promise((resolve, reject) => {
    const results = [];
    const req = store.index('created_at').openCursor(null, 'prev');
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteRecording(id) {
  const rec = await getRecording(id);
  if (!rec) return;
  // Delete associated steps and blobs first
  for (const step_id of rec.step_ids) {
    const step = await getStep(step_id);
    if (step) {
      await deleteBlob(step.screenshot_blob_id);
      await deleteStep(step_id);
    }
  }
  if (rec.video_blob_id) await deleteBlob(rec.video_blob_id);
  return reqAsPromise((await tx('recordings', 'readwrite')).delete(id));
}

// ---- Steps ----

export async function putStep(step) {
  return reqAsPromise((await tx('steps', 'readwrite')).put(step));
}

export async function getStep(id) {
  return reqAsPromise((await tx('steps')).get(id));
}

export async function getStepsForRecording(recording_id) {
  const store = await tx('steps');
  return new Promise((resolve, reject) => {
    const results = [];
    const req = store.index('recording_id').openCursor(IDBKeyRange.only(recording_id));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteStep(id) {
  return reqAsPromise((await tx('steps', 'readwrite')).delete(id));
}

// ---- Blobs ----

export async function putBlob(id, type, data) {
  return reqAsPromise((await tx('blobs', 'readwrite')).put({ id, type, data }));
}

export async function getBlob(id) {
  const result = await reqAsPromise((await tx('blobs')).get(id));
  return result ? result.data : null;
}

export async function deleteBlob(id) {
  return reqAsPromise((await tx('blobs', 'readwrite')).delete(id));
}

// ---- Utility ----

export function uuid() {
  return crypto.randomUUID();
}
