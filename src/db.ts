// IndexedDB 持久化:项目、方案、材料、任务、仿真结果(二进制)
import { Project, Scheme, Material, SimTask, SimResult, Settings, DEFAULT_SETTINGS } from './types.js';

const DB_NAME = 'moldfill-sim';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('schemes')) {
        const s = db.createObjectStore('schemes', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('materials')) db.createObjectStore('materials', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('results')) db.createObjectStore('results', { keyPath: 'paramHash' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAll<T>(store: string): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readonly');
    const req = t.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  // 项目
  listProjects: () => getAll<Project>('projects'),
  putProject: (p: Project) => tx('projects', 'readwrite', s => s.put(p)),
  deleteProject: async (id: string) => {
    await tx('projects', 'readwrite', s => s.delete(id));
    const schemes = await getAll<Scheme>('schemes');
    for (const sc of schemes.filter(x => x.projectId === id)) {
      await tx('schemes', 'readwrite', s => s.delete(sc.id));
    }
    const tasks = await getAll<SimTask>('tasks');
    for (const t of tasks.filter(x => x.projectId === id)) {
      await tx('tasks', 'readwrite', s => s.delete(t.id));
    }
  },
  // 方案
  listSchemes: () => getAll<Scheme>('schemes'),
  getScheme: (id: string) => tx<Scheme | undefined>('schemes', 'readonly', s => s.get(id) as IDBRequest<Scheme | undefined>),
  putScheme: (s: Scheme) => tx('schemes', 'readwrite', st => st.put(s)),
  deleteScheme: (id: string) => tx('schemes', 'readwrite', s => s.delete(id)),
  // 材料
  listMaterials: () => getAll<Material>('materials'),
  putMaterial: (m: Material) => tx('materials', 'readwrite', s => s.put(m)),
  deleteMaterial: (id: string) => tx('materials', 'readwrite', s => s.delete(id)),
  // 任务
  listTasks: () => getAll<SimTask>('tasks'),
  putTask: (t: SimTask) => tx('tasks', 'readwrite', s => s.put(t)),
  deleteTask: (id: string) => tx('tasks', 'readwrite', s => s.delete(id)),
  // 结果缓存
  getResult: (hash: string) => tx<SimResult | undefined>('results', 'readonly', s => s.get(hash) as IDBRequest<SimResult | undefined>),
  putResult: (r: SimResult) => tx('results', 'readwrite', s => s.put(r)),
  // 设置
  async getSettings(): Promise<Settings> {
    const v = await tx<Settings | undefined>('kv', 'readonly', s => s.get('settings') as IDBRequest<Settings | undefined>);
    return { ...DEFAULT_SETTINGS, ...(v ?? {}) };
  },
  putSettings: (s: Settings) => tx('kv', 'readwrite', st => st.put(s, 'settings')),
};
