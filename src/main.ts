// 入口 + 哈希路由
import { store } from './store.js';
import { renderProjects } from './ui/projects.js';
import { renderProjectDetail } from './ui/projectDetail.js';
import { renderEditor } from './ui/editor.js';
import { renderTasks } from './ui/tasks.js';
import { renderMaterials } from './ui/materials.js';
import { renderSettings } from './ui/settings.js';
import { renderCompare } from './ui/compare.js';

const app = document.getElementById('app')!;

type PageFn = (root: HTMLElement, params: string[]) => void | (() => void);
let cleanup: (() => void) | null = null;

function route(): void {
  if (cleanup) { cleanup(); cleanup = null; }
  const hash = location.hash || '#/projects';
  const parts = hash.slice(2).split('/');
  const page = parts[0] || 'projects';
  document.querySelectorAll('#topbar nav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('data-route') === page);
  });
  app.innerHTML = '';
  const routes: Record<string, PageFn> = {
    projects: r => renderProjects(r),
    project: (r, p) => renderProjectDetail(r, p[0]),
    scheme: (r, p) => renderEditor(r, p[0]),
    tasks: r => renderTasks(r),
    materials: r => renderMaterials(r),
    settings: r => renderSettings(r),
    compare: (r, p) => renderCompare(r, p[0], p[1]),
  };
  const fn = routes[page] ?? routes['projects'];
  const c = fn(app, parts.slice(1));
  if (typeof c === 'function') cleanup = c;
}

function updateBadge(): void {
  const badge = document.getElementById('task-badge')!;
  const running = store.tasks.filter(t => t.status === 'running' || t.status === 'meshing' || t.status === 'queued');
  badge.textContent = running.length > 0
    ? `仿真中 ${running.length} 个 · ${(running[0].progress * 100).toFixed(0)}%`
    : '';
}

async function main(): Promise<void> {
  await store.init();
  store.onChange(updateBadge);
  window.addEventListener('hashchange', route);
  route();
}

void main();
