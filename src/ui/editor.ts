// 方案编辑器:3D 视图、浇口点选、参数编辑、网格剖分、结果云图与动画
import { store } from '../store.js';
import { el, fmt, uid } from '../util.js';
import { Renderer, ViewMode } from '../render.js';
import { Gate, SimResult } from '../types.js';
import { checkMesh } from '../geometry.js';
import { generateReport } from './report.js';

function maxOf(a: Float32Array): number {
  let m = 0.01;
  for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
  return m;
}

export function renderEditor(root: HTMLElement, schemeId: string): () => void {
  const schemeMaybe = store.schemes.find(s => s.id === schemeId);
  if (!schemeMaybe) { root.textContent = '方案不存在'; return () => undefined; }
  const scheme = schemeMaybe;

  let renderer: Renderer | null = null;
  let result: SimResult | null = null;
  let gatePickMode = false;
  let playing = false;
  let animSpeed = store.settings.animSpeed;
  let rafId = 0;
  let disposed = false;

  // ---------- 布局 ----------
  root.innerHTML = '';
  const left = el('div', { class: 'col panel' });
  const right = el('div', { class: 'col panel' });
  const canvas = el('canvas', { id: 'viewport' }) as HTMLCanvasElement;
  const hint = el('div', { class: 'viewport-hint' }, '左键旋转 · 滚轮缩放 · 右键平移');
  const animBar = el('div', { class: 'anim-bar', style: 'display:none' });
  const viewportWrap = el('div', { class: 'viewport-wrap' }, canvas, hint, animBar);
  const grid = el('div', { class: 'editor' }, left, viewportWrap, right);
  root.append(grid);

  // ---------- 渲染器 ----------
  try {
    renderer = new Renderer(canvas);
  } catch (e) {
    root.textContent = (e as Error).message;
    return () => undefined;
  }
  const R = renderer;

  // 相机交互
  let dragging = 0, lastX = 0, lastY = 0, moved = 0;
  canvas.addEventListener('mousedown', e => { dragging = e.button; lastX = e.clientX; lastY = e.clientY; moved = 0; });
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', e => { e.preventDefault(); R.dist *= e.deltaY > 0 ? 1.1 : 0.9; }, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  function onMouseMove(e: MouseEvent): void {
    if (dragging === 0 && e.buttons === 0) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    lastX = e.clientX; lastY = e.clientY;
    if (dragging === 0 || e.buttons === 1) { R.yaw += dx * 0.008; R.pitch = Math.max(-1.5, Math.min(1.5, R.pitch + dy * 0.008)); }
    else if (dragging === 2 || e.buttons === 2) {
      const s = R.dist * 0.0012;
      const cy = Math.cos(R.yaw), sy = Math.sin(R.yaw);
      R.target[0] += (-sy * dx) * s;
      R.target[1] += (cy * dx) * s;
      R.target[2] += dy * s;
    }
  }
  function onMouseUp(e: MouseEvent): void {
    const wasDrag = moved > 5;
    dragging = -1;
    if (!wasDrag && gatePickMode && e.target === canvas) {
      const node = R.pick(e.clientX, e.clientY);
      if (node !== null) addGate(node);
    }
  }

  // ---------- 网格加载 ----------
  const meshInfoEl = el('div', {});
  const checkEl = el('div', {});
  async function loadMesh(): Promise<void> {
    meshInfoEl.textContent = '网格剖分中…';
    try {
      const { mesh, check } = await store.meshOf(scheme.model, scheme.meshLevel);
      if (disposed) return;
      R.setMesh(mesh.positions, mesh.triangles);
      meshInfoEl.innerHTML = `节点 <b>${mesh.positions.length / 3}</b> · 单元 <b>${mesh.triangles.length / 3}</b>` +
        (mesh.triangles.length / 3 > store.settings.maxElements
          ? ` <span class="danger">超过上限 ${store.settings.maxElements}</span>` : '');
      checkEl.innerHTML = '';
      for (const m of check.messages) {
        checkEl.append(el('div', { class: 'check-msg ' + (check.ok && !m.includes('边界') ? 'ok' : 'warn') }, m));
      }
      refreshMarkers();
      void refreshResult();
    } catch (e) {
      meshInfoEl.innerHTML = `<span class="danger">剖分失败:${(e as Error).message}</span>`;
    }
  }

  // ---------- 左栏:参数 ----------
  function buildLeft(): void {
    left.innerHTML = '';
    left.append(el('div', { class: 'toolbar' },
      el('a', { href: '#/project/' + scheme.projectId }, '← 返回'),
      el('h2', { style: 'margin:0' }, scheme.name),
    ));

    // 撤销重做
    const undoBtn = el('button', { class: 'small' }, '↩ 撤销');
    const redoBtn = el('button', { class: 'small' }, '↪ 重做');
    undoBtn.onclick = () => { store.undo(scheme.id); refreshAll(); };
    redoBtn.onclick = () => { store.redo(scheme.id); refreshAll(); };
    left.append(el('div', { class: 'row' }, undoBtn, redoBtn, el('span', { class: 'muted' }, '改动自动保存')));

    // 材料
    left.append(el('h3', {}, '材料'));
    const matSel = el('select', {});
    for (const m of store.materials) matSel.append(el('option', { value: m.id }, m.name));
    matSel.value = scheme.materialId;
    matSel.onchange = () => {
      store.snapshot(scheme.id);
      scheme.materialId = matSel.value;
      const mat = store.materials.find(m => m.id === matSel.value);
      if (mat) { scheme.process.meltTemp = mat.defaultMeltTemp; scheme.process.moldTemp = mat.defaultMoldTemp; }
      store.saveScheme(scheme);
      refreshAll();
    };
    left.append(el('label', { class: 'field' }, el('span', {}, '材料'), matSel));

    // 工艺参数
    left.append(el('h3', {}, '工艺参数'));
    const numField = (label: string, get: () => number, set: (v: number) => void, unit: string, step = 'any') => {
      const input = el('input', { type: 'number', step, value: String(get()) });
      input.onchange = () => {
        const v = parseFloat(input.value);
        if (!isFinite(v)) return;
        store.snapshot(scheme.id);
        set(v);
        store.saveScheme(scheme);
        refreshAll();
      };
      return el('label', { class: 'field' }, el('span', {}, label), input, unit);
    };
    left.append(
      numField('熔体温度', () => scheme.process.meltTemp, v => { scheme.process.meltTemp = v; }, '℃'),
      numField('模具温度', () => scheme.process.moldTemp, v => { scheme.process.moldTemp = v; }, '℃'),
      numField('注射速率', () => scheme.process.flowRate, v => { scheme.process.flowRate = v; }, 'cm³/s'),
      numField('压力上限', () => scheme.process.pressureLimit, v => { scheme.process.pressureLimit = v; }, 'MPa'),
      numField('壁厚', () => scheme.process.thickness, v => { scheme.process.thickness = v; }, 'mm', '0.1'),
    );

    // 网格
    left.append(el('h3', {}, '网格'));
    const levelSel = el('select', {});
    for (let l = 0; l <= 3; l++) levelSel.append(el('option', { value: String(l) }, `级别 ${l}${l === 0 ? '(粗)' : l === 3 ? '(细)' : ''}`));
    levelSel.value = String(scheme.meshLevel);
    levelSel.onchange = () => {
      store.snapshot(scheme.id);
      scheme.meshLevel = parseInt(levelSel.value);
      store.saveScheme(scheme);
      result = null;
      void loadMesh();
      refreshAll();
    };
    left.append(el('label', { class: 'field' }, el('span', {}, '细分级别'), levelSel));
    left.append(meshInfoEl, checkEl);

    // 操作
    left.append(el('h3', {}, '仿真'));
    const runBtn = el('button', { class: 'primary', style: 'width:100%' }, '▶ 提交仿真');
    runBtn.onclick = async () => {
      try {
        await store.submitTask(scheme.id);
        location.hash = '#/tasks';
      } catch (e) { alert((e as Error).message); }
    };
    left.append(runBtn);
  }

  // ---------- 右栏:浇口 + 结果 ----------
  const gatesEl = el('div', {});
  const resultEl = el('div', {});

  function buildRight(): void {
    right.innerHTML = '';
    // 浇口
    const pickBtn = el('button', { class: gatePickMode ? 'primary' : '' }, gatePickMode ? '点击模型放置浇口…' : '+ 添加浇口');
    pickBtn.onclick = () => {
      gatePickMode = !gatePickMode;
      hint.textContent = gatePickMode ? '在模型上点击放置浇口(再次点击按钮退出)' : '左键旋转 · 滚轮缩放 · 右键平移';
      buildRight();
    };
    right.append(el('h3', {}, '浇口'), pickBtn, gatesEl);
    right.append(el('h3', {}, '结果'), resultEl);
    refreshGates();
  }

  function refreshGates(): void {
    gatesEl.innerHTML = '';
    if (scheme.gates.length === 0) gatesEl.append(el('p', { class: 'muted' }, '尚未设置浇口'));
    scheme.gates.forEach((g, i) => {
      const timeInput = el('input', { type: 'number', step: '0.1', min: '0', style: 'width:64px', value: String(g.openTime) });
      timeInput.onclick = ev => ev.stopPropagation();
      timeInput.onchange = () => {
        store.snapshot(scheme.id);
        g.openTime = Math.max(0, parseFloat(timeInput.value) || 0);
        store.saveScheme(scheme);
      };
      const del = el('button', { class: 'small danger' }, '×');
      del.onclick = ev => {
        ev.stopPropagation();
        store.snapshot(scheme.id);
        scheme.gates = scheme.gates.filter(x => x.id !== g.id);
        store.saveScheme(scheme);
        refreshGates();
        refreshMarkers();
      };
      const item = el('div', { class: 'gate-item' },
        el('span', { class: 'tag ok' }, `G${i + 1}`),
        el('span', {}, `(${fmt(g.position.x)}, ${fmt(g.position.y)}, ${fmt(g.position.z)})`),
        el('span', { class: 'muted' }, '开启'),
        timeInput, el('span', { class: 'muted' }, 's'),
        del,
      );
      item.onclick = () => R.flyTo(g.position);
      gatesEl.append(item);
    });
  }

  function addGate(node: number): void {
    store.snapshot(scheme.id);
    const meshPos = currentPositions;
    if (!meshPos) return;
    const g: Gate = {
      id: uid('g'),
      nodeIndex: node,
      position: { x: meshPos[node * 3], y: meshPos[node * 3 + 1], z: meshPos[node * 3 + 2] },
      openTime: 0,
    };
    scheme.gates.push(g);
    store.saveScheme(scheme);
    refreshGates();
    refreshMarkers();
  }

  let currentPositions: Float32Array | null = null;

  function refreshMarkers(): void {
    const markers = scheme.gates.map(g => ({ pos: g.position, color: [0.1, 0.8, 0.2] as [number, number, number], size: 16 }));
    if (result) {
      for (const w of result.weldLines) markers.push({ pos: w.position, color: [1.0, 0.6, 0.1], size: 14 });
      for (const a of result.airTraps) markers.push({ pos: a.position, color: [1.0, 0.15, 0.15], size: 14 });
    }
    R.setMarkers(markers);
  }

  // ---------- 结果面板 ----------
  let lastResultHash: string | null = null;
  async function refreshResult(): Promise<void> {
    const found = await store.resultFor(scheme);
    if (disposed) return;
    // 网格级别变化后,旧结果的节点数与当前网格不一致,视为无结果
    const valid = found && currentPositions && found.nodeCount === currentPositions.length / 3 ? found : null;
    const hash = valid?.paramHash ?? null;
    if (hash === lastResultHash && resultEl.childElementCount > 0) return; // 无变化不重绘
    lastResultHash = hash;
    result = valid;
    resultEl.innerHTML = '';
    if (!result) {
      resultEl.append(el('p', { class: 'muted' }, '当前参数暂无仿真结果,点击左侧「提交仿真」计算。'));
      animBar.style.display = 'none';
      R.mode = 'plain';
      refreshMarkers();
      return;
    }
    const r = result;
    const prevTime = R.time;
    const prevMode = R.mode;
    R.mode = prevMode === 'plain' ? 'fill' : prevMode;
    R.setField('fill', r.fillTime);
    R.setField('pressure', r.pressure);
    R.valueMin = 0;
    R.valueMax = R.mode === 'pressure' ? maxOf(r.pressure) : r.totalFillTime;
    R.time = Math.min(prevTime || r.totalFillTime, r.totalFillTime);

    const pConv = store.settings.pressureUnit === 'bar' ? 10 : 1;
    const pUnit = store.settings.pressureUnit;
    const metrics = el('table', { class: 'list' });
    metrics.innerHTML = `
      <tr><th>指标</th><th>数值</th></tr>
      <tr><td>充填时间</td><td>${fmt(r.totalFillTime, 3)} s</td></tr>
      <tr><td>最大注射压力</td><td class="${r.maxInjectionPressure > scheme.process.pressureLimit ? 'danger' : ''}">${fmt(r.maxInjectionPressure * pConv)} ${pUnit}${r.maxInjectionPressure > scheme.process.pressureLimit ? ' 超限!' : ''}</td></tr>
      <tr><td>锁模力</td><td>${fmt(r.clampForce)} kN</td></tr>
      <tr><td>计算耗时</td><td>${(r.durationMs / 1000).toFixed(2)} s</td></tr>`;
    resultEl.append(metrics);

    // 视图模式
    const modes: [ViewMode, string][] = [['fill', '充填时间'], ['pressure', '压力'], ['plain', '素模']];
    const modeRow = el('div', { class: 'row', style: 'margin:8px 0' });
    for (const [m, label] of modes) {
      const b = el('button', { class: 'small' + (R.mode === m ? ' primary' : '') }, label);
      b.onclick = () => {
        R.mode = m;
        R.valueMin = 0;
        R.valueMax = m === 'pressure' ? maxOf(r.pressure) : r.totalFillTime;
        buildRightMode(m);
      };
      modeRow.append(b);
    }
    resultEl.append(modeRow);

    // 色标
    const legend = el('div', {});
    legend.innerHTML = `<div class="legend">${['#1a33de', '#19bfe6', '#26cc4d', '#fad926', '#e6261a'].map(c => `<div style="background:${c}"></div>`).join('')}</div>
      <div class="legend-labels"><span id="lg-min">0</span><span id="lg-max">${fmt(R.valueMax)}</span></div>`;
    resultEl.append(legend);

    // 熔接痕 / 困气
    resultEl.append(el('h3', {}, `熔接痕(${r.weldLines.length})`));
    const weldList = el('div', {});
    r.weldLines.forEach((w, i) => {
      const item = el('div', { class: 'defect-item' },
        el('span', { class: 'tag', style: 'background:#fdeecd;color:#9a6a00' }, `W${i + 1}`),
        el('span', {}, `(${fmt(w.position.x)}, ${fmt(w.position.y)}, ${fmt(w.position.z)}) 长 ${fmt(w.length)}mm`));
      item.onclick = () => R.flyTo(w.position);
      weldList.append(item);
    });
    if (r.weldLines.length === 0) weldList.append(el('p', { class: 'muted' }, '未检测到'));
    resultEl.append(weldList);

    resultEl.append(el('h3', {}, `困气(${r.airTraps.length})`));
    const trapList = el('div', {});
    r.airTraps.forEach((a, i) => {
      const item = el('div', { class: 'defect-item' },
        el('span', { class: 'tag err' }, `A${i + 1}`),
        el('span', {}, `(${fmt(a.position.x)}, ${fmt(a.position.y)}, ${fmt(a.position.z)})`));
      item.onclick = () => R.flyTo(a.position);
      trapList.append(item);
    });
    if (r.airTraps.length === 0) trapList.append(el('p', { class: 'muted' }, '未检测到'));
    resultEl.append(trapList);

    // 报告
    const reportBtn = el('button', { style: 'width:100%;margin-top:10px' }, '📄 导出报告');
    reportBtn.onclick = () => {
      const mat = store.materials.find(m => m.id === scheme.materialId);
      generateReport(scheme, r, mat, R, store.settings);
    };
    resultEl.append(reportBtn);

    // 动画条
    buildAnimBar(r);
    refreshMarkers();
  }

  function buildRightMode(_m: ViewMode): void { void _m; lastResultHash = null; void refreshResult(); }

  // ---------- 动画条 ----------
  function buildAnimBar(r: SimResult): void {
    animBar.style.display = 'flex';
    animBar.innerHTML = '';
    animTicks.length = 0;
    const playBtn = el('button', { class: 'small' }, playing ? '⏸ 暂停' : '▶ 播放');
    const slider = el('input', { type: 'range', min: '0', max: '1000', value: String(Math.round((R.time / r.totalFillTime) * 1000)) });
    const timeLabel = el('span', {}, `${fmt(R.time, 2)} / ${fmt(r.totalFillTime, 2)} s`);
    const speedSel = el('select', {});
    for (const s of [0.1, 0.25, 0.5, 1, 2, 4]) speedSel.append(el('option', { value: String(s) }, s + '×'));
    speedSel.value = String(animSpeed);
    speedSel.onchange = () => { animSpeed = parseFloat(speedSel.value); };
    playBtn.onclick = () => { playing = !playing; playBtn.textContent = playing ? '⏸ 暂停' : '▶ 播放'; };
    slider.oninput = () => {
      playing = false;
      playBtn.textContent = '▶ 播放';
      R.time = (parseInt(slider.value) / 1000) * r.totalFillTime;
      timeLabel.textContent = `${fmt(R.time, 2)} / ${fmt(r.totalFillTime, 2)} s`;
    };
    animBar.append(playBtn, slider, timeLabel, speedSel);
    // 播放驱动
    const tick = () => {
      if (playing && result) {
        R.time += (r.totalFillTime / 8) * animSpeed / 60; // 8 秒播完(1×)
        if (R.time >= r.totalFillTime) { R.time = r.totalFillTime; playing = false; playBtn.textContent = '▶ 播放'; }
        slider.value = String(Math.round((R.time / r.totalFillTime) * 1000));
        timeLabel.textContent = `${fmt(R.time, 2)} / ${fmt(r.totalFillTime, 2)} s`;
      }
    };
    animTicks.push(tick);
  }

  const animTicks: (() => void)[] = [];
  function loop(): void {
    if (disposed) return;
    for (const t of animTicks) t();
    R.render();
    rafId = requestAnimationFrame(loop);
  }

  // ---------- 键盘撤销重做 ----------
  function onKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(scheme.id); refreshAll(); }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); store.redo(scheme.id); refreshAll(); }
  }
  window.addEventListener('keydown', onKey);

  function refreshAll(): void {
    buildLeft();
    buildRight();
    refreshGates();
    refreshMarkers();
    void refreshResult();
  }

  // 初始网格(用于浇口坐标)
  const origSetMesh = R.setMesh.bind(R);
  R.setMesh = (pos: Float32Array, tri: Uint32Array) => { currentPositions = pos; origSetMesh(pos, tri); };

  buildLeft();
  buildRight();
  void loadMesh();
  loop();

  let lastTaskSig = '';
  const unsub = store.onChange(() => {
    // 仅当本方案相关任务状态变化时才刷新结果(避免进度事件频繁触发 IndexedDB 读取)
    const sig = store.tasks.filter(t => t.schemeId === scheme.id).map(t => t.id + t.status).join(',');
    if (sig !== lastTaskSig) {
      lastTaskSig = sig;
      void refreshResult();
    }
  });

  return () => {
    disposed = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    window.removeEventListener('keydown', onKey);
    unsub();
  };
}
