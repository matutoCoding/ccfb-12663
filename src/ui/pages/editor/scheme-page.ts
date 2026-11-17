// 方案编辑页：几何导入检查、网格剖分、浇口拾取、工艺/材料参数、发起仿真
import { store, type AppState } from '../../../core/store';
import { createScheme } from '../../../core/factories';
import { BUILTIN_MODELS } from '../../../geometry/builtin';
import { checkMesh } from '../../../geometry/mesh-check';
import { importGeometryFile } from '../../../geometry/importers';
import { h, toast, confirmDialog, filePicker, iconButton, label, select } from '../../dom';
import { createViewport, type ViewportHandle } from '../../viewport';
import type { Gate, Scheme } from '../../../core/types';
import { uid } from '../../../core/utils';
import { renderMeshPanel } from './mesh-panel';
import { renderGatePanel } from './gate-panel';
import { renderProcessPanel } from './process-panel';
import { renderResultPanel } from './result-panel';

export interface EditorContext {
  viewport: ViewportHandle;
  scheme: Scheme;
  refresh: () => void;
}

export function renderSchemePage(projectId: string, onNavigate: (page: string) => void): HTMLElement {
  const project = store.state.projects.find((p) => p.id === projectId);
  const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' } });
  if (!project) {
    wrap.append(h('div', { class: 'empty-state' }, '项目不存在，请返回项目列表'));
    return wrap;
  }

  const schemes = store.state.schemes.filter((s) => s.projectId === projectId);
  const currentId = store.state.currentSchemeId && schemes.some((s) => s.id === store.state.currentSchemeId)
    ? store.state.currentSchemeId
    : schemes[0]?.id ?? null;
  if (currentId) store.patch((d) => { d.currentSchemeId = currentId; });

  // ---- 顶部方案标签栏 ----
  const tabBar = h('div', { class: 'scheme-tabs', style: { padding: '10px 12px 0' } });
  const layout = h('div', { class: 'scheme-layout' });

  function renderTabs() {
    tabBar.innerHTML = '';
    const list = store.state.schemes.filter((s) => s.projectId === projectId);
    for (const s of list) {
      tabBar.append(
        h('button', {
          class: `scheme-tab ${s.id === store.state.currentSchemeId ? 'active' : ''}`,
          onclick: () => {
            store.selectScheme(s.id);
            mountEditor();
          },
        }, s.name),
      );
    }
    tabBar.append(
      h('button', {
        class: 'btn small',
        onclick: () => {
          const name = window.prompt('新方案名称', `方案 ${list.length + 1}`);
          if (!name?.trim()) return;
          const materialId = store.state.materials[0]?.id;
          if (!materialId) return toast('材料库为空，请先在材料库创建材料', 'error');
          const scheme = createScheme(projectId, materialId, name.trim(), store.state.settings.defaultMeshTargetEdge);
          store.commit('新建方案', (d) => {
            d.schemes.push(scheme);
            const proj = d.projects.find((p) => p.id === projectId);
            proj?.schemeIds.push(scheme.id);
            d.currentSchemeId = scheme.id;
          });
          mountEditor();
        },
      }, '＋ 新方案'),
      h('button', {
        class: 'btn small',
        onclick: () => {
          const cur = store.currentScheme();
          if (!cur) return;
          const copy = structuredClone(cur);
          copy.id = uid('sch');
          copy.name = `${cur.name} - 副本`;
          copy.createdAt = Date.now();
          copy.updatedAt = Date.now();
          copy.gates = cur.gates.map((g) => ({ ...g, id: uid('gate') }));
          store.commit('复制方案', (d) => {
            d.schemes.push(copy);
            d.projects.find((p) => p.id === projectId)?.schemeIds.push(copy.id);
            d.currentSchemeId = copy.id;
          });
          mountEditor();
        },
      }, '复制方案'),
      h('button', {
        class: 'btn small danger',
        onclick: () => {
          const cur = store.currentScheme();
          if (!cur) return;
          if (!confirmDialog(`确认删除方案「${cur.name}」？`)) return;
          store.commit('删除方案', (d) => {
            d.schemes = d.schemes.filter((s) => s.id !== cur.id);
            const proj = d.projects.find((p) => p.id === projectId);
            if (proj) proj.schemeIds = proj.schemeIds.filter((id) => id !== cur.id);
            d.currentSchemeId = d.projects.find((p) => p.id === projectId)?.schemeIds[0] ?? null;
          });
          mountEditor();
        },
      }, '删除方案'),
      h('div', { style: { flex: '1' } }),
      h('button', { class: 'btn small', onclick: () => onNavigate('tasks') }, '任务队列 →'),
    );
  }

  const viewport = createViewport();
  let ctx: EditorContext | null = null;

  function mountEditor() {
    renderTabs();
    layout.innerHTML = '';
    const scheme = store.currentScheme();
    if (!scheme) {
      layout.append(h('div', { class: 'empty-state', style: { gridColumn: '1 / -1' } }, '该项目还没有方案，点击「＋ 新方案」开始'));
      return;
    }
    ctx = {
      viewport,
      scheme,
      refresh: mountEditor,
    };
    const left = h('div', { class: 'side-panel scroll-y' }, renderGeometrySection(ctx), renderMeshPanel(ctx));
    const center = h('div', { style: { display: 'flex', 'flex-direction': 'column', minHeight: 0, gap: '10px' } }, viewport.element, renderViewportToolbar(ctx));
    const right = h('div', { class: 'side-panel scroll-y' }, renderGatePanel(ctx), renderProcessPanel(ctx), renderResultPanel(ctx));
    layout.append(left, center, right);

    if (scheme.mesh) {
      viewport.setMesh(scheme.mesh);
      viewport.setMarkers(buildGateMarkers(scheme));
    }
  }

  wrap.append(tabBar, layout);
  mountEditor();
  return wrap;
}

