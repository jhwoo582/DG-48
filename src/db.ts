import type { Project } from './types';

/** IndexedDB: 샘플 PCM 원본과 프로젝트 JSON을 브라우저에 저장 */
const DB_NAME = 'sampler-ex';
const DB_VERSION = 1;

export interface StoredSample {
  name: string;
  sampleRate: number;
  channels: Float32Array[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('samples');
        db.createObjectStore('project');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  getProject: () => run<Project | undefined>('project', 'readonly', (s) => s.get('current')),
  putProject: (p: Project) => run<void>('project', 'readwrite', (s) => s.put(p, 'current')),
  getSample: (id: string) => run<StoredSample | undefined>('samples', 'readonly', (s) => s.get(id)),
  putSample: (id: string, v: StoredSample) => run<void>('samples', 'readwrite', (s) => s.put(v, id)),
  deleteSample: (id: string) => run<void>('samples', 'readwrite', (s) => s.delete(id)),
  sampleKeys: () => run<IDBValidKey[]>('samples', 'readonly', (s) => s.getAllKeys()),
};
