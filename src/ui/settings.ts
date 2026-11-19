// 设置页:网格精度、默认单位、对比阈值、动画速度
import { store } from '../store.js';
import { el } from '../util.js';
import { Settings } from '../types.js';

export function renderSettings(root: HTMLElement): () => void {
  const draw = () => {
    const s = store.settings;
    root.innerHTML = '';
    const panel = el('div', { class: 'panel', style: 'max-width:560px' });
    panel.append(el('h2', {}, '设置'));

    const row = (label: string, input: HTMLElement, hint = '') =>
      el('label', { class: 'field' }, el('span', { style: 'min-width:160px' }, label), input, hint ? el('span', { class: 'muted' }, hint) : '');

    const meshSel = el('select', {});
    for (let l = 0; l <= 3; l++) meshSel.append(el('option', { value: String(l) }, `级别 ${l}`));
    meshSel.value = String(s.meshLevel);

    const lenSel = el('select', {});
    lenSel.append(el('option', { value: 'mm' }, '毫米 mm'), el('option', { value: 'inch' }, '英寸 inch'));
    lenSel.value = s.lengthUnit;

    const pSel = el('select', {});
    pSel.append(el('option', { value: 'MPa' }, 'MPa'), el('option', { value: 'bar' }, 'bar'));
    pSel.value = s.pressureUnit;

    const thresholdInput = el('input', { type: 'number', value: String(s.compareThresholdPct), min: '1', max: '100' });
    const speedSel = el('select', {});
    for (const v of [0.1, 0.25, 0.5, 1, 2, 4]) speedSel.append(el('option', { value: String(v) }, v + '×'));
    speedSel.value = String(s.animSpeed);
    const maxElInput = el('input', { type: 'number', value: String(s.maxElements), min: '1000', step: '10000' });

    panel.append(
      el('h3', {}, '网格'),
      row('默认细分级别', meshSel, '级别越高网格越密,计算越慢'),
      row('单元数上限', maxElInput, '超过则拒绝计算(默认 100000)'),
      el('h3', {}, '单位'),
      row('长度单位', lenSel),
      row('压力单位', pSel),
      el('h3', {}, '对比与显示'),
      row('对比差异阈值 (%)', thresholdInput, '超过此比例在对比表中标红'),
      row('默认动画速度', speedSel),
    );

    const saveBtn = el('button', { class: 'primary', style: 'margin-top:12px' }, '保存设置');
    const msg = el('span', { class: 'ok', style: 'margin-left:10px' });
    saveBtn.onclick = async () => {
      const ns: Settings = {
        meshLevel: parseInt(meshSel.value),
        lengthUnit: lenSel.value as Settings['lengthUnit'],
        pressureUnit: pSel.value as Settings['pressureUnit'],
        compareThresholdPct: Math.max(1, parseFloat(thresholdInput.value) || 10),
        animSpeed: parseFloat(speedSel.value),
        maxElements: Math.max(1000, parseInt(maxElInput.value) || 100000),
      };
      await store.saveSettings(ns);
      msg.textContent = '已保存';
      setTimeout(() => { msg.textContent = ''; }, 2000);
    };
    panel.append(saveBtn, msg);
    root.append(panel);
  };
  draw();
  return store.onChange(draw);
}
