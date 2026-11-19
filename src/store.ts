// 应用状态中枢:数据加载、自动保存、撤销重做、任务队列、结果缓存
import { Project, Scheme, Material, SimTask, SimResult, Settings, MeshData, ModelSource, MeshCheckResult } from './types.js';
import { db } from './db.js';
import { DEFAULT_MATERIALS } from './materials.js';
import { uid, paramHash, base64Decode } from './util.js';
import { parseSTL, getBuiltin, checkMesh } from './geometry.js';
import { computeParamHash } from './solver.js';
import type { MeshWorkerResponse } from './workers/mesh.worker.js';
import type { SolverWorkerResponse } from './workers/solver.worker.js';

type Listener = () => void;

class Store {
  projects: Project[] = [];
  schemes: Scheme[] = [];
  materials: Material[] = [];
  tasks: SimTask[] = [];
  settings!: Settings;
  private listeners = new Set<Listener>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private meshCache = new Map<string, { mesh: MeshData; check: MeshCheckResult }>();
  private baseMeshCache = new Map<string, MeshData>();
  private runningWorker: { taskId: string; worker: Worker } | null = null;
  private undoStack = new Map<string, string[]>();
  private redoStack = new Map<string, string[]>();

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(): void { this.listeners.forEach(f => f()); }

  async init(): Promise<void> {
    this.settings = await db.getSettings();
    this.materials = await db.listMaterials();
    if (this.materials.length === 0) {
      for (const m of DEFAULT_MATERIALS) await db.putMaterial(m);
      this.materials = await db.listMaterials();
    }
    this.projects = await db.listProjects();
    this.schemes = await db.listSchemes();
    this.tasks = (await db.listTasks()).sort((a, b) => b.createdAt - a.createdAt);
    // 上次会话遗留的运行中任务标记为失败
    for (const t of this.tasks) {
      if (t.status === 'running' || t.status === 'meshing' || t.status === 'queued') {
        t.status = 'failed';
        t.error = '页面刷新导致任务中断';
        await db.putTask(t);
      }
    }
  }

  // ---------- 自动保存(防抖) ----------
  private autosave(key: string, fn: () => Promise<void>): void {
    const old = this.saveTimers.get(key);
    if (old) clearTimeout(old);
    this.saveTimers.set(key, setTimeout(() => { void fn(); }, 400));
  }

  // ---------- 项目 ----------
  async createProject(name: string): Promise<Project> {
    const p: Project = { id: uid('p'), name, createdAt: Date.now(), updatedAt: Date.now() };
    this.projects.push(p);
    await db.putProject(p);
    this.emit();
    return p;
  }
  async deleteProject(id: string): Promise<void> {
    this.projects = this.projects.filter(p => p.id !== id);
    this.schemes = this.schemes.filter(s => s.projectId !== id);
    this.tasks = this.tasks.filter(t => t.projectId !== id);
    await db.deleteProject(id);
    this.emit();
  }

  // ---------- 方案 ----------
  schemesOf(projectId: string): Scheme[] {
    return this.schemes.filter(s => s.projectId === projectId);
  }
  async createScheme(projectId: string, name: string, model: ModelSource): Promise<Scheme> {
    const mat = this.materials[0];
    const s: Scheme = {
      id: uid('s'), projectId, name, model,
      meshLevel: this.settings.meshLevel,
      gates: [],
      materialId: mat?.id ?? '',
      process: {
        meltTemp: mat?.defaultMeltTemp ?? 240,
        moldTemp: mat?.defaultMoldTemp ?? 60,
        flowRate: 30,
        pressureLimit: 120,
        thickness: 1.5,
      },
      updatedAt: Date.now(),
    };
    this.schemes.push(s);
    await db.putScheme(s);
    this.emit();
    return s;
  }
  async duplicateScheme(id: string): Promise<Scheme | null> {
    const src = this.schemes.find(s => s.id === id);
    if (!src) return null;
    const copy: Scheme = JSON.parse(JSON.stringify(src));
    copy.id = uid('s');
    copy.name = src.name + ' 副本';
    copy.updatedAt = Date.now();
    this.schemes.push(copy);
    await db.putScheme(copy);
    this.emit();
    return copy;
  }
  async deleteScheme(id: string): Promise<void> {
    this.schemes = this.schemes.filter(s => s.id !== id);
    await db.deleteScheme(id);
    this.emit();
  }

