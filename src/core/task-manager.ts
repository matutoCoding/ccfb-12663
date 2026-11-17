// 仿真任务管理器：任务持久化、进度 ETA、取消、同参数缓存命中、缓存淘汰
import { db } from './db';
import type { Material, SimResult, SimTask, Scheme } from './types';
import { uid, now } from './utils';
import { buildCacheKey, schemeCacheInputs } from './cache-key';
import { runSimulation, type SimJob } from '../workers/worker-client';
import type { AppSettings } from './types';

type TaskListener = (tasks: SimTask[]) => void;

class TaskManager {
  private tasks = new Map<string, SimTask>();
  private jobs = new Map<string, SimJob>();
  private listeners = new Set<TaskListener>();
  private loaded = false;
  private settings: AppSettings | null = null;

  async init(settings: AppSettings): Promise<void> {
    this.settings = settings;
    if (this.loaded) return;
    const stored = await db.listTasks();
    for (const t of stored) {
      // 上次会话中未完成的任务，启动后标记失败并注明原因
      if (t.status === 'running' || t.status === 'pending') {
        t.status = 'failed';
        t.errorMessage = '浏览器刷新导致任务中断，请重新运行';
        t.finishedAt = now();
        await db.putTask(t);
      }
      this.tasks.set(t.id, t);
    }
    this.loaded = true;
    this.emit();
  }

  subscribe(fn: TaskListener): () => void {
    this.listeners.add(fn);
    fn(this.list());
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    const list = this.list();
    for (const fn of this.listeners) fn(list);
  }

  list(): SimTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 同参数结果直接命中缓存，不重算 */
  async findCachedResult(cacheKey: string): Promise<SimResult | null> {
    const results = await db.listResults();
    return results.find((r) => r.cacheKey === cacheKey) ?? null;
  }

  async start(scheme: Scheme, material: Material): Promise<{ task: SimTask; hitCache: boolean }> {
    const cacheKey = buildCacheKey(schemeCacheInputs(scheme, material));
    const cached = await this.findCachedResult(cacheKey);
    const task: SimTask = {
      id: uid('task'),
      schemeId: scheme.id,
      cacheKey,
      status: cached ? 'done' : 'running',
      progress: cached ? 1 : 0,
      createdAt: now(),
      startedAt: cached ? null : now(),
      finishedAt: cached ? now() : null,
      elapsedMs: 0,
      estimatedRemainingMs: 0,
      resultId: cached?.id ?? null,
      errorMessage: null,
    };
    this.tasks.set(task.id, task);
    await db.putTask(task);
    this.emit();

    if (cached) return { task, hitCache: true };

    const input = {
      cacheKey,
      schemeId: scheme.id,
      mesh: scheme.mesh!,
      material,
      process: scheme.process,
      gates: scheme.gates,
    };
    const startTs = performance.now();
    const job = runSimulation(input, (percent) => {
      const cur = this.tasks.get(task.id);
      if (!cur || cur.status !== 'running') return;
      cur.progress = percent / 100;
      cur.elapsedMs = performance.now() - startTs;
      cur.estimatedRemainingMs = percent > 2 ? (cur.elapsedMs / percent) * (100 - percent) : 0;
      this.patch(cur);
    });
    this.jobs.set(task.id, job);

    job.promise
      .then(async (result) => {
        await db.putResult(result);
        await this.evictIfNeeded();
        const cur = this.tasks.get(task.id);
        if (!cur) return;
        cur.status = 'done';
        cur.progress = 1;
        cur.resultId = result.id;
        cur.finishedAt = now();
        cur.elapsedMs = performance.now() - startTs;
        cur.estimatedRemainingMs = 0;
        await this.patch(cur);
      })
      .catch(async (e: Error) => {
        const cur = this.tasks.get(task.id);
        if (!cur) return;
        if (e.message === 'cancel') {
          cur.status = 'canceled';
          cur.errorMessage = '用户手动取消';
        } else {
          cur.status = 'failed';
          cur.errorMessage = e.message;
        }
        cur.finishedAt = now();
        cur.elapsedMs = performance.now() - startTs;
        cur.estimatedRemainingMs = 0;
        await this.patch(cur);
      })
      .finally(() => this.jobs.delete(task.id));

    return { task, hitCache: false };
  }

  async cancel(taskId: string): Promise<void> {
    this.jobs.get(taskId)?.cancel();
  }

  async remove(taskId: string): Promise<void> {
    this.jobs.get(taskId)?.cancel();
    this.jobs.delete(taskId);
    this.tasks.delete(taskId);
    await db.deleteTask(taskId);
    this.emit();
  }

  async clearFinished(): Promise<void> {
    for (const [id, t] of this.tasks) {
      if (t.status === 'done' || t.status === 'failed' || t.status === 'canceled') {
        this.tasks.delete(id);
        await db.deleteTask(id);
      }
    }
    this.emit();
  }

  private async patch(t: SimTask): Promise<void> {
    this.tasks.set(t.id, t);
    await db.putTask(t);
    this.emit();
  }

  /** 缓存超上限时按最旧 createdAt 淘汰 */
  private async evictIfNeeded(): Promise<void> {
    const limit = this.settings?.cacheLimit ?? 20;
    const results = await db.listResults();
    if (results.length <= limit) return;
    const sorted = results.sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < results.length - limit; i++) {
      await db.deleteResult(sorted[i].id);
    }
  }
}

export const taskManager = new TaskManager();
