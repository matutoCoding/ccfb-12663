// ⑤ 仿真结果面板：发起计算、缓存提示、指标、云图动画、熔接痕/困气定位
import { store } from '../../../core/store';
import { db } from '../../../core/db';
import { taskManager } from '../../../core/task-manager';
import { buildCacheKey, schemeCacheInputs } from '../../../core/cache-key';
import { checkSolverPrerequisites } from '../../../sim/solver';
import { exportReport } from '../../../core/report';
import { openCompareModal } from '../compare-page';
import { h, toast } from '../../dom';
import { formatNumber } from '../../../core/utils';
import type { Marker, RenderMode } from '../../../render/renderer';
import type { Scheme, SimResult } from '../../../core/types';
import { type EditorContext, buildGateMarkers } from './scheme-page';

export function renderResultPanel(ctx: EditorContext): HTMLElement {
  const card = h('div', { class: 'card' });
  const s0 = ctx.scheme;
  const material0 = store.state.materials.find((m) => m.id === s0.materialId);

  const modeSel = h('select', {}, h('option', { value: 'solid' }, '实体'), h('option', { value: 'fill-contour' }, '充填时间云图'), h('option', { value: 'pressure' }, '峰值压力云图')) as HTMLSelectElement;
  modeSel.addEventListener('change', () => ctx.viewport.setMode(modeSel.value as RenderMode));

  const runBtn = h('button', {
    class: 'btn primary',
    style: { width: '100%', justifyContent: 'center' },
    onclick: async () => {
      const cur = store.currentScheme();
      const material = store.state.materials.find((m) => m.id === cur?.materialId);
      if (!cur || !material) return;
      const err = checkSolverPrerequisites(cur.mesh, cur.meshCheck, cur.gates);
      if (err) return toast(err, 'error', 4000);
      const { task, hitCache } = await taskManager.start(cur, material);
      if (hitCache) {
        toast('命中同参数结果缓存，直接读取未重算', 'success');
        setTimeout(() => draw(), 120);
      } else {
        toast(`仿真任务已启动（任务 #${task.id.slice(-6)}），可到「仿真任务」页查看进度`, 'info', 4000);
      }
    },
  }, '▶ 启动充填仿真');

  card.append(h('h3', {}, '⑤ 仿真与结果'), h('div', { class: 'row-gap' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, '显示模式'), modeSel), runBtn));

  const resultHost = h('div', {});
  card.append(resultHost);

  async function draw() {
    resultHost.innerHTML = '';
    const scheme: Scheme | null = store.currentScheme();
    if (!scheme?.mesh) return;
    const material = store.state.materials.find((m) => m.id === scheme.materialId);
    if (!material) return;
    const cacheKey = buildCacheKey(schemeCacheInputs(scheme, material));
    const all = await db.listResults();
    const found = all.find((r) => r.cacheKey === cacheKey && r.schemeId === scheme.id);
    if (found) mountResult(ctx, scheme, found, resultHost, modeSel);
  }
  void material0;
  void s0;
  void draw();

  // 任务状态变化（含完成）后自动刷新结果区
  const unsub = taskManager.subscribe(() => void draw());
  // 面板重挂载时旧订阅通过节点移除自然失效（store 订阅成本可接受）
  void unsub;
  return card;
}