  // ---------- 撤销 / 重做(方案级快照) ----------
  snapshot(schemeId: string): void {
    const s = this.schemes.find(x => x.id === schemeId);
    if (!s) return;
    if (!this.undoStack.has(schemeId)) this.undoStack.set(schemeId, []);
    this.undoStack.get(schemeId)!.push(JSON.stringify(s));
    if (this.undoStack.get(schemeId)!.length > 50) this.undoStack.get(schemeId)!.shift();
    this.redoStack.set(schemeId, []);
  }
  undo(schemeId: string): boolean {
    const stack = this.undoStack.get(schemeId);
    if (!stack || stack.length === 0) return false;
    const cur = this.schemes.find(x => x.id === schemeId);
    if (!cur) return false;
    if (!this.redoStack.has(schemeId)) this.redoStack.set(schemeId, []);
    this.redoStack.get(schemeId)!.push(JSON.stringify(cur));
    const prev: Scheme = JSON.parse(stack.pop()!);
    Object.assign(cur, prev);
    this.saveScheme(cur);
    return true;
  }
  redo(schemeId: string): boolean {
    const stack = this.redoStack.get(schemeId);
    if (!stack || stack.length === 0) return false;
    const cur = this.schemes.find(x => x.id === schemeId);
    if (!cur) return false;
    this.undoStack.get(schemeId)!.push(JSON.stringify(cur));
    const next: Scheme = JSON.parse(stack.pop()!);
    Object.assign(cur, next);
    this.saveScheme(cur);
    return true;
  }
  canUndo(id: string): boolean { return (this.undoStack.get(id)?.length ?? 0) > 0; }
  canRedo(id: string): boolean { return (this.redoStack.get(id)?.length ?? 0) > 0; }

  /** 修改方案并自动保存 */
  saveScheme(s: Scheme): void {
    s.updatedAt = Date.now();
    this.autosave('scheme:' + s.id, () => db.putScheme(s).then(() => undefined));
    this.emit();
  }

  // ---------- 材料 ----------
  async saveMaterial(m: Material): Promise<void> {
    const i = this.materials.findIndex(x => x.id === m.id);
    if (i >= 0) this.materials[i] = m; else this.materials.push(m);
    await db.putMaterial(m);
    this.emit();
  }
  async deleteMaterial(id: string): Promise<void> {
    this.materials = this.materials.filter(m => m.id !== id);
    await db.deleteMaterial(id);
    this.emit();
  }

  // ---------- 设置 ----------
  async saveSettings(s: Settings): Promise<void> {
    this.settings = s;
    await db.putSettings(s);
    this.emit();
  }

  // ---------- 模型与网格 ----------
  baseMeshOf(model: ModelSource): MeshData {
    const key = model.kind === 'builtin' ? 'b:' + model.builtinId : 'f:' + paramHash(model.stlText.slice(0, 4000));
    let m = this.baseMeshCache.get(key);
    if (!m) {
      if (model.kind === 'builtin') {
        const b = getBuiltin(model.builtinId);
        if (!b) throw new Error('未知内置模型');
        m = b.build();
      } else {
        m = parseSTL(base64Decode(model.stlText));
      }
      this.baseMeshCache.set(key, m);
    }
    return m;
  }

