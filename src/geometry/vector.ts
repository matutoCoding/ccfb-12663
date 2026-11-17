// 三维向量小工具（全部为纯函数，避免临时对象热路径分配）
export type Vec3 = [number, number, number];

export function vsub(ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: Vec3): Vec3 {
  out[0] = ax - bx;
  out[1] = ay - by;
  out[2] = az - bz;
  return out;
}

export function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: Vec3): Vec3 {
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  return out;
}

export function dot(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz;
}

export function vlen(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function vdist(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return vlen(ax - bx, ay - by, az - bz);
}

export function triangleArea(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number {
  const ux = bx - ax,
    uy = by - ay,
    uz = bz - az;
  const vx = cx - ax,
    vy = cy - ay,
    vz = cz - az;
  const cx1 = uy * vz - uz * vy;
  const cy1 = uz * vx - ux * vz;
  const cz1 = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx1 * cx1 + cy1 * cy1 + cz1 * cz1);
}

export interface BBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
}

export function computeBBox(positions: Float32Array): BBox {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    centerZ: (minZ + maxZ) / 2,
    sizeX: maxX - minX,
    sizeY: maxY - minY,
    sizeZ: maxZ - minZ,
  };
}
