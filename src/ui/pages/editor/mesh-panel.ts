// ② 网格面板：细化/粗化在 WebWorker 执行，界面不卡死，可取消
import { store } from '../../../core/store';
import { h, toast, numberInput } from '../../dom';
import { runRemesh } from '../../../workers/worker-client';
import type { MeshJob } from '../../../workers/worker-client';
import { mustUpdate, type EditorContext } from './scheme-page';

export function renderMeshPanel(ctx: EditorContext): HTMLElement {
  const card = h('div', { class: 'card' });
  const s = ctx.scheme;
  const status = h('div', { class: 'muted mono', style: { 'font-size': '12px' } }, s.mesh ? `当前 ${s.mesh.nodeCount} 节点 / ${s.mesh.triangleCount} 面` : '请先加载几何');

  const edgeInput = numberInput(s.meshParams.targetEdgeLength, 0.1, (v) => {
    store.commit('调整目标边长', (d) => {
      mustUpdate(d, s.id).meshParams.targetEdgeLength = v;
    });
  }, 0.1);

  const progressWrap = h('div', { style: { display: 'none' } }, h('div', { class: 'progress' }, h('div', { class: 'progress-bar', style: { width: '0%' } })), h('div', { class: 'muted', style: { 'font-size': '12px', marginTop: '6px' } }, '准备中…'));

  let job: MeshJob | null = null;

  const start = (mode: 'refine' | 'coarsen') => {
    const cur = store.currentScheme();
    if (!cur?.mesh) return toast('请先加载几何模型', 'error');
    const params = cur.meshParams;
    const bar = progressWrap.querySelector('.progress-bar') as HTMLElement;
    const text = progressWrap.querySelectorAll('div')[1] as HTMLElement;
    progressWrap.style.display = 'block';
    bar.style.width = '0%';
    bar.className = 'progress-bar';

    job = runRemesh(
      cur.mesh,
      mode,
      params.targetEdgeLength,
      mode === 'refine' ? params.maxRefineIterations : params.maxCoarsenIterations,
      (percent, nodeCount, triCount) => {
        bar.style.width = `${percent}%`;
        text.textContent = `${mode === 'refine' ? '细化' : '粗化'}中 ${percent}% · ${nodeCount} 节点 / ${triCount} 面（界面仍可操作）`;
      },
    );
    job.promise
      .then(({ mesh, check }) => {
        store.commit(mode === 'refine' ? '网格细化' : '网格粗化', (d) => {
          const sc = mustUpdate(d, cur.id);
          sc.mesh = mesh;
          sc.meshCheck = check;
          sc.gates = []; // 网格变化后节点索引失效，浇口需重新拾取
        });
        progressWrap.style.display = 'none';
        ctx.refresh();
        toast(`剖分完成：${mesh.nodeCount} 节点 / ${mesh.triangleCount} 面`, 'success');
      })
      .catch((e: Error) => {
        progressWrap.style.display = 'none';
        if (e.message !== 'cancel') toast(`剖分失败：${e.message}`, 'error', 5000);
      });
  };

  const refineBtn = h('button', { class: 'btn primary small', onclick: () => start('refine') }, '细化');
  const coarsenBtn = h('button', { class: 'btn small', onclick: () => start('coarsen') }, '粗化');
  const cancelBtn = h('button', {
    class: 'btn small danger',
    onclick: () => {
      job?.cancel();
      toast('已请求取消剖分', 'info');
    },
  }, '取消');

  card.append(
    h('h3', {}, '② 网格剖分（WebWorker 后台执行）'),
    h('div', { class: 'row-gap' }, h('label', { class: 'field' }, h('span', { class: 'field-label' }, '目标边长 (mm)，越小越细'), edgeInput), status),
    h('div', { class: 'btn-row', style: { marginTop: '10px' } }, refineBtn, coarsenBtn, cancelBtn),
    progressWrap,
  );
  return card;
}
