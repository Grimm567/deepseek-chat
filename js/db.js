// 会话存储：IndexedDB，纯本地

const DB_NAME = 'deepseek-chat';
const DB_VERSION = 1;
const STORE = 'sessions';
const META = 'meta';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持 IndexedDB'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开数据库失败'));
  });
  return dbPromise;
}

async function store(name, mode) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listSessions() {
  const s = await store(STORE, 'readonly');
  const all = await wrap(s.getAll());
  return all.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export async function getSession(id) {
  const s = await store(STORE, 'readonly');
  return wrap(s.get(id));
}

export async function putSession(session) {
  const s = await store(STORE, 'readwrite');
  await wrap(s.put(session));
  return session;
}

export async function deleteSession(id) {
  const s = await store(STORE, 'readwrite');
  await wrap(s.delete(id));
}

export async function clearSessions() {
  const s = await store(STORE, 'readwrite');
  await wrap(s.clear());
}

export async function getMeta(key) {
  const s = await store(META, 'readonly');
  const row = await wrap(s.get(key));
  return row ? row.value : undefined;
}

export async function setMeta(key, value) {
  const s = await store(META, 'readwrite');
  await wrap(s.put({ key, value }));
}

export function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
