// 项目列表页：新建 / 复制 / 删除 / 打包导入导出
import { store } from '../../core/store';
import { db, idbGet } from '../../core/db';
import { downloadPackage, exportProject, importPackage, readPackageFile } from '../../core/package-io';
import { h, toast, confirmDialog, filePicker } from '../dom';
import type { Project } from '../../core/types';

export function renderProjectsPage(onOpen: (projectId: string) => void): HTMLElement {
  const state = store.state;
  const wrap = h('div', { class: 'page' });

  const header = h('div', { class: 'page-title' }, h('h2', {}, '项目列表'), h('span', { class: 'muted' }, `共 ${state.projects.length} 个项目`));
  const actions = h('div', { class: 'btn-row', style: { marginBottom: '18px' } });

  const newBtn = h('button', {
    class: 'btn primary',
    onclick: () => {
      const name = window.prompt('新项目名称', `项目 ${state.projects.length + 1}`);
      if (!name?.trim()) return;
      const p = store.createProject(name.trim());
      toast(`项目「${p.name}」已创建，自动保存到本地浏览器`, 'success');
      onOpen(p.id);
    },
  }, '＋ 新建项目');

  const importBtn = h('button', {
    class: 'btn',
    onclick: async () => {
      const [file] = await filePicker('.json,.imsim.json');
      if (!file) return;
      try {
        const pkg = await readPackageFile(file);
        const outcome = await importPackage(pkg);
        const schemes = await Promise.all(outcome.project.schemeIds.map((id) => idbGet<import('../../core/types').Scheme>('schemes', id)));
        const materials = await Promise.all(pkg.materials.map((m) => idbGet<import('../../core/types').Material>('materials', m.id)));
        store.adoptImported(
          outcome.project,
          schemes.filter((s): s is NonNullable<typeof s> => Boolean(s)),
          materials.filter((m): m is NonNullable<typeof m> => Boolean(m)),
        );
        toast(`导入成功：${outcome.schemeCount} 个方案、${outcome.materialCount} 个材料、${outcome.resultCount} 条仿真结果`, 'success', 4500);
        onOpen(outcome.project.id);
      } catch (e) {
        toast(`导入失败：${(e as Error).message}`, 'error', 5000);
      }
    },
  }, '⬆ 导入方案包');

  actions.append(newBtn, importBtn);

  const card = h('div', { class: 'card', style: { padding: '0' } });
  if (state.projects.length === 0) {
    card.append(
      h('div', { class: 'empty-state', style: { padding: '60px 20px' } }, h('div', { style: { 'font-size': '34px' } }, '📁'), h('div', {}, '还没有项目，点击「新建项目」开始，或导入同事发来的 .imsim.json')),
    );
  } else {
    const table = h('table', {});
    table.append(
      h('thead', {}, h('tr', {}, h('th', {}, '项目名称'), h('th', {}, '方案数'), h('th', {}, '更新时间'), h('th', {}, '说明'), h('th', { style: { width: '260px' } }, '操作'))),
    );
    const tbody = h('tbody', {});
    for (const p of state.projects) {
      tbody.append(renderRow(p, onOpen));
    }
    table.append(tbody);
    card.append(h('div', { class: 'table-wrap' }, table));
  }

  wrap.append(header, actions, card);
  return wrap;
}

function renderRow(p: Project, onOpen: (id: string) => void): HTMLElement {
  const tr = h('tr', {});
  tr.append(
    h('td', {}, h('a', { class: 'clickable', style: { color: 'var(--accent-2)', 'font-weight': '600' }, onclick: () => onOpen(p.id) }, p.name)),
    h('td', { class: 'mono' }, String(p.schemeIds.length)),
    h('td', { class: 'muted' }, new Date(p.updatedAt).toLocaleString('zh-CN')),
    h('td', { class: 'muted' }, p.description || '—'),
  );

  const openBtn = h('button', { class: 'btn small primary', onclick: () => onOpen(p.id) }, '打开');
  const dupBtn = h('button', {
    class: 'btn small',
    onclick: () => {
      store.duplicateProject(p.id);
      toast('项目已复制（含全部方案）', 'success');
    },
  }, '复制');
  const exportBtn = h('button', {
    class: 'btn small',
    onclick: async () => {
      try {
        const pkg = await exportProject(p.id);
        await downloadPackage(pkg);
        toast('方案包已导出，发送给同事直接打开即可查看', 'success');
      } catch (e) {
        toast(`导出失败：${(e as Error).message}`, 'error');
      }
    },
  }, '导出');
  const delBtn = h('button', {
    class: 'btn small danger',
    onclick: () => {
      if (confirmDialog(`确认删除项目「${p.name}」及其全部 ${p.schemeIds.length} 个方案？此操作可通过撤销恢复（本次会话内）。`)) {
        store.deleteProject(p.id);
        toast('项目已删除', 'info');
      }
    },
  }, '删除');
  tr.append(h('td', {}, h('div', { class: 'btn-row' }, openBtn, dupBtn, exportBtn, delBtn)));
  return tr;
}
