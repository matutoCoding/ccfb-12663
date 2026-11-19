// 求解器 Worker:充填计算在后台线程执行,定期上报进度
import { runSimulation, SolverInput, computeParamHash } from '../solver.js';
import { SimResult } from '../types.js';

export interface SolverWorkerRequest {
  positions: Float32Array;
  triangles: Uint32Array;
  gateNodes: number[];
  gateOpenTime: number[];
  material: SolverInput['material'];
  process: SolverInput['process'];
}

export type SolverWorkerResponse =
  | { type: 'progress'; filled: number; total: number }
  | { type: 'done'; result: SimResult }
  | { type: 'error'; message: string };

self.onmessage = (ev: MessageEvent<SolverWorkerRequest>) => {
  const d = ev.data;
  const post = (msg: SolverWorkerResponse, transfer?: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer ?? []);
  try {
    const paramHash = computeParamHash(d);
    const result = runSimulation({
      positions: d.positions,
      triangles: d.triangles,
      gateNodes: d.gateNodes,
      gateOpenTime: d.gateOpenTime,
      material: d.material,
      process: d.process,
      onProgress: (filled, total) => post({ type: 'progress', filled, total }),
    });
    result.paramHash = paramHash;
    result.computedAt = Date.now();
    post({ type: 'done', result }, [
      result.fillTime.buffer,
      result.pressure.buffer,
      result.meshPositions.buffer,
      result.meshTriangles.buffer,
    ]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
