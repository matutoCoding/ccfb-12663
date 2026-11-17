// 设置页：网格精度、默认单位、对比阈值、缓存上限、播放倍速、撤销深度
import { store } from '../../core/store';
import { h, toast, numberInput, select, confirmDialog } from '../dom';
import { db, idbClear } from '../../core/db';
import type { UnitSystem } from '../../core/types';

export function renderSettingsPage(): HTMLElement {
  const wrap = h('div', { class: 'page' });
  wrap.append(h('div', { class: 'page-title' }, h('h2', {}, '设置')));
  const s = store.state.settings;

  const num = (key: keyof typeof s, step: number, labelText: string, min = 0) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), numberInput(s[key] as number, step, (v) => {
      store.commit(`修改设置 ${String(key)}`, (d) => {
        (d.settings as unknown as Record<string, number>)[key] = v;
      });
      store.undoDepth = store.state.settings.undoDepth;
    }, min));

  const unitSel = select(
    [
      { value: 'mm-t-s-MPa', text: '毫米 / 秒 / MPa（工程默认）' },
      { value: 'mm-g-s', text: '毫米 / 克 / 秒' },
      { value: 'm-kg-s', text: '米 / 千克 / 秒（SI）' },
    ],
    s.defaultUnit,
    (v) => store.commit('切换单位制', (d) => { d.settings.defaultUnit = v as UnitSystem; }),
  );

  const general = h('div', { class: 'card' }, h('h3', {}, '通用'), h('div', { class: 'grid cols-3' },
    num('defaultMeshTargetEdge', 0.1, '默认网格目标边长 (mm)', 0.1),
    num('compareThresholdPercent', 1, '方案对比告警阈值 (%)', 1),
    num('defaultPlaybackSpeed', 0.25, '动画默认倍速', 0.25),
    num('cacheLimit', 1, '结果缓存上限（条）', 1),
    num('undoDepth', 10, '撤销栈深度（步）', 10),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, '默认单位制'), unitSel),
  ));

  // 缓存管理
  const cacheCard = h('div', { class: 'card' }, h('h3', {}, '本地数据管理'));
  const cacheInfo = h('div', { class: 'muted' }, '统计中…');
  cacheCard.append(cacheInfo);
  void db.listResults().then((results) => {
    const bytes = new Blob(
      results.flatMap((r) => [r.fillTimes as BlobPart, r.peakPressures as BlobPart]),
    ).size;
    cacheInfo.textContent = `已缓存 ${results.length} 条仿真结果（约 ${(bytes / 1024).toFixed(0)} KB），全部存储于本机 IndexedDB，不上传任何服务器。`;
  });
  cacheCard.append(h('div', { class: 'btn-row', style: { marginTop: '12px' } }, h('button', {
    class: 'btn danger',
    onclick: () => {
      if (!confirmDialog('确认清空全部仿真结果缓存？方案与材料数据不受影响，下次仿真将重新计算。')) return;
      void idbClear('results').then(() => {
        toast('结果缓存已清空', 'success');
      });
    },
  }, '清空结果缓存'), h('button', {
    class: 'btn danger',
    onclick: () => {
      if (!confirmDialog('危险操作：确认清空浏览器中的全部项目、方案、材料与结果？此操作不可恢复。')) return;
      Promise.all(['projects', 'schemes', 'materials', 'results', 'tasks'].map((name) => idbClear(name as never))).then(() => {
        toast('本地数据已全部清空，即将刷新…', 'success');
        setTimeout(() => location.reload(), 1200);
      });
    },
  }, '清空全部本地数据')));

  const shortcuts = h('div', { class: 'card' }, h('h3', {}, '快捷键'), h('div', { class: 'row-gap' },
    h('div', {}, h('span', { class: 'kbd' }, 'Ctrl'), ' + ', h('span', { class: 'kbd' }, 'Z'), ' 撤销'),
    h('div', {}, h('span', { class: 'kbd' }, 'Ctrl'), ' + ', h('span', { class: 'kbd' }, 'Y'), ' / ', h('span', { class: 'kbd' }, 'Ctrl+Shift+Z'), ' 重做'),
    h('div', {}, '视口：左键旋转 · Shift+拖拽 或右键平移 · 滚轮缩放'),
  ));

  wrap.append(general, cacheCard, shortcuts);
  return wrap;
}
