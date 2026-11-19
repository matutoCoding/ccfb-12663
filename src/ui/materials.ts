// 材料库页:维护粘度模型与热物性参数,支持在同方案上重算对比
import { store } from '../store.js';
import { el, uid } from '../util.js';
import { Material } from '../types.js';

const FIELDS: [keyof Material, string, string][] = [
  ['name', '名称', ''],
  ['n', '幂律指数 n', ''],
  ['tauStar', '过渡剪切应力 τ* (Pa)', ''],
  ['d1', 'WLF D1 (Pa·s)', ''],
  ['d2', 'WLF D2 (K)', ''],
  ['d3', 'WLF D3 (K/Pa)', ''],
  ['a1', 'WLF A1', ''],
  ['a2', 'WLF A2 (K)', ''],
  ['thermalConductivity', '导热系数 (W/m·K)', ''],
  ['specificHeat', '比热 (J/kg·K)', ''],
  ['density', '密度 (kg/m³)', ''],
  ['noFlowTemp', '固化温度 (℃)', ''],
  ['defaultMeltTemp', '默认熔体温度 (℃)', ''],
  ['defaultMoldTemp', '默认模具温度 (℃)', ''],
];

export function renderMaterials(root: HTMLElement): () => void {
  let editing: Material | null = null;

  const draw = () => {
    root.innerHTML = '';
    const panel = el('div', { class: 'panel' });
    panel.append(el('div', { class: 'toolbar' },
      el('h2', {}, '材料库'),
      el('span', { class: 'spacer' }),
      (() => {
        const b = el('button', { class: 'primary' }, '+ 新建材料');
        b.onclick = () => {
          editing = {
            id: uid('mat'), name: '新材料',
            n: 0.3, tauStar: 3e4, d1: 1e11, d2: 323.15, d3: 0, a1: 26, a2: 51.6,
            thermalConductivity: 0.2, specificHeat: 2000, density: 1000,
            noFlowTemp: 60, defaultMeltTemp: 240, defaultMoldTemp: 60,
          };
          draw();
        };
        return b;
      })(),
    ));

    const wrap = el('div', { class: editing ? 'grid2' : '' });
    // 列表
    const table = el('table', { class: 'list' });
    table.append(el('tr', {}, el('th', {}, '材料'), el('th', {}, '固化温度'), el('th', {}, '导热系数'), el('th', {}, '默认熔温'), el('th', {}, '操作')));
    for (const m of store.materials) {
      table.append(el('tr', {},
        el('td', {}, m.name, m.builtin ? el('span', { class: 'tag' }, ' 内置') : ''),
        el('td', {}, m.noFlowTemp + ' ℃'),
        el('td', {}, m.thermalConductivity + ' W/m·K'),
        el('td', {}, m.defaultMeltTemp + ' ℃'),
        el('td', {},
          (() => { const b = el('button', { class: 'small' }, '编辑'); b.onclick = () => { editing = JSON.parse(JSON.stringify(m)); draw(); }; return b; })(),
          ' ',
          (() => { const b = el('button', { class: 'small' }, '复制'); b.onclick = async () => { const c = JSON.parse(JSON.stringify(m)) as Material; c.id = uid('mat'); c.name += ' 副本'; c.builtin = false; await store.saveMaterial(c); }; return b; })(),
          ' ',
          m.builtin ? '' : (() => { const b = el('button', { class: 'small danger' }, '删除'); b.onclick = async () => { if (confirm(`删除材料「${m.name}」?`)) await store.deleteMaterial(m.id); }; return b; })(),
        ),
      ));
    }
    wrap.append(table);

    // 编辑表单
    if (editing) {
      const form = el('div', { class: 'panel' });
      form.append(el('h3', {}, '编辑材料(Cross-WLF 粘度模型)'));
      const inputs = new Map<keyof Material, HTMLInputElement>();
      for (const [key, label] of FIELDS) {
        const input = el('input', { type: key === 'name' ? 'text' : 'number', step: 'any', value: String(editing[key] ?? ''), style: 'width:160px' });
        inputs.set(key, input);
        form.append(el('label', { class: 'field' }, el('span', { style: 'min-width:150px' }, label), input));
      }
      form.append(el('div', { class: 'row', style: 'margin-top:10px' },
        (() => {
          const b = el('button', { class: 'primary' }, '保存');
          b.onclick = async () => {
            const m = editing!;
            for (const [key] of FIELDS) {
              const v = inputs.get(key)!.value;
              if (key === 'name') m.name = v;
              else (m[key] as number) = parseFloat(v) || 0;
            }
            m.builtin = false;
            await store.saveMaterial(m);
            editing = null;
            draw();
          };
          return b;
        })(),
        (() => { const b = el('button', {}, '取消'); b.onclick = () => { editing = null; draw(); }; return b; })(),
      ));
      form.append(el('p', { class: 'muted' },
        '对比不同材料参数:先「复制」一份材料并修改参数,在方案副本中换用新材料,两个方案各自提交仿真后,到项目页勾选它们做对比(同参数结果走缓存,不会重算)。'));
      wrap.append(form);
    }
    panel.append(wrap);
    root.append(panel);
  };
  draw();
  return store.onChange(() => { if (!editing) draw(); });
}
