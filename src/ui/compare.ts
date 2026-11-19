// 方案对比页:关键指标并排,差异超阈值标红
import { store } from '../store.js';
import { el, fmt } from '../util.js';
import { SimResult } from '../types.js';

export function renderCompare(root: HTMLElement, idA: string, idB: string): () => void {
  const panel = el('div', { class: 'panel' });
  root.append(panel);
  panel.append(el('div', { class: 'toolbar' }, el('h2', {}, '方案对比')));

  const sa = store.schemes.find(s => s.id === idA);
  const sb = store.schemes.find(s => s.id === idB);
  if (!sa || !sb) { panel.append(el('p', { class: 'danger' }, '方案不存在')); return () => undefined; }

  let disposed = false;
  const draw = async () => {
    const [ra, rb] = await Promise.all([store.resultFor(sa), store.resultFor(sb)]);
    if (disposed) return;
    panel.innerHTML = '';
    panel.append(el('div', { class: 'toolbar' },
      el('a', { href: '#/project/' + sa.projectId }, '← 返回项目'),
      el('h2', {}, '方案对比'),
    ));
    if (!ra || !rb) {
      panel.append(el('p', { class: 'warn' },
        `需要先跑出两个方案的结果才能对比。缺少:${!ra ? `「${sa.name}」` : ''}${!ra && !rb ? ' 和 ' : ''}${!rb ? `「${sb.name}」` : ''}。请分别打开方案提交仿真。`));
      return;
    }
    const threshold = store.settings.compareThresholdPct / 100;
    const pConv = store.settings.pressureUnit === 'bar' ? 10 : 1;
    const pUnit = store.settings.pressureUnit;

    const rows: [string, (r: SimResult) => number, string, boolean][] = [
      ['总充填时间', r => r.totalFillTime, 's', true],
      ['最大注射压力', r => r.maxInjectionPressure * pConv, pUnit, true],
      ['锁模力', r => r.clampForce, 'kN', true],
      ['熔接痕数量', r => r.weldLines.length, '处', true],
      ['困气点数量', r => r.airTraps.length, '处', true],
      ['网格节点数', r => r.nodeCount, '', false],
    ];
    const table = el('table', { class: 'list' });
    table.append(el('tr', {}, el('th', {}, '指标'), el('th', {}, sa.name), el('th', {}, sb.name), el('th', {}, '差异')));
    for (const [label, get, unit, compare] of rows) {
      const va = get(ra), vb = get(rb);
      const base = Math.max(Math.abs(va), Math.abs(vb), 1e-9);
      const diff = (vb - va) / base;
      const over = compare && Math.abs(diff) > threshold;
      const tr = el('tr', over ? { class: 'diff' } : {},
        el('td', {}, label),
        el('td', {}, fmt(va, 3) + (unit ? ' ' + unit : '')),
        el('td', {}, fmt(vb, 3) + (unit ? ' ' + unit : '')),
        el('td', {}, compare ? (diff >= 0 ? '+' : '') + (diff * 100).toFixed(1) + '%' + (over ? ' ⚠' : '') : '—'),
      );
      table.append(tr);
    }
    panel.append(table);
    panel.append(el('p', { class: 'muted' },
      `阈值:±${store.settings.compareThresholdPct}%(可在设置页调整)。A 参数哈希 ${ra.paramHash.slice(0, 8)} · B 参数哈希 ${rb.paramHash.slice(0, 8)}`));
  };
  void draw();
  return () => { disposed = true; };
}
