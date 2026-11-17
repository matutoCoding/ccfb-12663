// 仿真 Worker：Hele-Shaw 充填求解 + 进度/取消/失败原因
import { solveFilling } from '../sim/solver';
import type { Gate, Material, ProcessParams, SimResult, TriangleMesh } from '../core/types';

export interface SimWorkerInput {
  cacheKey: string;
  schemeId: string;
  mesh: TriangleMesh;
  material: Material;
  process: ProcessParams;
  gates: Gate[];
}

export type SimWorkerRequest =
  | { type: 'run'; jobId: string; input: SimWorkerInput }
  | { type: 'cancel'; jobId: string };

export type SimWorkerResponse =
  | { type: 'progress'; jobId: string; percent: number }
  | { type: 'done'; jobId: string; result: SimResult }
  | { type: 'error'; jobId: string; message: string }
  | { type: 'canceled'; jobId: string };

const canceled = new Set<string>();
const worker = self as unknown as Worker;

worker.onmessage = (ev: MessageEvent<SimWorkerRequest>) => {
  const req = ev.data;
  if (req.type === 'cancel') {
    canceled.add(req.jobId);
    return;
  }
  const { input, jobId } = req;
  try {
    const result = solveFilling({
      mesh: input.mesh,
      material: input.material,
      process: input.process,
      gates: input.gates,
      cacheKey: input.cacheKey,
      schemeId: input.schemeId,
      shouldCancel: () => canceled.has(jobId),
      onProgress: (percent) => {
        worker.postMessage({ type: 'progress', jobId, percent } satisfies SimWorkerResponse);
      },
    });
    canceled.delete(jobId);
    worker.postMessage({ type: 'done', jobId, result } satisfies SimWorkerResponse);
  } catch (e) {
    canceled.delete(jobId);
    const msg = (e as Error).message;
    if (msg === 'cancel') {
      worker.postMessage({ type: 'canceled', jobId } satisfies SimWorkerResponse);
    } else {
      worker.postMessage({ type: 'error', jobId, message: msg } satisfies SimWorkerResponse);
    }
  }
};
