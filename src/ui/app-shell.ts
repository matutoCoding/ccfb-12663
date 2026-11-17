// 应用外壳：顶部导航、页面路由、撤销/重做快捷键
import { store } from '../core/store';
import { h, clear, mount } from './dom';
import { renderProjectsPage } from './pages/projects-page';
import { renderSchemePage } from './pages/editor/scheme-page';
import { renderTasksPage } from './pages/tasks-page';
import { renderMaterialsPage } from './pages/materials-page';
import { renderSettingsPage } from './pages/settings-page';

export type PageName = 'projects' | 'editor' | 'tasks' | 'materials' | 'settings';

const NAV: { key: PageName; label: string }[] = [
  { key: 'projects', label: '项目' },
  { key: 'editor', label: '方案编辑' },
  { key: 'tasks', label: '仿真任务' },
  { key: 'materials', label: '材料库' },
  { key: 'settings', label: '设置' },
];

export class AppShell {
  private page: PageName = 'projects';
  private mainEl: HTMLElement;
  private navButtons = new Map<PageName, HTMLButtonElement>();
  private editorProjectId: string | null = null;

  constructor(root: HTMLElement) {
    const topbar = h('div', { class: 'topbar' });
    topbar.append(h('div', { class: 'brand' }, '🏭 注塑充填仿真平台'));
    for (const item of NAV) {
      const btn = h('button', { class: 'nav-item', onclick: () => this.navigate(item.key) }, item.label);
      this.navButtons.set(item.key, btn);
      topbar.append(btn);
    }
    topbar.append(h('div', { class: 'topbar-spacer' }));

    const undoBtn = h('button', { class: 'btn small', title: '撤销 (Ctrl+Z)', onclick: () => store.undo() }, '↶ 撤销');
    const redoBtn = h('button', { class: 'btn small', title: '重做 (Ctrl+Y)', onclick: () => store.redo() }, '↷ 重做');
    const updateUndoState = () => {
      undoBtn.disabled = !store.canUndo();
      redoBtn.disabled = !store.canRedo();
      undoBtn.title = store.canUndo() ? `撤销：${store.undoLabel()}` : '无可撤销操作';
      redoBtn.title = store.canRedo() ? `重做：${store.redoLabel()}` : '无可重做操作';
    };
    store.subscribe(() => updateUndoState());
    updateUndoState();
    topbar.append(h('div', { class: 'undo-group' }, undoBtn, redoBtn));

    this.mainEl = h('div', { class: 'main' });
    mount(root, topbar, this.mainEl);

    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        store.redo();
      }
    });
  }

  navigate(page: PageName, projectId?: string): void {
    if (page === 'editor' && !projectId) projectId = store.state.currentProjectId ?? undefined;
    if (page === 'editor' && !projectId) {
      this.navigate('projects');
      return;
    }
    this.page = page;
    if (projectId) this.editorProjectId = projectId;
    for (const [key, btn] of this.navButtons) btn.classList.toggle('active', key === page);
    this.render();
  }

  private render(): void {
    clear(this.mainEl);
    switch (this.page) {
      case 'projects':
        mount(this.mainEl, renderProjectsPage((pid) => this.navigate('editor', pid)));
        break;
      case 'editor':
        mount(this.mainEl, renderSchemePage(this.editorProjectId!, (p) => this.navigate(p as PageName)));
        break;
      case 'tasks':
        mount(this.mainEl, renderTasksPage((schemeId) => {
          const sc = store.state.schemes.find((s) => s.id === schemeId);
          if (sc) this.navigate('editor', sc.projectId);
        }));
        break;
      case 'materials':
        mount(this.mainEl, renderMaterialsPage());
        break;
      case 'settings':
        mount(this.mainEl, renderSettingsPage());
        break;
    }
  }
}
