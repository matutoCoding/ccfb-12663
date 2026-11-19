// 仿真任务页:进度、预估剩余时间、失败原因、取消、查看结果
import { store } from '../store.js';
import { el, fmtTime } from '../util.js';
import { SimTask } from '../types.js';

const STATUS_LABEL: Record<SimTask['status'], [string, string]> = {
  queued: ['排队中', 'tag'],
  meshing: ['网格剖分中', 'tag run'],
  running: ['计算中', 'tag run'],
  done: ['已完成', 'tag ok'],
  failed: ['失败', 'tag err'],
  canceled: ['已取消', 'tag'],
};

export function renderTasks(root: HTMLElement): () => void {
  const draw = () => {
    root.innerHTML = '';
    const panel = el('div', { class: 'panel' });
    panel.append(el('div', { class: 'toolbar' }, el('h2', {}, '仿真任务')));
    if (store.tasks.length === 0) {
      panel.append(el('p', { class: 'muted' }, '暂无任务,请在方案编辑器中提交仿真。'));
    }
    const table = el('table', { class: 'list' });
    table.append(el('tr', {},
      el('th', {}, '方案'), el('th', {}, '状态'), el('th', {}, '进度'), el('th', {}, '预计剩余'),
      el('th', {}, '提交时间'), el('th', {}, '耗时'), el('th', {}, '说明'), el('th', {}, '操作')));
    for (const t of store.tasks) {
      const [label, cls] = STATUS_LABEL[t.status];
      const bar = el('div', { class: 'progress' }, el('div', { style: `width:${(t.progress * 100).toFixed(0)}%` }));
      const duration = t.startedAt && t.finishedAt ? fmtTime((t.finishedAt - t.startedAt) / 1000)
        : t.startedAt ? fmtTime((Date.now() - t.startedAt) / 1000) : '—';
      const tr = el('tr', {},
        el('td', {}, t.schemeName),
        el('td', {}, el('span', { class: cls }, label)),
        el('td', {}, bar),
        el('td', {}, t.status === 'running' && t.etaSeconds !== null ? fmtTime(t.etaSeconds) : '—'),
        el('td', { class: 'muted' }, new Date(t.createdAt).toLocaleString('zh-CN')),
        el('td', {}, duration),
        el('td', {}, t.error ? el('span', { class: 'danger' }, t.error) : (t.status === 'done' ? el('span', { class: 'ok' }, '结果已缓存,同参数不重算') : '')),
        el('td', {},
          (t.status === 'running' || t.status === 'queued' || t.status === 'meshing')
            ? (() => { const b = el('button', { class: 'small danger' }, '取消'); b.onclick = () => store.cancelTask(t.id); return b; })()
            : '',
          ' ',
          (() => { const b = el('button', { class: 'small' }, '查看方案'); b.onclick = () => { location.hash = '#/scheme/' + t.schemeId; }; return b; })(),
          ' ',
          (() => { const b = el('button', { class: 'small' }, '删除'); b.onclick = () => store.deleteTask(t.id); return b; })(),
        ),
      );
      if (t.status === 'failed') tr.style.background = '#fdf0f0';
      table.append(tr);
    }
    panel.append(table);
    root.append(panel);
  };
  draw();
  return store.onChange(draw);
}
