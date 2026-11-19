// 网格剖分 Worker:细分/检查在后台线程执行,界面不卡死
import { MeshData, MeshCheckResult } from '../types.js';
import { checkMesh, meshAtLevel } from '../geometry.js';

export interface MeshWorkerRequest {
  positions: Float32Array;
  triangles: Uint32Array;
  level: number;
}

export interface MeshWorkerResponse {
  positions: Float32Array;
  triangles: Uint32Array;
  check: MeshCheckResult;
}

self.onmessage = (ev: MessageEvent<MeshWorkerRequest>) => {
  const { positions, triangles, level } = ev.data;
  try {
    const base: MeshData = { positions, triangles };
    const mesh = meshAtLevel(base, level);
    const check = checkMesh(mesh);
    const resp: MeshWorkerResponse = {
      positions: mesh.positions,
      triangles: mesh.triangles,
      check,
    };
    (self as unknown as Worker).postMessage(resp, [resp.positions.buffer, resp.triangles.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: String(err) });
  }
};
