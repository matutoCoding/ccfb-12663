// 全局状态 Store：不可变更新 + 撤销/重做 + 防抖自动保存到 IndexedDB
import { db } from './db';
import type { AppSettings, Material, Project, Scheme, SimTask } from './types';
import { deepClone, now, uid } from './utils';
import { defaultMaterials, defaultSettings } from './materials';
import { taskManager } from './task-manager';

export interface AppState {
  ready: boolean;
  projects: Project[];
  schemes: Scheme[];
  materials: Material[];
  tasks: SimTask[];
  settings: AppSettings;
  currentProjectId: string | null;
  currentSchemeId: string | null;
}

type Listener = (s: AppState) => void;

const SAVE_DELAY = 400;

class Store {
  state: AppState = {
    ready: false,
    projects: [],
    schemes: [],
    materials: [],
    tasks: [],
    settings: defaultSettings(),
    currentProjectId: null,
    currentSchemeId: null,
  };

  private listeners = new Set<Listener>();
  private undoStack: { label: string; snap: AppState }[] = [];
  private redoStack: { label: string; snap: AppState }[] = [];
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private suppressUndo = false;
  undoDepth = 100;

  async init(): Promise<void> {
    let settings = await db.getSettings();
    if (!settings) {
      settings = defaultSettings();
      await db.putSettings(settings);
    }
    this.undoDepth = settings.undoDepth;

    let materials = await db.listMaterials();
    if (materials.length === 0) {
      materials = defaultMaterials();
      await Promise.all(materials.map((m) => db.putMaterial(m)));
    }

    const [projects, schemes] = await Promise.all([db.listProjects(), db.listSchemes()]);
    projects.sort((a, b) => b.updatedAt - a.updatedAt);

    this.state = {
      ready: true,
      projects,
      schemes,
      materials,
      tasks: taskManager.list(),
      settings,
      currentProjectId: projects[0]?.id ?? null,
      currentSchemeId: null,
    };
    taskManager.subscribe((tasks) => {
      this.state = { ...this.state, tasks };
      this.emit();
    });
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  // ---------- 撤销/重做 ----------
  private snapshot(label: string): void {
    if (this.suppressUndo) return;
    // 只持久化可编辑实体，任务态不进撤销栈
    const snap = deepClone(this.state);
    this.undoStack.push({ label, snap });
    if (this.undoStack.length > this.undoDepth) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  undoLabel(): string {
    return this.undoStack[this.undoStack.length - 1]?.label ?? '';
  }
  redoLabel(): string {
    return this.redoStack[this.redoStack.length - 1]?.label ?? '';
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push({ label: entry.label, snap: deepClone(this.state) });
    this.restore(entry.snap);
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push({ label: entry.label, snap: deepClone(this.state) });
    this.restore(entry.snap);
  }

  private restore(snap: AppState): void {
    this.suppressUndo = true;
    this.state = deepClone(snap);
    this.persistAll();
    this.emit();
    this.suppressUndo = false;
  }

  // ---------- 通用变更入口 ----------
  /** 带撤销记录的变更；mutator 直接修改 draft，提交后自动保存 */
  commit(label: string, mutator: (draft: AppState) => void): void {
    this.snapshot(label);
    const draft = deepClone(this.state);
    mutator(draft);
    this.state = draft;
    this.persistAll();
    this.emit();
  }

  /** 不进撤销栈的变更（任务进度、选择态等） */
  patch(mutator: (draft: AppState) => void): void {
    const draft = deepClone(this.state);
    mutator(draft);
    this.state = draft;
    this.emit();
  }

  // ---------- 自动保存（防抖） ----------
  private scheduleSave(kind: 'project' | 'scheme' | 'material' | 'settings', key: string, value: unknown): void {
    const timerKey = `${kind}:${key}`;
    const old = this.saveTimers.get(timerKey);
    if (old) clearTimeout(old);
    this.saveTimers.set(
      timerKey,
      setTimeout(() => {
        this.saveTimers.delete(timerKey);
        if (kind === 'project') void db.putProject(value as Project);
        else if (kind === 'scheme') void db.putScheme(value as Scheme);
        else if (kind === 'material') void db.putMaterial(value as Material);
        else void db.putSettings(value as AppSettings);
      }, SAVE_DELAY),
    );
  }

  private persistAll(): void {
    for (const p of this.state.projects) this.scheduleSave('project', p.id, p);
    for (const s of this.state.schemes) this.scheduleSave('scheme', s.id, s);
    for (const m of this.state.materials) this.scheduleSave('material', m.id, m);
    this.scheduleSave('settings', 'app', this.state.settings);
  }

  async flushSave(): Promise<void> {
    for (const t of this.saveTimers.values()) clearTimeout(t);
    this.saveTimers.clear();
    await Promise.all([
      ...this.state.projects.map((p) => db.putProject(p)),
      ...this.state.schemes.map((s) => db.putScheme(s)),
      ...this.state.materials.map((m) => db.putMaterial(m)),
      db.putSettings(this.state.settings),
    ]);
  }

  // ---------- 项目操作 ----------
  createProject(name: string): Project {
    const project: Project = {
      id: uid('proj'),
      name,
      description: '',
      createdAt: now(),
      updatedAt: now(),
      schemeIds: [],
    };
    this.commit('新建项目', (d) => {
      d.projects.unshift(project);
      d.currentProjectId = project.id;
    });
    return project;
  }

  duplicateProject(projectId: string): Project {
    const src = this.state.projects.find((p) => p.id === projectId);
    if (!src) throw new Error('项目不存在');
    const idMap = new Map<string, string>();
    const copy: Project = { ...deepClone(src), id: uid('proj'), name: `${src.name} - 副本`, createdAt: now(), updatedAt: now(), schemeIds: [] };
    this.commit('复制项目', (d) => {
      for (const sid of src.schemeIds) {
        const s = d.schemes.find((x) => x.id === sid);
        if (!s) continue;
        const ns = deepClone(s);
        ns.id = uid('sch');
        ns.projectId = copy.id;
        ns.name = `${s.name} - 副本`;
        ns.createdAt = now();
        ns.updatedAt = now();
        idMap.set(s.id, ns.id);
        copy.schemeIds.push(ns.id);
        d.schemes.push(ns);
      }
      d.projects.unshift(copy);
      d.currentProjectId = copy.id;
    });
    return copy;
  }

  deleteProject(projectId: string): void {
    const proj = this.state.projects.find((p) => p.id === projectId);
    if (!proj) return;
    this.commit('删除项目', (d) => {
      for (const sid of proj.schemeIds) {
        d.schemes = d.schemes.filter((s) => s.id !== sid);
        void db.deleteScheme(sid);
      }
      d.projects = d.projects.filter((p) => p.id !== projectId);
      if (d.currentProjectId === projectId) d.currentProjectId = d.projects[0]?.id ?? null;
      if (d.currentSchemeId && !d.schemes.some((s) => s.id === d.currentSchemeId)) d.currentSchemeId = null;
      void db.deleteProject(projectId);
    });
  }

  selectProject(projectId: string | null): void {
    this.patch((d) => {
      d.currentProjectId = projectId;
      d.currentSchemeId = null;
    });
  }

  selectScheme(schemeId: string | null): void {
    this.patch((d) => {
      d.currentSchemeId = schemeId;
    });
  }

  currentProject(): Project | null {
    return this.state.projects.find((p) => p.id === this.state.currentProjectId) ?? null;
  }

  currentScheme(): Scheme | null {
    return this.state.schemes.find((s) => s.id === this.state.currentSchemeId) ?? null;
  }

  /** 直接导入外部实体（打包导入用，实体已由 package-io 落库） */
  adoptImported(project: Project, schemes: Scheme[], materials: Material[]): void {
    this.commit('导入方案包', (d) => {
      for (const m of materials) if (!d.materials.some((x) => x.id === m.id)) d.materials.push(m);
      for (const s of schemes) if (!d.schemes.some((x) => x.id === s.id)) d.schemes.push(s);
      if (!d.projects.some((x) => x.id === project.id)) d.projects.unshift(project);
      d.currentProjectId = project.id;
      d.currentSchemeId = schemes[0]?.id ?? null;
    });
  }
}

export const store = new Store();
