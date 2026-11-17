// ③ 浇口面板：多浇口列表、开启时间、权重、删除/重设
import { store } from '../../../core/store';
import { h, toast, numberInput, confirmDialog } from '../../dom';
import { mustUpdate, type EditorContext } from './scheme-page';

export function renderGatePanel(ctx: EditorContext): HTMLElement {
  const card = h('div', { class: 'card' });
  const s = ctx.scheme;

  const head = h('div', { style: { display: 'flex', 'align-items': 'center', 'justify-content': 'space-between' } }, h('h3', { style: { margin: '0' } }, '③ 浇口设置'), h('span', { class: 'tag blue' }, `${s.gates.length} 个`));

  if (s.gates.length === 0) {
    card.append(head, h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } }, '点击视口上方「📍 拾取浇口」，在模型表面直接点选；可放置多个'));
    return card;
  }

  const list = h('div', { style: { marginTop: '10px' } });
  s.gates.forEach((g, idx) => {
    const item = h('div', { class: 'list-item' }, h('span', { class: 'dot red' }), h('div', { class: 'grow' }, h('div', {}, g.name), h('div', { class: 'muted mono', style: { fontSize: '11px' } }, `节点 #${g.nodeIndex} · (${g.pickX.toFixed(1)}, ${g.pickY.toFixed(1)}, ${g.pickZ.toFixed(1)})`)));
    const openInput = numberInput(g.openTime, 0.01, (v) => {
      store.commit('修改浇口开启时间', (d) => {
        const target = mustUpdate(d, s.id).gates.find((x) => x.id === g.id);
        if (target) target.openTime = v;
      });
    }, 0);
    openInput.style.width = '72px';
    const weightInput = numberInput(g.weight, 0.1, (v) => {
      store.commit('修改浇口权重', (d) => {
        const target = mustUpdate(d, s.id).gates.find((x) => x.id === g.id);
        if (target) target.weight = v;
      });
    }, 0.1);
    weightInput.style.width = '60px';

    const locateBtn = h('button', {
      class: 'btn small',
      title: '视角飞到该浇口',
      onclick: () => ctx.viewport.flyTo(g.pickX, g.pickY, g.pickZ),
    }, '定位');
    const delBtn = h('button', {
      class: 'btn small danger',
      onclick: () => {
        store.commit('删除浇口', (d) => {
          const sc = mustUpdate(d, s.id);
          sc.gates = sc.gates.filter((x) => x.id !== g.id);
        });
        ctx.refresh();
      },
    }, '删除');
    list.append(
      item,
      h('div', { class: 'inline-fields', style: { margin: '4px 0 10px 18px' } }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, '开启时间 s'), openInput), h('label', { class: 'field' }, h('span', { class: 'field-label' }, '流量权重'), weightInput), locateBtn, delBtn),
    );
    void idx;
  });

  const resetBtn = h('button', {
    class: 'btn small danger',
    onclick: () => {
      if (!confirmDialog('确认清空全部浇口并重新设置？')) return;
      store.commit('重设浇口', (d) => {
        mustUpdate(d, s.id).gates = [];
      });
      ctx.refresh();
      toast('浇口已全部清空', 'info');
    },
  }, '清空重设');

  card.append(head, list, resetBtn);
  return card;
}