// ---------------- 几何来源区 ----------------
function renderGeometrySection(ctx: EditorContext): HTMLElement {
  const card = h('div', { class: 'card' });
  const s = ctx.scheme;
  const modelOptions = [
    { value: 'cover-plate', text: BUILTIN_MODELS['cover-plate'].name },
    { value: 'phone-case', text: BUILTIN_MODELS['phone-case'].name },
  ];
  const currentBuiltin = s.geometrySource.kind === 'builtin' ? s.geometrySource.modelId : 'cover-plate';

  const modelSel = select(modelOptions, currentBuiltin, () => {});
  const loadBtn = h('button', {
    class: 'btn primary small',
    onclick: () => {
      const modelId = modelSel.value as 'cover-plate' | 'phone-case';
      const mesh = BUILTIN_MODELS[modelId].build();
      const check = checkMesh(mesh);
      store.commit('加载内置模型', (d) => {
        const sc = mustUpdate(d, s.id);
        sc.geometrySource = { kind: 'builtin', modelId };
        sc.mesh = mesh;
        sc.meshCheck = check;
        sc.gates = [];
        sc.updatedAt = Date.now();
      });
      ctx!.refresh();
      toast(`已加载${BUILTIN_MODELS[modelId].name}：${mesh.nodeCount} 节点 / ${mesh.triangleCount} 面`, 'success');
    },
  }, '加载内置模型');

  const importBtn = h('button', {
    class: 'btn small',
    onclick: async () => {
      const [file] = await filePicker('.stl,.obj');
      if (!file) return;
      try {
        const thickness = s.uniformThickness > 0 ? s.uniformThickness : 2;
        const imported = await importGeometryFile(file, thickness);
        const check = checkMesh(imported.mesh);
        store.commit('导入几何模型', (d) => {
          const sc = mustUpdate(d, s.id);
          sc.geometrySource = { kind: 'import', fileName: file.name, importedAt: Date.now() };
          sc.mesh = imported.mesh;
          sc.meshCheck = check;
          sc.gates = [];
          sc.updatedAt = Date.now();
        });
        for (const w of imported.warnings) toast(w, 'warning' as never);
        ctx!.refresh();
        toast(`模型「${file.name}」导入并检查完成：${imported.mesh.nodeCount} 节点 / ${imported.mesh.triangleCount} 面`, 'success', 4500);
      } catch (e) {
        toast(`导入失败：${(e as Error).message}`, 'error', 5000);
      }
    },
  }, '导入 STL / OBJ');

  card.append(
    h('h3', {}, '① 几何模型'),
    h('div', { class: 'row-gap' }, label('系统测试模型（无文件也能跑通全流程）', modelSel), h('div', { class: 'btn-row' }, loadBtn, importBtn)),
    h('div', { class: 'muted', style: { 'margin-top': '8px', 'font-size': '12px' } },
      s.geometrySource.kind === 'builtin'
        ? `当前：${BUILTIN_MODELS[s.geometrySource.modelId].name}`
        : s.geometrySource.kind === 'import'
          ? `当前导入：${s.geometrySource.fileName}`
          : '尚未选择几何'),
    renderCheckResult(s),
  );
  return card;
}

