// IndexedDB 轻封装：所有项目数据仅存本地浏览器
import type { AppSettings, Material, Project, SimResult, SimTask, Scheme } from './types';

const DB_NAME = 'injection-mold-sim-db';
const DB_VERSION = 1;

export type StoreName = 'projects' | 'schemes' | 'materials' | 'results' | 'tasks' | 'settings' | 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const stores: StoreName[] = ['projects', 'schemes', 'materials', 'results', 'tasks', 'settings', 'meta'];
      for (const name of stores) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbPut<T>(store: StoreName, key: string, value: T): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(value, key));
}

export async function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key));
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll());
}

export async function idbGetAllKeys(store: StoreName): Promise<string[]> {
  return tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()).then((keys) => keys.map(String));
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(key));
}

export async function idbClear(store: StoreName): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear());
}

export async function idbBulkPut<T extends { id?: string }>(store: StoreName, entries: [string, T][]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const [key, value] of entries) s.put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---- 业务级快捷方法 ----

export const db = {
  // 项目
  listProjects: () => idbGetAll<Project>('projects'),
  putProject: (p: Project) => idbPut('projects', p.id, p),
  deleteProject: (id: string) => idbDelete('projects', id),

  // 方案
  listSchemes: () => idbGetAll<Scheme>('schemes'),
  getScheme: (id: string) => idbGet<Scheme>('schemes', id),
  putScheme: (s: Scheme) => idbPut('schemes', s.id, s),
  deleteScheme: (id: string) => idbDelete('schemes', id),

  // 材料
  listMaterials: () => idbGetAll<Material>('materials'),
  putMaterial: (m: Material) => idbPut('materials', m.id, m),
  deleteMaterial: (id: string) => idbDelete('materials', id),

  // 结果缓存
  listResults: () => idbGetAll<SimResult>('results'),
  getResult: (id: string) => idbGet<SimResult>('results', id),
  putResult: (r: SimResult) => idbPut('results', r.id, r),
  deleteResult: (id: string) => idbDelete('results', id),

  // 任务
  listTasks: () => idbGetAll<SimTask>('tasks'),
  putTask: (t: SimTask) => idbPut('tasks', t.id, t),
  deleteTask: (id: string) => idbDelete('tasks', id),

  // 设置（单例）
  getSettings: () => idbGet<AppSettings>('settings', 'app'),
  putSettings: (s: AppSettings) => idbPut('settings', 'app', s),

  // 元信息
  getMeta: (key: string) => idbGet<unknown>('meta', key),
  putMeta: (key: string, value: unknown) => idbPut('meta', key, value),
};
