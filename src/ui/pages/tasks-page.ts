// 仿真任务页：进度、预估剩余时间、失败标红与原因、取消、缓存命中
import { store } from '../../core/store';
import { taskManager } from '../../core/task-manager';
import { db } from '../../core/db';
import { h, toast, confirmDialog } from '../dom';
import { formatDuration } from '../../core/utils';
import type { SimTask } from '../../core/types';

export function renderTasksPage(onOpenScheme: (schemeId: string) => void): HTMLElement {
  const wrap = h('div', { class: 'page' });
  const header = h('div', { class: 'page-title' }, h('h2', {}, '仿真任务'), h('span', { class: 'muted' }, '同参数结果自动缓存，不重复计算'));

  const clearBtn = h('button', {
    class: 'btn small',
    onclick: () => {
      if (confirmDialog('确认清空所有已结束的任务记录？（仿真结果缓存不受影响）')) {
        void taskManager.clearFinished();
      }
    },
  }, '清理已结束任务');
  const actions = h('div', { class: 'btn-row', style: { marginBottom: '16px' } }, clearBtn);

  const card = h('div', { class: 'card', style: { padding: '0' } });
  wrap.append(header, actions, card);

  function draw() {
    card.innerHTML = '';
    const tasks = store.state.tasks;
    if (tasks.length === 0) {
      card.append(h('div', { class: 'empty-state', style: { padding: '50px' } }, '暂无仿真任务，在方案编辑页点击「启动充填仿真」'));
      return;
    }
    const table = h('table', {});
    table.append(h('thead', {}, h('tr', {}, h('th', {}, '状态'), h('th', {}, '方案'), h('th', {}, '进度'), h('th', {}, '已耗时'), h('th', {}, '预估剩余'), h('th', {}, '说明'), h('th', { style: { width: '150px' } }, '操作'))));
    const tbody = h('tbody', {});

    for (const t of tasks) {
      const scheme = store.state.schemes.find((s) => s.id === t.schemeId);
      const tr = h('tr', {});
      tr.append(h('td', {}, statusTag(t)));
      tr.append(h('td', {}, h('a', {
        class: 'clickable',
        style: { color: 'var(--accent-2)' },
        onclick: () => scheme && onOpenScheme(scheme.id),
      }, scheme?.name ?? `（已删除方案 ${t.schemeId.slice(-6)}）`)));

      const pct = Math.round(t.progress * 100);
      const barCls = t.status === 'failed' ? 'progress-bar failed' : t.status === 'done' ? 'progress-bar done' : 'progress-bar';
      tr.append(h('td', { style: { minWidth: '160px' } }, h('div', { class: 'progress' }, h('div', { class: barCls, style: { width: `${pct}%` } })), h('div', { class: 'muted mono', style: { fontSize: '11px', marginTop: '4px' } }, `${pct}%`)));
      tr.append(h('td', { class: 'mono' }, formatDuration(t.elapsedMs)));
      tr.append(h('td', { class: 'mono' }, t.status === 'running' ? formatDuration(t.estimatedRemainingMs) : '—'));
      tr.append(h('td', { style: { maxWidth: '320px' } }, t.errorMessage ? h('span', { style: { color: '#fca5a5' } }, t.errorMessage) : t.status === 'done' && t.startedAt === null ? h('span', { class: 'tag blue' }, '缓存命中，未重算') : h('span', { class: 'muted' }, t.status === 'running' ? 'Hele-Shaw 求解中…' : '—')));

      const ops = h('div', { class: 'btn-row' });
      if (t.status === 'running') {
        ops.append(h('button', { class: 'btn small danger', onclick: () => void taskManager.cancel(t.id) }, '取消'));
      }
      if (t.status === 'done' && t.resultId) {
        ops.append(h('button', {
          class: 'btn small',
          onclick: async () => {
            const r = await db.getResult(t.resultId!);
            if (!r) return toast('结果缓存已被淘汰，请重新运行', 'error');
            toast(`充填时间 ${r.metrics.fillTime.toFixed(3)}s / 最大压力 ${r.metrics.maxPressure.toFixed(2)}MPa`, 'info', 4000);
            if (scheme) onOpenScheme(scheme.id);
          },
        }, '查看结果'));
      }
      ops.append(h('button', { class: 'btn small danger', onclick: () => void taskManager.remove(t.id) }, '删除记录'));
      tr.append(h('td', {}, ops));
      tbody.append(tr);
    }
    table.append(tbody);
    card.append(h('div', { class: 'table-wrap' }, table));
  }
  draw();
  store.subscribe(() => draw());
  return wrap;
}

function statusTag(t: SimTask): HTMLElement {
  switch (t.status) {
    case 'running':
      return h('span', { class: 'tag blue' }, '运行中');
    case 'done':
      return h('span', { class: 'tag green' }, '完成');
    case 'failed':
      return h('span', { class: 'tag red' }, '失败');
    case 'canceled':
      return h('span', { class: 'tag gray' }, '已取消');
    default:
      return h('span', { class: 'tag gray' }, '等待');
  }
}