export function renderCheckResult(s: Scheme): HTMLElement {
  const box = h('div', { style: { marginTop: '10px' } });
  if (!s.meshCheck) {
    box.append(h('div', { class: 'muted' }, '尚未生成网格'));
    return box;
  }
  const c = s.meshCheck;
  const headTag = c.ok ? h('span', { class: 'tag green' }, '检查通过') : h('span', { class: 'tag red' }, '存在错误');
  box.append(h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'center', 'margin-bottom': '8px' } }, headTag, h('span', { class: 'muted mono', style: { 'font-size': '12px' } }, `${s.mesh?.nodeCount ?? 0} 节点 · ${s.mesh?.triangleCount ?? 0} 面 · ${c.edgeCount} 边`)));
  for (const issue of c.issues) {
    box.append(h('div', { class: `check-issue ${issue.level}` }, issue.message));
  }
  return box;
}

// ---------------- 视口工具条 ----------------
function renderViewportToolbar(ctx: EditorContext): HTMLElement {
  const bar = h('div', { class: 'viewport-toolbar' });
  bar.append(
    iconButton('复位视角', '⟲', () => ctx.viewport.resetView()),
    h('button', {
      class: 'btn small',
      onclick: () => {
        const on = !pickMode;
        pickMode = on;
        ctx.viewport.setPicking(on);
        (bar.children[1] as HTMLElement).classList.toggle('primary', on);
        toast(on ? '浇口拾取模式：在模型表面点击放置浇口，按 Shift 拖拽平移视角' : '已退出拾取模式', 'info', 2500);
      },
    }, '📍 拾取浇口'),
  );

  let pickMode = false;
  ctx.viewport.onPick = (hit) => {
    const s = store.currentScheme();
    if (!s?.mesh) return;
    const gate: Gate = {
      id: uid('gate'),
      name: `浇口 ${s.gates.length + 1}`,
      nodeIndex: hit.nodeIndex,
      pickX: hit.x,
      pickY: hit.y,
      pickZ: hit.z,
      openTime: 0,
      weight: 1,
    };
    store.commit('添加浇口', (d) => {
      mustUpdate(d, s.id).gates.push(gate);
    });
    ctx.refresh();
    toast(`已在节点 #${hit.nodeIndex} 放置${gate.name}`, 'success', 2200);
  };
  return bar;
}

export function buildGateMarkers(s: Scheme): { id: string; x: number; y: number; z: number; color: [number, number, number]; size: number }[] {
  return s.gates.map((g) => ({ id: g.id, x: g.pickX, y: g.pickY, z: g.pickZ, color: [0.98, 0.3, 0.2], size: 18 }));
}

export function mustUpdate(d: AppState, schemeId: string): Scheme {
  const sc = d.schemes.find((x) => x.id === schemeId);
  if (!sc) throw new Error('方案不存在');
  sc.updatedAt = Date.now();
  return sc;
}
