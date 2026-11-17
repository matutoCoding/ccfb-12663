// 确定性网格细化/粗化（在 WebWorker 中运行）
// 细化：每轮最长边二分，共享中点保证共形；粗化：最短边折叠
// 全部循环顺序固定，无随机量，同输入必得同输出
import type { TriangleMesh } from '../core/types';

export interface RemeshCallbacks {
  onProgress?: (percent: number, nodeCount: number, triCount: number) => void;
  shouldCancel?: () => boolean;
}

class RemeshWork {
  pos: number[];
  thick: number[];
  tris: number[]; // 每 3 个一组

  constructor(mesh: TriangleMesh) {
    this.pos = Array.from(mesh.positions);
    this.thick = Array.from(mesh.thickness);
    this.tris = Array.from(mesh.triangles);
  }

  private edgeKey(a: number, b: number): string {
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  }

  /** 构建边 -> 邻接三角面（三角面在 tris 中的起始下标） */
  private buildEdgeFaces(): Map<string, number[]> {
    const map = new Map<string, number[]>();
    const add = (a: number, b: number, f: number) => {
      const k = this.edgeKey(a, b);
      const list = map.get(k);
      if (list) list.push(f);
      else map.set(k, [f]);
    };
    for (let f = 0; f < this.tris.length; f += 3) {
      add(this.tris[f], this.tris[f + 1], f);
      add(this.tris[f + 1], this.tris[f + 2], f);
      add(this.tris[f + 2], this.tris[f], f);
    }
    return map;
  }

