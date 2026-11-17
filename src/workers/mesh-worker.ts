// 网格 Worker：细化/粗化/重建，全程不阻塞主线程
import { checkMesh } from '../geometry/mesh-check';
import { coarsenMesh, refineMesh } from '../geometry/remesher';
import type { TriangleMesh } from '../core/types';

export type MeshWorkerRequest =
  | {
      type: 'remesh';
      jobId: string;
      mesh: TriangleMesh;
      mode: 'refine' | 'coarsen';
      targetEdgeLength: number;
      maxIterations: number;
    }
  | { type: 'check'; jobId: string; mesh: TriangleMesh }
  | { type: 'cancel'; jobId: string };

export type MeshWorkerResponse =
  | {
      type: 'progress';
      jobId: string;
      percent: number;
      nodeCount: number;
      triangleCount: number;
    }
  | {
      type: 'done';
      jobId: string;
      mesh?: TriangleMesh;
      check?: ReturnType<typeof checkMesh>;
    }
  | { type: 'error'; jobId: string; message: string }
  | { type: 'canceled'; jobId: string };

const canceled = new Set<string>();

const worker = self as unknown as Worker;

worker.onmessage = (ev: MessageEvent<MeshWorkerRequest>) => {
  const req = ev.data;
  if (req.type === 'cancel') {
    canceled.add(req.jobId);
    return;
  }
  if (req.type === 'check') {
    try {
      const check = checkMesh(req.mesh);
      worker.postMessage({ type: 'done', jobId: req.jobId, check } satisfies MeshWorkerResponse);
    } catch (e) {
      worker.postMessage({ type: 'error', jobId: req.jobId, message: (e as Error).message } satisfies MeshWorkerResponse);
    }
    return;
  }

  try {
    const shouldCancel = () => canceled.has(req.jobId);
    const onProgress = (percent: number, nodeCount: number, triangleCount: number) => {
      worker.postMessage({ type: 'progress', jobId: req.jobId, percent, nodeCount, triangleCount } satisfies MeshWorkerResponse);
    };
    const result =
      req.mode === 'refine'
        ? refineMesh(req.mesh, req.targetEdgeLength, req.maxIterations, { onProgress, shouldCancel })
        : coarsenMesh(req.mesh, req.targetEdgeLength, req.maxIterations, { onProgress, shouldCancel });
    const check = checkMesh(result);
    canceled.delete(req.jobId);
    worker.postMessage({ type: 'done', jobId: req.jobId, mesh: result, check } satisfies MeshWorkerResponse);
  } catch (e) {
    canceled.delete(req.jobId);
    const msg = (e as Error).message;
    if (msg === 'cancel') {
      worker.postMessage({ type: 'canceled', jobId: req.jobId } satisfies MeshWorkerResponse);
    } else {
      worker.postMessage({ type: 'error', jobId: req.jobId, message: msg } satisfies MeshWorkerResponse);
    }
  }
};
