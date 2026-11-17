// 网格构建/转换辅助
import type { TriangleMesh } from '../core/types';

/** 便捷的网格构建器：以普通数组收集，最后转 TypedArray */
export class MeshBuilder {
  positions: number[] = [];
  triangles: number[] = [];
  thickness: number[] = [];

  addVertex(x: number, y: number, z: number, h: number): number {
    const idx = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.thickness.push(h);
    return idx;
  }

  addTriangle(a: number, b: number, c: number): void {
    this.triangles.push(a, b, c);
  }

  build(): TriangleMesh {
    return {
      positions: Float32Array.from(this.positions),
      triangles: Uint32Array.from(this.triangles),
      thickness: Float32Array.from(this.thickness),
      nodeCount: this.positions.length / 3,
      triangleCount: this.triangles.length / 3,
    };
  }
}

export function meshSurfaceArea(mesh: TriangleMesh): number {
  const p = mesh.positions;
  const t = mesh.triangles;
  let area = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3,
      b = t[i + 1] * 3,
      c = t[i + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    area += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
  }
  return area;
}

/** 网格体积（散度定理），用于充填体积/锁模力核算 */
export function meshVolume(mesh: TriangleMesh): number {
  const p = mesh.positions;
  const t = mesh.triangles;
  let vol6 = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3,
      b = t[i + 1] * 3,
      c = t[i + 2] * 3;
    vol6 +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return Math.abs(vol6) / 6;
}

/**
 * 中面网格的充填体积：Σ 三角形面积 × 三节点平均厚度。
 * 内置/导入模型均按中面（薄壳）语义处理。
 */
export function fillVolume(mesh: TriangleMesh): number {
  const p = mesh.positions;
  const t = mesh.triangles;
  const h = mesh.thickness;
  let vol = 0;
  for (let i = 0; i < t.length; i += 3) {
    const ia = t[i],
      ib = t[i + 1],
      ic = t[i + 2];
    const a = ia * 3,
      b = ib * 3,
      c = ic * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const area = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    vol += area * ((h[ia] + h[ib] + h[ic]) / 3);
  }
  return vol;
}

/** 以固定网格顺序复制，确保跨 Worker 传递后数据一致 */
export function cloneMesh(mesh: TriangleMesh): TriangleMesh {
  return {
    positions: new Float32Array(mesh.positions),
    triangles: new Uint32Array(mesh.triangles),
    thickness: new Float32Array(mesh.thickness),
    nodeCount: mesh.nodeCount,
    triangleCount: mesh.triangleCount,
  };
}
