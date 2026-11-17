// Worker 客户端：封装消息协议为 Promise，支持进度回调与取消
import type { MeshWorkerRequest, MeshWorkerResponse } from '../workers/mesh-worker';
import type { SimWorkerRequest, SimWorkerResponse, SimWorkerInput } from '../workers/sim-worker';
import type { TriangleMesh } from '../core/types';
import { checkMesh } from '../geometry/mesh-check';
import { uid } from '../core/utils';

// ---- 网格 Worker 池（轻量复用，避免重复构造） ----
let meshWorker: Worker | null = null;
function getMeshWorker(): Worker {
  if (!meshWorker) meshWorker = new Worker(new URL('../workers/mesh-worker.ts', import.meta.url), { type: 'module' });
  return meshWorker;
}

let simWorker: Worker | null = null;
function getSimWorker(): Worker {
  if (!simWorker) simWorker = new Worker(new URL('../workers/sim-worker.ts', import.meta.url), { type: 'module' });
  return simWorker;
}

export interface MeshJob {
  promise: Promise<{ mesh: TriangleMesh; check: ReturnType<typeof checkMesh> }>;
  cancel: () => void;
}

export function runRemesh(
  mesh: TriangleMesh,
  mode: 'refine' | 'coarsen',
  targetEdgeLength: number,
  maxIterations: number,
  onProgress?: (percent: number, nodeCount: number, triCount: number) => void,
): MeshJob {
  const jobId = uid('meshjob');
  const worker = getMeshWorker();
  let resolveFn: (v: { mesh: TriangleMesh; check: ReturnType<typeof checkMesh> }) => void;
  let rejectFn: (e: Error) => void;
  const promise = new Promise<{ mesh: TriangleMesh; check: ReturnType<typeof checkMesh> }>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  const handler = (ev: MessageEvent<MeshWorkerResponse>) => {
    const msg = ev.data;
    if (msg.jobId !== jobId) return;
    if (msg.type === 'progress') onProgress?.(msg.percent, msg.nodeCount, msg.triangleCount);
    else if (msg.type === 'done') {
      worker.removeEventListener('message', handler);
      resolveFn({ mesh: msg.mesh!, check: msg.check! });
    } else if (msg.type === 'error') {
      worker.removeEventListener('message', handler);
      rejectFn(new Error(msg.message));
    } else if (msg.type === 'canceled') {
      worker.removeEventListener('message', handler);
      rejectFn(new Error('cancel'));
    }
  };
  worker.addEventListener('message', handler);
  const req: MeshWorkerRequest = { type: 'remesh', jobId, mesh, mode, targetEdgeLength, maxIterations };
  worker.postMessage(req);
  return {
    promise,
    cancel: () => worker.postMessage({ type: 'cancel', jobId } satisfies MeshWorkerRequest),
  };
}

export interface SimJob {
  promise: Promise<import('../core/types').SimResult>;
  cancel: () => void;
}

export function runSimulation(input: SimWorkerInput, onProgress?: (percent: number) => void): SimJob {
  const jobId = uid('simjob');
  const worker = getSimWorker();
  let resolveFn: (v: import('../core/types').SimResult) => void;
  let rejectFn: (e: Error) => void;
  const promise = new Promise<import('../core/types').SimResult>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  const handler = (ev: MessageEvent<SimWorkerResponse>) => {
    const msg = ev.data;
    if (msg.jobId !== jobId) return;
    if (msg.type === 'progress') onProgress?.(msg.percent);
    else if (msg.type === 'done') {
      worker.removeEventListener('message', handler);
      resolveFn(msg.result);
    } else if (msg.type === 'error') {
      worker.removeEventListener('message', handler);
      rejectFn(new Error(msg.message));
    } else if (msg.type === 'canceled') {
      worker.removeEventListener('message', handler);
      rejectFn(new Error('cancel'));
    }
  };
  worker.addEventListener('message', handler);
  const req: SimWorkerRequest = { type: 'run', jobId, input };
  worker.postMessage(req);
  return {
    promise,
    cancel: () => worker.postMessage({ type: 'cancel', jobId } satisfies SimWorkerRequest),
  };
}
