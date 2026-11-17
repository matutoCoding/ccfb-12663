// ④ 工艺与材料面板：流量/温度/压力上限 + 材料选择 + 壁厚
import { store } from '../../../core/store';
import { h, numberInput, select } from '../../dom';
import { mustUpdate, type EditorContext } from './scheme-page';

export function renderProcessPanel(ctx: EditorContext): HTMLElement {
  const card = h('div', { class: 'card' });
  const s = ctx.scheme;
  const p = s.process;

  const field = (labelText: string, value: number, step: number, min: number, apply: (v: number) => void) =>
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), numberInput(value, step, apply, min));

  card.append(
    h('h3', {}, '④ 工艺参数'),
    h('div', { class: 'grid cols-2' },
      field('体积流量 (mm³/s)', p.flowRate, 100, 1, (v) => store.commit('修改流量', (d) => { mustUpdate(d, s.id).process.flowRate = v; })),
      field('熔体温度 (℃)', p.meltTemperature, 1, 0, (v) => store.commit('修改熔体温度', (d) => { mustUpdate(d, s.id).process.meltTemperature = v; })),
      field('模具温度 (℃)', p.moldTemperature, 1, 0, (v) => store.commit('修改模温', (d) => { mustUpdate(d, s.id).process.moldTemperature = v; })),
      field('最大注射压力 (MPa)', p.maxInjectionPressure, 5, 1, (v) => store.commit('修改压力上限', (d) => { mustUpdate(d, s.id).process.maxInjectionPressure = v; })),
      field('时间步长上限 (s)', p.maxTimeStep, 0.005, 0.001, (v) => store.commit('修改步长', (d) => { mustUpdate(d, s.id).process.maxTimeStep = v; })),
      field('统一壁厚 (mm，0=用网格)', s.uniformThickness, 0.1, 0, (v) => store.commit('修改壁厚', (d) => {
        const sc = mustUpdate(d, s.id);
        sc.uniformThickness = v;
        if (v > 0 && sc.mesh) sc.mesh = { ...sc.mesh, thickness: new Float32Array(sc.mesh.nodeCount).fill(v) };
      })),
    ),
  );

  const materialSel = select(
    store.state.materials.map((m) => ({ value: m.id, text: `${m.name}（${m.category}）` })),
    s.materialId,
    (v) => store.commit('切换材料', (d) => { mustUpdate(d, s.id).materialId = v; }),
  );
  card.append(
    h('div', { style: { marginTop: '12px' } }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, '材料（参数在材料库维护，改参数后可直接重算对比）'), materialSel)),
  );
  return card;
}