function mountResult(ctx: EditorContext, scheme: Scheme, result: SimResult, host: HTMLElement, modeSel: HTMLSelectElement): void {
  host.innerHTML = '';
  const block = h('div', { style: { marginTop: '14px', borderTop: '1px solid var(--border)', paddingTop: '12px' } });
  const m = result.metrics;

  const stat = (label: string, value: string, red = false) =>
    h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value', style: red ? { color: 'var(--red)' } : {} }, value));

  block.append(
    h('div', { class: 'grid cols-2' },
      stat('充填时间 (s)', formatNumber(m.fillTime, 4)),
      stat('最大注射压力 (MPa)', formatNumber(m.maxPressure, 2)),
      stat('最大锁模力 (kN)', formatNumber(m.maxClampForce, 1)),
      stat('平均剪切速率 (1/s)', formatNumber(m.avgShearRate, 0)),
    ),
    m.shortShot
      ? h('div', { class: 'tag red', style: { marginTop: '10px' } }, '短射：部分区域未充满，已在困气列表标出')
      : h('div', { class: 'tag green', style: { marginTop: '10px' } }, '完全充满'),
    h('div', { class: 'muted mono', style: { fontSize: '11px', marginTop: '8px' } }, `${result.stepCount} 时间步 · CG 迭代 ${result.cgIterationCount} 次 · 缓存键 ${result.cacheKey.slice(0, 14)}…`),
  );

  // ---- 动画控制 ----
  const playBtn = h('button', { class: 'btn small primary' }, '▶ 播放');
  const speedOptions = [0.25, 0.5, 1, 2, 4];
  const speedSel = h('select', {}, ...speedOptions.map((v) => h('option', { value: String(v), selected: v === store.state.settings.defaultPlaybackSpeed }, `${v}×`)));
  speedSel.addEventListener('change', () => ctx.viewport.setSpeed(Number(speedSel.value)));
  ctx.viewport.setSpeed(Number(speedSel.value));
  const slider = h('input', { type: 'range', min: '0', max: '1000', value: '0' }) as HTMLInputElement;
  const timeLabel = h('span', { class: 'mono muted', style: { fontSize: '12px', minWidth: '110px' } }, '0.000 / 0.000 s');
  let raf = 0;

  const showAt = (ratio: number) => {
    ctx.viewport.setResult(result);
    ctx.viewport.setMode('fill-contour');
    modeSel.value = 'fill-contour';
    ctx.viewport.seek(ratio);
    timeLabel.textContent = `${(ratio * result.metrics.fillTime).toFixed(3)} / ${result.metrics.fillTime.toFixed(3)} s`;
  };

  playBtn.addEventListener('click', () => {
    if (playBtn.textContent?.startsWith('▶')) {
      ctx.viewport.setResult(result);
      ctx.viewport.setMode('fill-contour');
      modeSel.value = 'fill-contour';
      if (Number(slider.value) >= 1000) slider.value = '0';
      ctx.viewport.seek(Number(slider.value) / 1000);
      ctx.viewport.play();
      playBtn.textContent = '⏸ 暂停';
      const tick = () => {
        const t = ctx.viewport.getTime();
        const ratio = t / Math.max(1e-9, result.metrics.fillTime);
        slider.value = String(Math.round(ratio * 1000));
        timeLabel.textContent = `${t.toFixed(3)} / ${result.metrics.fillTime.toFixed(3)} s`;
        if (playBtn.textContent?.startsWith('⏸')) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    } else {
      ctx.viewport.pause();
      cancelAnimationFrame(raf);
      playBtn.textContent = '▶ 播放';
    }
  });
  slider.addEventListener('input', () => {
    ctx.viewport.pause();
    cancelAnimationFrame(raf);
    playBtn.textContent = '▶ 播放';
    showAt(Number(slider.value) / 1000);
  });

  block.append(
    h('div', { class: 'timeline', style: { marginTop: '12px' } }, playBtn, speedSel, slider, timeLabel),
    h('div', { class: 'legend', style: { marginTop: '8px' } }, h('span', {}, '早'), h('div', { class: 'legend-bar' }), h('span', {}, '晚')),
  );

  // ---- 熔接痕 / 困气列表 ----
  const defectBox = h('div', { style: { marginTop: '12px' } });
  const weldMarkers: Marker[] = result.weldLines.map((w) => ({ id: w.id, x: w.x, y: w.y, z: w.z, color: [1, 0.84, 0.1], size: 16 }));
  const airMarkers: Marker[] = result.airTraps.map((a) => ({ id: a.id, x: a.x, y: a.y, z: a.z, color: [0.66, 0.33, 0.97], size: 16 }));

  const showDefects = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const refreshMarkers = () => {
    const cur = store.currentScheme();
    const gates = cur ? buildGateMarkers(cur) : [];
    ctx.viewport.setMarkers(showDefects.checked ? [...gates, ...weldMarkers, ...airMarkers] : gates);
  };
  showDefects.addEventListener('change', refreshMarkers);
  refreshMarkers();

  defectBox.append(h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '8px 0' } }, showDefects, '在模型上标注熔接痕/困气'));

  const weldList = h('div', {});
  weldList.append(h('div', { class: 'muted', style: { fontSize: '12px', margin: '6px 0' } }, `熔接痕 ${result.weldLines.length} 处（不同前沿汇合位置）`));
  result.weldLines.slice(0, 30).forEach((w) => {
    weldList.append(h('div', {
      class: 'list-item clickable',
      onclick: () => void ctx.viewport.flyTo(w.x, w.y, w.z),
    }, h('span', { class: 'dot yellow' }), h('div', { class: 'grow' }, h('div', {}, `节点 #${w.nodeIndex}`), h('div', { class: 'muted mono', style: { fontSize: '11px' } }, `${w.fillTime.toFixed(3)} s · 浇口 ${w.sourceA.slice(-4)} ↔ ${w.sourceB.slice(-4)}`)), h('span', { class: 'tag yellow' }, '定位')));
  });

  const airList = h('div', {});
  airList.append(h('div', { class: 'muted', style: { fontSize: '12px', margin: '6px 0' } }, `困气 ${result.airTraps.length} 处（排气不良风险点）`));
  result.airTraps.slice(0, 30).forEach((a) => {
    airList.append(h('div', {
      class: 'list-item clickable',
      onclick: () => void ctx.viewport.flyTo(a.x, a.y, a.z),
    }, h('span', { class: 'dot purple' }), h('div', { class: 'grow' }, h('div', {}, `节点 #${a.nodeIndex}`), h('div', { class: 'muted mono', style: { fontSize: '11px' } }, `(${a.x.toFixed(1)}, ${a.y.toFixed(1)}, ${a.z.toFixed(1)})`)), h('span', { class: 'tag blue' }, '定位')));
  });
  defectBox.append(weldList, airList);
  block.append(defectBox);

  // 报告导出 / 方案对比
  const material = store.state.materials.find((mm) => mm.id === scheme.materialId);
  const reportBtn = h('button', {
    class: 'btn small',
    style: { marginTop: '12px' },
    onclick: () => {
      if (!material) return toast('材料缺失，无法导出报告', 'error');
      try {
        ctx.viewport.setResult(result);
        ctx.viewport.setMode('fill-contour');
        ctx.viewport.seek(1);
        const shot = ctx.viewport.screenshot();
        ctx.viewport.setMode('pressure');
        const pressureShot = ctx.viewport.screenshot();
        ctx.viewport.setMode('fill-contour');
        exportReport({ scheme, material, result, screenshot: shot, pressureShot });
        toast('报告已导出（含云图截图与关键指标的 HTML 文件）', 'success');
      } catch (e) {
        toast(`报告导出失败：${(e as Error).message}`, 'error');
      }
    },
  }, '📄 导出仿真报告');
  const compareBtn = h('button', {
    class: 'btn small',
    style: { marginTop: '12px' },
    onclick: () => void openCompareModal(scheme.id),
  }, '📊 与其他方案对比');
  block.append(h('div', { class: 'btn-row' }, reportBtn, compareBtn));
  host.append(block);

  // 初次挂载结果时自动切到云图
  showAt(0);
}
