// 材料库页：粘度模型参数、导热系数、固化温度等维护；改参数后在同方案重算对比
import { store, type AppState } from '../../core/store';
import { blankMaterial } from '../../core/materials';
import { h, toast, confirmDialog, numberInput } from '../dom';
import type { Material } from '../../core/types';

export function renderMaterialsPage(): HTMLElement {
  const wrap = h('div', { class: 'page' });
  const header = h('div', { class: 'page-title' }, h('h2', {}, '材料库'), h('span', { class: 'muted' }, `共 ${store.state.materials.length} 种材料，数据仅存本地浏览器`));
  const addBtn = h('button', {
    class: 'btn primary',
    onclick: () => {
      const m = blankMaterial();
      store.commit('新建材料', (d) => d.materials.push(m));
      toast('已创建新材料，可直接编辑参数（自动保存）', 'success');
    },
  }, '＋ 新材料');
  wrap.append(header, h('div', { style: { marginBottom: '16px' } }, addBtn));

  const list = h('div', { class: 'grid cols-2' });
  for (const m of store.state.materials) list.append(renderMaterialCard(m));
  wrap.append(list);
  return wrap;
}

function renderMaterialCard(m: Material): HTMLElement {
  const card = h('div', { class: 'card' });
  const nameInput = h('input', { value: m.name, oninput: () => store.commit('编辑材料名', (d) => { find(d, m.id).name = nameInput.value; }) }) as HTMLInputElement;
  const catInput = h('input', { value: m.category, oninput: () => store.commit('编辑材料类别', (d) => { find(d, m.id).category = catInput.value; }) }) as HTMLInputElement;

  const num = (key: keyof Material, step: number, labelText: string, min = 0) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), numberInput(m[key] as number, step, (v) => store.commit(`编辑材料参数 ${String(key)}`, (d) => {
      const target = find(d, m.id) as unknown as Record<string, number>;
      target[key] = v;
    }), min));

  const modelSel = h('select', { onchange: () => store.commit('切换粘度模型', (d) => { find(d, m.id).viscosityModel = modelSel.value as Material['viscosityModel']; }) },
    h('option', { value: 'cross-wlf', selected: m.viscosityModel === 'cross-wlf' }, 'Cross-WLF'),
    h('option', { value: 'carreau', selected: m.viscosityModel === 'carreau' }, 'Carreau'),
  );

  card.append(
    h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, h('div', { style: { flex: '1' } }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, '材料名称'), nameInput)), m.builtin ? h('span', { class: 'tag blue' }, '内置') : h('span', { class: 'tag gray' }, '自定义')),
    h('div', { class: 'grid cols-2', style: { marginTop: '10px' } }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, '类别'), catInput), h('label', { class: 'field' }, h('span', { class: 'field-label' }, '粘度模型'), modelSel)),
    h('h3', { style: { margin: '14px 0 8px', fontSize: '13px' } }, '粘度参数'),
    h('div', { class: 'grid cols-2' },
      num('zeroShearViscosity', 100, '零剪切粘度 η0 (Pa·s)', 1),
      num('crossN', 0.01, 'Cross 幂律指数 n', 0.01),
      num('crossTauStar', 100, 'Cross 临界应力 τ* (Pa)', 1),
      num('wlfC1', 0.1, 'WLF C1'),
      num('wlfC2', 0.1, 'WLF C2'),
      num('wlfTRef', 1, 'WLF 参考温度 (K)', 1),
      num('carreauLambda', 0.01, 'Carreau λ (s)'),
      num('carreauN', 0.01, 'Carreau n', 0.01),
    ),
    h('h3', { style: { margin: '14px 0 8px', fontSize: '13px' } }, '热物性与工艺'),
    h('div', { class: 'grid cols-2' },
      num('thermalConductivity', 0.01, '导热系数 W/(m·K)'),
      num('specificHeat', 10, '比热容 J/(kg·K)'),
      num('density', 1, '密度 kg/m³', 1),
      num('solidificationTemperature', 1, '固化温度 (℃)'),
      num('processTempLow', 1, '加工温度下限 (℃)'),
      num('processTempHigh', 1, '加工温度上限 (℃)'),
    ),
  );

  if (!m.builtin) {
    card.append(h('div', { style: { marginTop: '14px' } }, h('button', {
      class: 'btn small danger',
      onclick: () => {
        if (!confirmDialog(`确认删除材料「${m.name}」？使用该材料的方案将需要重新选择材料。`)) return;
        store.commit('删除材料', (d) => { d.materials = d.materials.filter((x) => x.id !== m.id); });
        toast('材料已删除', 'info');
      },
    }, '删除材料')));
  } else {
    card.append(h('div', { class: 'muted', style: { marginTop: '12px', fontSize: '12px' } }, '内置材料为参考参数，可直接修改；删除项目不影响已有仿真结果缓存。'));
  }
  return card;
}

function find(d: AppState, id: string): Material {
  const m = d.materials.find((x) => x.id === id);
  if (!m) throw new Error('材料不存在');
  return m;
}
