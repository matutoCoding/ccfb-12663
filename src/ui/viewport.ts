// 3D 视口组件：封装 Renderer、鼠标轨道交互、拾取回调与动画循环
import { Renderer, type Marker, type RenderMode } from '../render/renderer';
import { h } from './dom';
import type { SimResult, TriangleMesh } from '../core/types';

export interface ViewportHandle {
  setMesh: (mesh: TriangleMesh) => void;
  setMode: (mode: RenderMode) => void;
  setMarkers: (markers: Marker[]) => void;
  setResult: (result: SimResult | null) => void;
  play: () => void;
  pause: () => void;
  setSpeed: (s: number) => void;
  seek: (ratio: number) => void;
  flyTo: (x: number, y: number, z: number) => Promise<void>;
  screenshot: () => string;
  resetView: () => void;
  getTime: () => number;
  getTotalTime: () => number;
  onFrame?: (time: number, ratio: number) => void;
  onPick?: (p: { nodeIndex: number; x: number; y: number; z: number }) => void;
  setPicking: (on: boolean) => void;
  dispose: () => void;
  element: HTMLElement;
}

export function createViewport(): ViewportHandle {
  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const wrap = h('div', { class: 'viewport-wrap', style: { height: '100%' } }, canvas);
  const renderer = new Renderer(canvas);
  let mesh: TriangleMesh | null = null;
  let result: SimResult | null = null;
  let mode: RenderMode = 'solid';
  let playing = false;
  let speed = 1;
  let currentRatio = 0;
  let rafId = 0;
  let lastTs = 0;
  let picking = false;

  const totalTime = () => result?.metrics.fillTime ?? 0;

  const renderFrame = () => {
    if (!result || mode === 'solid') {
      renderer.render();
      return;
    }
    const t = totalTime() * currentRatio;
    if (mode === 'fill-contour') {
      // 已充填节点显示其充填时间，未充填置 -1（渲染为最低色）
      const field = new Float32Array(result.fillTimes.length);
      for (let i = 0; i < field.length; i++) {
        const ft = result.fillTimes[i];
        field[i] = ft < 0 ? -1 : ft <= t ? ft : -1;
      }
      renderer.setScalarField(field, 0, totalTime());
    } else if (mode === 'pressure') {
      renderer.setScalarField(result.peakPressures, 0, Math.max(1e-9, result.metrics.maxPressure));
    }
    renderer.render();
    handle.onFrame?.(t, currentRatio);
  };

  const loop = (ts: number) => {
    if (!playing) return;
    if (!lastTs) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    // 动画实际时长固定 6 秒走完全程，speed 为倍速
    if (totalTime() > 0) {
      currentRatio += (dt * speed) / 6;
      if (currentRatio >= 1) {
        currentRatio = 1;
        playing = false;
      }
    }
    renderFrame();
    if (playing) rafId = requestAnimationFrame(loop);
  };

  // ---- 鼠标交互 ----
  let dragging = false;
  let dragButton = 0;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let moved = false;

  canvas.addEventListener('mousedown', (e) => {
    dragging = true;
    dragButton = e.button;
    lastX = downX = e.clientX;
    lastY = downY = e.clientY;
    moved = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) moved = true;
    lastX = e.clientX;
    lastY = e.clientY;
    if (dragButton === 2 || e.shiftKey) renderer.camera.pan(dx, dy);
    else renderer.camera.rotate(dx, dy);
    renderFrame();
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (!moved && picking && e.target === canvas) {
      const hit = renderer.pickTriangle(e.clientX, e.clientY);
      if (hit) handle.onPick?.(hit);
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.camera.zoom(e.deltaY > 0 ? 1.12 : 0.89);
    renderFrame();
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.style.cursor = 'crosshair';

  const handle: ViewportHandle = {
    element: wrap,
    setMesh(m: TriangleMesh) {
      mesh = m;
      renderer.setMesh(m);
      renderFrame();
    },
    setMode(md: RenderMode) {
      mode = md;
      renderer.mode = md;
      if (md === 'solid') renderer.render();
      else renderFrame();
    },
    setMarkers(markers: Marker[]) {
      renderer.setMarkers(markers);
      renderFrame();
    },
    setResult(r: SimResult | null) {
      result = r;
      currentRatio = r ? 0 : 0;
      playing = false;
      if (r && mode !== 'solid') renderFrame();
    },
    play() {
      if (!result) return;
      if (currentRatio >= 1) currentRatio = 0;
      playing = true;
      lastTs = 0;
      rafId = requestAnimationFrame(loop);
    },
    pause() {
      playing = false;
      cancelAnimationFrame(rafId);
    },
    setSpeed(s: number) {
      speed = s;
    },
    seek(ratio: number) {
      currentRatio = Math.max(0, Math.min(1, ratio));
      renderFrame();
    },
    flyTo: (x, y, z) => renderer.flyTo(x, y, z),
    screenshot: () => renderer.screenshot(),
    resetView() {
      if (mesh) {
        renderer.camera.fit(renderer.getBBox()!);
        renderFrame();
      }
    },
    getTime: () => totalTime() * currentRatio,
    getTotalTime: totalTime,
    setPicking(on: boolean) {
      picking = on;
      canvas.style.cursor = on ? 'cell' : 'crosshair';
    },
    dispose() {
      cancelAnimationFrame(rafId);
      renderer.dispose();
      wrap.remove();
    },
  };
  return handle;
}
