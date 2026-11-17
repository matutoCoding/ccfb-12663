// 系统内置测试模型：盖板 / 手机壳
// 均为中面（mid-plane）三角网格，适配 2.5D Hele-Shaw 薄壳充填
import type { TriangleMesh } from '../core/types';
import { MeshBuilder } from './mesh';

interface GridOptions {
  width: number; // x 方向尺寸 mm
  depth: number; // y 方向尺寸 mm
  spacing: number; // 初始网格边长 mm
  thickness: number; // 均匀壁厚 mm
  /** 返回 false 的网格点被剔除（用于开孔/异形轮廓），坐标以网格中心为原点 */
  valid?: (x: number, y: number) => boolean;
}

/**
 * 结构化平面网格：均匀点阵 + 四边形拆三角。
 * 顶点/三角形按固定顺序生成，不依赖任何随机量，保证确定性。
 */
export function planarGridMesh(opts: GridOptions): TriangleMesh {
  const { width, depth, spacing, thickness } = opts;
  const nx = Math.max(2, Math.round(width / spacing));
  const ny = Math.max(2, Math.round(depth / spacing));
  const builder = new MeshBuilder();
  const id: (number | null)[][] = [];

  for (let i = 0; i <= nx; i++) {
    id[i] = [];
    const x = -width / 2 + (width * i) / nx;
    for (let j = 0; j <= ny; j++) {
      const y = -depth / 2 + (depth * j) / ny;
      if (opts.valid && !opts.valid(x, y)) {
        id[i][j] = null;
        continue;
      }
      id[i][j] = builder.addVertex(x, y, 0, thickness);
    }
  }

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const a = id[i][j];
      const b = id[i + 1][j];
      const c = id[i + 1][j + 1];
      const d = id[i][j + 1];
      // 单元四角都有效才生成（保证共边一致、无悬挂节点）
      if (a === null || b === null || c === null || d === null) continue;
      // 统一绕序：从 +z 看逆时针
      builder.addTriangle(a, b, c);
      builder.addTriangle(a, c, d);
    }
  }
  return builder.build();
}

/** 圆角矩形内部判定（圆角半径 r） */
function insideRoundedRect(x: number, y: number, w: number, d: number, r: number): boolean {
  const hx = w / 2,
    hy = d / 2;
  if (Math.abs(x) > hx || Math.abs(y) > hy) return false;
  const cx = Math.max(-hx + r, Math.min(x, hx - r));
  const cy = Math.max(-hy + r, Math.min(y, hy - r));
  const dx = x - cx,
    dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 盖板：120×80×2mm 矩形平板 */
export function buildCoverPlate(): TriangleMesh {
  return planarGridMesh({
    width: 120,
    depth: 80,
    spacing: 4,
    thickness: 2,
  });
}

/** 手机壳：150×75mm 圆角轮廓，左上角摄像头开孔，壁厚 1.8mm */
export function buildPhoneCase(): TriangleMesh {
  const W = 150,
    D = 75,
    R = 10;
  const holeX = -58,
    holeY = 24,
    holeR = 6.5;
  return planarGridMesh({
    width: W,
    depth: D,
    spacing: 3,
    thickness: 1.8,
    valid: (x, y) => {
      if (!insideRoundedRect(x, y, W, D, R)) return false;
      const dx = x - holeX,
        dy = y - holeY;
      if (dx * dx + dy * dy <= holeR * holeR) return false; // 摄像头孔
      return true;
    },
  });
}

export const BUILTIN_MODELS = {
  'cover-plate': { id: 'cover-plate' as const, name: '盖板测试模型（120×80×2mm）', build: buildCoverPlate },
  'phone-case': { id: 'phone-case' as const, name: '手机壳测试模型（150×75mm，带摄像头孔）', build: buildPhoneCase },
};