  /** 在 Worker 中剖分网格(带缓存) */
  meshOf(model: ModelSource, level: number): Promise<{ mesh: MeshData; check: MeshCheckResult }> {
    const base = this.baseMeshOf(model);
    const key = paramHash({ m: Array.from(base.positions.slice(0, 300)), n: base.triangles.length, level });
    const cached = this.meshCache.get(key);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./workers/mesh.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev: MessageEvent<MeshWorkerResponse & { error?: string }>) => {
        w.terminate();
        if (ev.data.error) { reject(new Error(ev.data.error)); return; }
        const entry = { mesh: { positions: ev.data.positions, triangles: ev.data.triangles }, check: ev.data.check };
        this.meshCache.set(key, entry);
        resolve(entry);
      };
      w.onerror = e => { w.terminate(); reject(new Error(e.message)); };
      // 复制一份 buffer,主线程还要用
      w.postMessage({
        positions: new Float32Array(base.positions),
        triangles: new Uint32Array(base.triangles),
        level,
      });
    });
  }

  // ---------- 仿真任务 ----------
  /** 浇口坐标吸附到网格最近节点(细分级别变化后仍然有效,确定性:按索引顺序取最近) */
  private gateNodesFor(scheme: Scheme, mesh: MeshData): number[] {
    const pos = mesh.positions;
    const n = pos.length / 3;
    return scheme.gates.map(g => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) {
        const dx = pos[i * 3] - g.position.x, dy = pos[i * 3 + 1] - g.position.y, dz = pos[i * 3 + 2] - g.position.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    });
  }

  async resultFor(scheme: Scheme): Promise<SimResult | null> {
    try {
      const { mesh } = await this.meshOf(scheme.model, scheme.meshLevel);
      const mat = this.materials.find(m => m.id === scheme.materialId);
      if (!mat) return null;
      const hash = computeParamHash({
        positions: mesh.positions, triangles: mesh.triangles,
        gateNodes: this.gateNodesFor(scheme, mesh),
        gateOpenTime: scheme.gates.map(g => g.openTime),
        material: mat, process: scheme.process,
      });
      const r = await db.getResult(hash);
      return r ?? null;
    } catch {
      return null;
    }
  }

  async submitTask(schemeId: string): Promise<SimTask> {
    const scheme = this.schemes.find(s => s.id === schemeId);
    if (!scheme) throw new Error('方案不存在');
    if (scheme.gates.length === 0) throw new Error('请先在模型上设置至少一个浇口');
    const mat = this.materials.find(m => m.id === scheme.materialId);
    if (!mat) throw new Error('请选择材料');

    const task: SimTask = {
      id: uid('t'), schemeId, projectId: scheme.projectId, schemeName: scheme.name,
      paramHash: '', status: 'queued', progress: 0, etaSeconds: null, error: null,
      createdAt: Date.now(), startedAt: null, finishedAt: null,
    };
    this.tasks.unshift(task);
    await db.putTask(task);
    this.emit();
    void this.runTask(task, scheme, mat);
    return task;
  }

  private async runTask(task: SimTask, scheme: Scheme, mat: Material): Promise<void> {
    const update = async () => { await db.putTask(task); this.emit(); };
    try {
      task.status = 'meshing';
      task.startedAt = Date.now();
      await update();
      const { mesh, check } = await this.meshOf(scheme.model, scheme.meshLevel);
      if ((task.status as string) === 'canceled') return; // 剖分期间被取消
      if (check.nonManifoldEdgeCount > 0) {
        throw new Error(`网格存在 ${check.nonManifoldEdgeCount} 条非流形边,无法计算,请修复模型`);
      }
      if (mesh.triangles.length / 3 > this.settings.maxElements) {
        throw new Error(`网格单元数 ${mesh.triangles.length / 3} 超过上限 ${this.settings.maxElements},请降低细分级别`);
      }
      // 浇口坐标吸附到当前网格最近节点(细分级别变化后仍正确定位)
      const input = {
        positions: mesh.positions, triangles: mesh.triangles,
        gateNodes: this.gateNodesFor(scheme, mesh),
        gateOpenTime: scheme.gates.map(g => g.openTime),
        material: mat, process: scheme.process,
      };
      const hash = computeParamHash(input);
      task.paramHash = hash;
      // 缓存命中直接完成
      const cached = await db.getResult(hash);
      if (cached) {
        task.status = 'done';
        task.progress = 1;
        task.finishedAt = Date.now();
        await update();
        return;
      }
      task.status = 'running';
      await update();

      // 复制 buffer 再传输:缓存中的网格不能被 detach
      const payload = {
        positions: new Float32Array(input.positions),
        triangles: new Uint32Array(input.triangles),
        gateNodes: input.gateNodes,
        gateOpenTime: input.gateOpenTime,
        material: input.material,
        process: input.process,
      };
      const t0 = performance.now();
      await new Promise<void>((resolve, reject) => {
        const w = new Worker(new URL('./workers/solver.worker.js', import.meta.url), { type: 'module' });
        this.runningWorker = { taskId: task.id, worker: w };
        w.onmessage = async (ev: MessageEvent<SolverWorkerResponse>) => {
          const msg = ev.data;
          if (msg.type === 'progress') {
            task.progress = msg.filled / msg.total;
            const elapsed = (performance.now() - t0) / 1000;
            task.etaSeconds = task.progress > 0.01 ? elapsed * (1 - task.progress) / task.progress : null;
            this.emit(); // 进度高频更新不入库
          } else if (msg.type === 'done') {
            w.terminate();
            this.runningWorker = null;
            msg.result.computedAt = Date.now();
            await db.putResult(msg.result);
            task.status = 'done';
            task.progress = 1;
            task.etaSeconds = 0;
            task.finishedAt = Date.now();
            await update();
            resolve();
          } else {
            w.terminate();
            this.runningWorker = null;
            task.status = 'failed';
            task.error = msg.message;
            task.finishedAt = Date.now();
            await update();
            reject(new Error(msg.message));
          }
        };
        w.onerror = async e => {
          w.terminate();
          this.runningWorker = null;
          task.status = 'failed';
          task.error = e.message || 'Worker 异常';
          task.finishedAt = Date.now();
          await update();
          reject(new Error(task.error));
        };
        w.postMessage(payload, [payload.positions.buffer as ArrayBuffer, payload.triangles.buffer as ArrayBuffer]);
      });
    } catch (err) {
      if (task.status !== 'canceled' && task.status !== 'failed') {
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        task.finishedAt = Date.now();
        await update();
      }
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const t = this.tasks.find(x => x.id === taskId);
    if (!t) return;
    if (this.runningWorker?.taskId === taskId) {
      this.runningWorker.worker.terminate();
      this.runningWorker = null;
    }
    if (t.status === 'running' || t.status === 'queued' || t.status === 'meshing') {
      t.status = 'canceled';
      t.finishedAt = Date.now();
      await db.putTask(t);
      this.emit();
    }
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.cancelTask(taskId);
    this.tasks = this.tasks.filter(t => t.id !== taskId);
    await db.deleteTask(taskId);
    this.emit();
  }

  async getResult(hash: string): Promise<SimResult | null> {
    return (await db.getResult(hash)) ?? null;
  }

  // ---------- 导出 / 导入 ----------
  exportScheme(schemeId: string): string {
    const s = this.schemes.find(x => x.id === schemeId);
    if (!s) throw new Error('方案不存在');
    const mat = this.materials.find(m => m.id === s.materialId);
    return JSON.stringify({ format: 'moldfill-scheme', version: 1, scheme: s, material: mat ?? null }, null, 2);
  }
  async importScheme(projectId: string, json: string): Promise<Scheme> {
    const data = JSON.parse(json);
    if (data.format !== 'moldfill-scheme' || !data.scheme) throw new Error('不是有效的方案文件');
    const s: Scheme = data.scheme;
    s.id = uid('s');
    s.projectId = projectId;
    s.updatedAt = Date.now();
    // 材料不存在则一并导入
    if (data.material && !this.materials.find(m => m.id === data.material.id)) {
      await this.saveMaterial(data.material);
    }
    this.schemes.push(s);
    await db.putScheme(s);
    this.emit();
    return s;
  }
}

export const store = new Store();
