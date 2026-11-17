// 方案对比：两个方案的关键指标并排展示，差异超阈值标红
import { db } from '../../core/db';
import { store } from '../../core/store';
import { h } from '../dom';
import { formatNumber } from '../../core/utils';
import type { Scheme, SimResult } from '../../core/types';

interface CompareRow {
  label: string;
  unit: string;
  get: (r: SimResult) => number;
  digits: number;
  higherIsWorse?: boolean;
}

const ROWS: CompareRow[] = [
  { label: '充填时间', unit: 's', get: (r) => r.metrics.fillTime, digits: 4 },
  { label: '最大注射压力', unit: 'MPa', get: (r) => r.metrics.maxPressure, digits: 2, higherIsWorse: true },
  { label: '最大锁模力', unit: 'kN', get: (r) => r.metrics.maxClampForce, digits: 1 },
  { label: '平均剪切速率', unit: '1/s', get: (r) => r.metrics.avgShearRate, digits: 0 },
  { label: '充填体积', unit: 'mm³', get: (r) => r.metrics.filledVolume, digits: 0 },
  { label: '熔接痕数量', unit: '处', get: (r) => r.weldLines.length, digits: 0, higherIsWorse: true },
  { label: '困气数量', unit: '处', get: (r) => r.airTraps.length, digits: 0, higherIsWorse: true },
];

/** 对比模态框：传入两个方案 id，自动取各自最新结果 */
export async function openCompareModal(schemeAId: string, bIdArg?: string): Promise<void> {
  const schemes = store.state.schemes;
  const results = await db.listResults();
  const latestOf = (sid: string) =>
    results.filter((r) => r.schemeId === sid).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

  let aId = schemeAId;
  const bIdInit: string = bIdArg ?? schemes.find((sc) => sc.id !== aId)?.id ?? '';
  let bId = bIdInit;

  const mask = h('div', { class: 'modal-mask' });
  const modal = h('div', { class: 'modal' });
  mask.append(modal);
  document.body.append(mask);

  const close = () => mask.remove();
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });

  const body = h('div', {});
  const draw = () => {
    body.innerHTML = '';
    const ra = latestOf(aId);
    const rb = bId ? latestOf(bId) : null;
    const sa = schemes.find((x) => x.id === aId);
    const sb = schemes.find((x) => x.id === bId);

    const table = h('table', {});
    table.append(h('thead', {}, h('tr', {}, h('th', {}, '指标'), h('th', {}, sa?.name ?? '方案 A'), h('th', {}, sb?.name ?? '方案 B'), h('th', {}, '相对差异'))));
    const tbody = h('tbody', {});
    const threshold = store.state.settings.compareThresholdPercent / 100;

    if (!ra || !rb) {
      tbody.append(h('tr', {}, h('td', { colspan: '4', class: 'muted', style: { padding: '24px', textAlign: 'center' } }, '所选方案缺少仿真结果，请先在方案编辑页运行充填仿真')));
    } else {
      for (const row of ROWS) {
        const va = row.get(ra);
        const vb = row.get(rb);
        const base = Math.abs(va) > 1e-12 ? Math.abs(va) : 1e-12;
        const diff = (vb - va) / base;
        const over = Math.abs(diff) > threshold;
        tbody.append(h('tr', {},
          h('td', {}, row.label, h('span', { class: 'muted' }, ` (${row.unit})`)),
          h('td', { class: 'mono' }, formatNumber(va, row.digits)),
          h('td', { class: 'mono' }, formatNumber(vb, row.digits)),
          h('td', { class: `mono ${over ? 'diff-red' : ''}` }, `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}%${over ? ' ⚠' : ''}`),
        ));
      }
      // 工艺/材料差异提示
      tbody.append(h('tr', {}, h('td', { class: 'muted' }, '材料'), h('td', {}, materialName(ra.materialId)), h('td', {}, materialName(rb.materialId)), h('td', {})));
      tbody.append(h('tr', {}, h('td', { class: 'muted' }, '流量 mm³/s'), h('td', { class: 'mono' }, String(ra.paramSummary.flowRate)), h('td', { class: 'mono' }, String(rb.paramSummary.flowRate)), h('td', {})));
    }
    table.append(tbody);
    body.append(h('p', { class: 'muted', style: { fontSize: '12px' } }, `相对差异 = (B − A) / |A|；超过 ±${store.state.settings.compareThresholdPercent}% 的指标自动标红。`), h('div', { class: 'table-wrap' }, table));
  };

  const selA = h('select', { onchange: () => { aId = selA.value; draw(); } }, ...schemes.map((sc) => h('option', { value: sc.id, selected: sc.id === aId }, sc.name)));
  const selB = h('select', { onchange: () => { bId = selB.value; draw(); } }, ...schemes.map((sc) => h('option', { value: sc.id, selected: sc.id === bId }, sc.name)));
  modal.append(
    h('h3', {}, '方案对比'),
    h('div', { class: 'grid cols-2', style: { marginBottom: '14px' } }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, '方案 A'), selA), h('label', { class: 'field' }, h('span', { class: 'field-label' }, '方案 B'), selB)),
    body,
    h('div', { class: 'modal-footer' }, h('button', { class: 'btn primary', onclick: close }, '关闭')),
  );
  draw();
}

function materialName(id: string): string {
  return store.state.materials.find((m) => m.id === id)?.name ?? id.slice(-6);
}

export function compareCandidates(currentScheme: Scheme): string[] {
  return store.state.schemes.filter((s) => s.projectId === currentScheme.projectId).map((s) => s.id);
}