  private edgeLengthSq(key: string): number {
    const us = key.indexOf('_');
    const a = Number(key.slice(0, us));
    const b = Number(key.slice(us + 1));
    const dx = this.pos[a * 3] - this.pos[b * 3];
    const dy = this.pos[a * 3 + 1] - this.pos[b * 3 + 1];
    const dz = this.pos[a * 3 + 2] - this.pos[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  }

  /** 细化：把所有边长 > target 的边二分，直到全部满足或达到迭代上限 */
  refine(targetEdge: number, maxIterations: number, cb?: RemeshCallbacks): TriangleMesh {
    const targetSq = targetEdge * targetEdge;
    for (let iter = 0; iter < maxIterations; iter++) {
      if (cb?.shouldCancel?.()) throw new Error('cancel');
      const edgeFaces = this.buildEdgeFaces();
      // 固定顺序收集超标边（Map 按插入顺序，输入网格确定 → 顺序确定）
      const longEdges: string[] = [];
      for (const key of edgeFaces.keys()) {
        if (this.edgeLengthSq(key) > targetSq) longEdges.push(key);
      }
      if (longEdges.length === 0) break;

      const midpoint = new Map<string, number>();
      const getMidpoint = (key: string): number => {
        const existing = midpoint.get(key);
        if (existing !== undefined) return existing;
        const us = key.indexOf('_');
        const a = Number(key.slice(0, us));
        const b = Number(key.slice(us + 1));
        const idx = this.pos.length / 3;
        this.pos.push(
          (this.pos[a * 3] + this.pos[b * 3]) / 2,
          (this.pos[a * 3 + 1] + this.pos[b * 3 + 1]) / 2,
          (this.pos[a * 3 + 2] + this.pos[b * 3 + 2]) / 2,
        );
        this.thick.push((this.thick[a] + this.thick[b]) / 2);
        midpoint.set(key, idx);
        return idx;
      };

      const newTris: number[] = [];
      const splitEdgesOfFace = (f: number): Set<string> => {
        const set = new Set<string>();
        for (const k of [
          this.edgeKey(this.tris[f], this.tris[f + 1]),
          this.edgeKey(this.tris[f + 1], this.tris[f + 2]),
          this.edgeKey(this.tris[f + 2], this.tris[f]),
        ]) {
          if (this.edgeLengthSq(k) > targetSq) set.add(k);
        }
        return set;
      };

      for (let f = 0; f < this.tris.length; f += 3) {
        const v0 = this.tris[f],
          v1 = this.tris[f + 1],
          v2 = this.tris[f + 2];
        const splits = splitEdgesOfFace(f);
        if (splits.size === 0) {
          newTris.push(v0, v1, v2);
        } else if (splits.size === 1) {
          const key = [...splits][0];
          const m = getMidpoint(key);
          // 被切边两端点
          const us = key.indexOf('_');
          const ea = Number(key.slice(0, us));
          const eb = Number(key.slice(us + 1));
          const apex = [v0, v1, v2].find((v) => v !== ea && v !== eb)!;
          newTris.push(apex, ea, m, apex, m, eb);
        } else {
          // 2 或 3 条边同时切分：生成中点后统一三角化（确定性绕序）
          const verts: number[] = [v0, v1, v2];
          const mids: Record<string, number> = {};
          for (const key of splits) {
            mids[key] = getMidpoint(key);
            verts.push(mids[key]);
          }
          if (splits.size === 2) {
            // 共享顶点的两条边切分：四边形 + 小三角
            const keys = [...splits];
            const shared = sharedVertex(keys[0], keys[1]);
            const mA = mids[keys[0]],
              mB = mids[keys[1]];
            const otherA = otherVertex(keys[0], shared);
            const otherB = otherVertex(keys[1], shared);
            newTris.push(shared, mA, mB, mA, otherA, otherB, otherB, mA, mB);
          } else {
            // 三边全切：中心倒三角 + 三个角三角
            const k01 = this.edgeKey(v0, v1);
            const k12 = this.edgeKey(v1, v2);
            const k20 = this.edgeKey(v2, v0);
            const m01 = mids[k01],
              m12 = mids[k12],
              m20 = mids[k20];
            newTris.push(v0, m01, m20, v1, m12, m01, v2, m20, m12, m01, m12, m20);
          }
        }
      }
      this.tris = newTris;
      cb?.onProgress?.(Math.min(95, ((iter + 1) / maxIterations) * 90), this.pos.length / 3, this.tris.length / 3);
    }
    cb?.onProgress?.(100, this.pos.length / 3, this.tris.length / 3);
    return this.toMesh();
  }

  /** 粗化：把所有边长 < target 的边折叠（保留端点之一，删除另一个） */
  coarsen(targetEdge: number, maxIterations: number, cb?: RemeshCallbacks): TriangleMesh {
    const targetSq = targetEdge * targetEdge;
    for (let iter = 0; iter < maxIterations; iter++) {
      if (cb?.shouldCancel?.()) throw new Error('cancel');
      const edgeFaces = this.buildEdgeFaces();
      let collapsed = false;
      const removedVerts = new Set<number>();
      const remap = new Map<number, number>();

      const keys = [...edgeFaces.keys()];
      for (const key of keys) {
        if (this.edgeLengthSq(key) >= targetSq) continue;
        const us = key.indexOf('_');
        let a = Number(key.slice(0, us));
        let b = Number(key.slice(us + 1));
        if (removedVerts.has(a) || removedVerts.has(b)) continue;
        // 固定规则：保留索引较小的节点，折叠较大节点（结果确定）
        if (a > b) [a, b] = [b, a];
        removedVerts.add(b);
        remap.set(b, a);
        // 合并位置取中点，壁厚取均值
        this.pos[a * 3] = (this.pos[a * 3] + this.pos[b * 3]) / 2;
        this.pos[a * 3 + 1] = (this.pos[a * 3 + 1] + this.pos[b * 3 + 1]) / 2;
        this.pos[a * 3 + 2] = (this.pos[a * 3 + 2] + this.pos[b * 3 + 2]) / 2;
        this.thick[a] = (this.thick[a] + this.thick[b]) / 2;
        collapsed = true;
      }
      if (!collapsed) break;

      const resolve = (v: number): number => {
        let cur = v;
        while (remap.has(cur)) cur = remap.get(cur)!;
        return cur;
      };
      const faceSet = new Set<string>();
      const newTris: number[] = [];
      for (let f = 0; f < this.tris.length; f += 3) {
        const a = resolve(this.tris[f]);
        const b = resolve(this.tris[f + 1]);
        const c = resolve(this.tris[f + 2]);
        if (a === b || b === c || c === a) continue; // 折叠掉的面
        const fk = [a, b, c].sort((x, y) => x - y).join('_');
        if (faceSet.has(fk)) continue; // 折叠产生的重合面
        faceSet.add(fk);
        newTris.push(a, b, c);
      }
      this.tris = newTris;
      cb?.onProgress?.(Math.min(95, ((iter + 1) / maxIterations) * 90), this.pos.length / 3, this.tris.length / 3);
    }
    // 压缩掉被删除节点，重排索引
    this.compact(removedVertsAll(this));
    cb?.onProgress?.(100, this.pos.length / 3, this.tris.length / 3);
    return this.toMesh();
  }

  private compact(removed: Set<number>): void {
    if (removed.size === 0) return;
    const remap = new Map<number, number>();
    const newPos: number[] = [];
    const newThick: number[] = [];
    const n = this.pos.length / 3;
    for (let v = 0; v < n; v++) {
      if (removed.has(v)) continue;
      remap.set(v, newPos.length / 3);
      newPos.push(this.pos[v * 3], this.pos[v * 3 + 1], this.pos[v * 3 + 2]);
      newThick.push(this.thick[v]);
    }
    this.pos = newPos;
    this.thick = newThick;
    this.tris = this.tris.map((v) => remap.get(v) ?? v);
  }

  private toMesh(): TriangleMesh {
    return {
      positions: Float32Array.from(this.pos),
      triangles: Uint32Array.from(this.tris),
      thickness: Float32Array.from(this.thick),
      nodeCount: this.pos.length / 3,
      triangleCount: this.tris.length / 3,
    };
  }
}

function removedVertsAll(_w: RemeshWork): Set<number> {
  // 折叠后未被任何面引用的节点
  const used = new Set<number>();
  for (const v of _w.tris) used.add(v);
  const out = new Set<number>();
  const n = _w.pos.length / 3;
  for (let v = 0; v < n; v++) if (!used.has(v)) out.add(v);
  return out;
}

function parseEdge(key: string): [number, number] {
  const us = key.indexOf('_');
  return [Number(key.slice(0, us)), Number(key.slice(us + 1))];
}

function sharedVertex(k1: string, k2: string): number {
  const [a1, b1] = parseEdge(k1);
  const [a2, b2] = parseEdge(k2);
  if (a1 === a2 || a1 === b2) return a1;
  return b1;
}

function otherVertex(key: string, not: number): number {
  const [a, b] = parseEdge(key);
  return a === not ? b : a;
}

export function refineMesh(mesh: TriangleMesh, target: number, maxIter: number, cb?: RemeshCallbacks): TriangleMesh {
  return new RemeshWork(mesh).refine(target, maxIter, cb);
}

export function coarsenMesh(mesh: TriangleMesh, target: number, maxIter: number, cb?: RemeshCallbacks): TriangleMesh {
  return new RemeshWork(mesh).coarsen(target, maxIter, cb);
}
