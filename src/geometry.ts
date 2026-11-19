// 几何:STL 解析、网格检查、细分/粗化、内置测试模型
import { MeshData, MeshCheckResult } from './types.js';

// ---------- STL 解析 ----------

export function parseSTL(data: Uint8Array): MeshData {
  // 判断 ASCII / 二进制
  const isAscii = (() => {
    if (data.length < 5) return false;
    const head = String.fromCharCode(...data.subarray(0, 5)).toLowerCase();
    if (head !== 'solid') return false;
    // 二进制文件也可能以 solid 开头,检查是否包含 facet
    const text = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(0, Math.min(data.length, 512)));
    return text.includes('facet');
  })();

  const tris: number[][] = [];
  if (isAscii) {
    const text = new TextDecoder().decode(data);
    const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let m: RegExpExecArray | null;
    let cur: number[] = [];
    while ((m = re.exec(text))) {
      cur.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
      if (cur.length === 9) { tris.push(cur); cur = []; }
    }
  } else {
    if (data.length < 84) throw new Error('STL 文件太小,无法解析');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = view.getUint32(80, true);
    if (84 + count * 50 > data.length) throw new Error('STL 文件损坏:三角形数量与文件大小不符');
    for (let i = 0; i < count; i++) {
      const off = 84 + i * 50;
      const v: number[] = [];
      for (let k = 0; k < 9; k++) v.push(view.getFloat32(off + 12 + k * 4, true));
      tris.push(v);
    }
  }
  if (tris.length === 0) throw new Error('STL 中没有找到三角形');
  return weldVertices(tris);
}

/** 顶点焊接 + 构建索引网格 */
function weldVertices(tris: number[][]): MeshData {
  const map = new Map<string, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const x = t[k * 3], y = t[k * 3 + 1], z = t[k * 3 + 2];
      const key = x.toPrecision(7) + ',' + y.toPrecision(7) + ',' + z.toPrecision(7);
      let id = map.get(key);
      if (id === undefined) {
        id = pos.length / 3;
        map.set(key, id);
        pos.push(x, y, z);
      }
      idx.push(id);
    }
  }
  return { positions: new Float32Array(pos), triangles: new Uint32Array(idx) };
}

// ---------- 网格检查 ----------

interface EdgeInfo { count: number }

function buildEdgeMap(mesh: MeshData): Map<string, EdgeInfo> {
  const edges = new Map<string, EdgeInfo>();
  const tri = mesh.triangles;
  for (let i = 0; i < tri.length; i += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tri[i + e], b = tri[i + (e + 1) % 3];
      const key = a < b ? a + '_' + b : b + '_' + a;
      const info = edges.get(key);
      if (info) info.count++;
      else edges.set(key, { count: 1 });
    }
  }
  return edges;
}

export function checkMesh(mesh: MeshData): MeshCheckResult {
  const nodeCount = mesh.positions.length / 3;
  const triCount = mesh.triangles.length / 3;
  const edges = buildEdgeMap(mesh);
  let boundary = 0, nonManifold = 0;
  const boundaryAdj = new Map<number, number[]>();
  for (const [key, info] of edges) {
    if (info.count === 1) {
      boundary++;
      const [a, b] = key.split('_').map(Number);
      if (!boundaryAdj.has(a)) boundaryAdj.set(a, []);
      if (!boundaryAdj.has(b)) boundaryAdj.set(b, []);
      boundaryAdj.get(a)!.push(b);
      boundaryAdj.get(b)!.push(a);
    } else if (info.count > 2) {
      nonManifold++;
    }
  }
  // 数边界环
  let loops = 0;
  const visited = new Set<number>();
  for (const start of boundaryAdj.keys()) {
    if (visited.has(start)) continue;
    loops++;
    let cur = start, prev = -1;
    do {
      visited.add(cur);
      const nexts = boundaryAdj.get(cur)!.filter(n => n !== prev);
      const next = nexts.find(n => !visited.has(n)) ?? nexts[0];
      prev = cur;
      cur = next ?? -1;
      if (cur === start) break;
    } while (cur >= 0 && !visited.has(cur));
  }
  // 退化三角形
  let degenerate = 0;
  const p = mesh.positions, t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-16) degenerate++;
  }
  const messages: string[] = [];
  if (nonManifold > 0) messages.push(`发现 ${nonManifold} 条非流形边(被 3 个以上面共用),可能导致计算异常`);
  if (boundary > 0) messages.push(`发现 ${boundary} 条边界边(共 ${loops} 个开口环),实体模型存在破面;中面模型的外轮廓/内孔属正常`);
  if (degenerate > 0) messages.push(`发现 ${degenerate} 个退化(零面积)三角形`);
  if (messages.length === 0) messages.push('网格检查通过,未发现破面或非流形边');
  return {
    nodeCount, triCount, boundaryEdgeCount: boundary, nonManifoldEdgeCount: nonManifold,
    boundaryLoops: loops, degenerateCount: degenerate,
    ok: nonManifold === 0 && degenerate === 0, messages,
  };
}

// ---------- 细分 / 粗化 ----------

/** 1 分为 4 细分(确定性:边中点按边键缓存) */
export function refineMesh(mesh: MeshData): MeshData {
  const pos = mesh.positions, tri = mesh.triangles;
  const newPos: number[] = Array.from(pos);
  const midCache = new Map<string, number>();
  const mid = (a: number, b: number): number => {
    const key = a < b ? a + '_' + b : b + '_' + a;
    let m = midCache.get(key);
    if (m === undefined) {
      m = newPos.length / 3;
      midCache.set(key, m);
      newPos.push(
        (pos[a * 3] + pos[b * 3]) / 2,
        (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2,
        (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2,
      );
    }
    return m;
  };
  const newTri: number[] = [];
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i], b = tri[i + 1], c = tri[i + 2];
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    newTri.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { positions: new Float32Array(newPos), triangles: new Uint32Array(newTri) };
}

export function meshAtLevel(base: MeshData, level: number): MeshData {
  let m = base;
  for (let i = 0; i < level; i++) m = refineMesh(m);
  return m;
}

// ---------- 内置测试模型 ----------

/** 圆角矩形轮廓点(逆时针) */
function roundedRectOutline(w: number, h: number, r: number, segPerCorner: number): number[][] {
  const pts: number[][] = [];
  const hw = w / 2 - r, hh = h / 2 - r;
  const corners = [
    [hw, hh, 0], [-hw, hh, Math.PI / 2], [-hw, -hh, Math.PI], [hw, -hh, Math.PI * 1.5],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i < segPerCorner; i++) {
      const a = a0 + (i / segPerCorner) * Math.PI / 2;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

function circleOutline(cx: number, cy: number, r: number, seg: number): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** 两个凸环之间的环带三角化(外环 + 内孔) */
function annulusMesh(outer: number[][], inner: number[][], z: number): MeshData {
  const pos: number[] = [];
  for (const [x, y] of outer) pos.push(x, y, z);
  for (const [x, y] of inner) pos.push(x, y, z);
  const no = outer.length, ni = inner.length;
  // 找最近点对作为缝合起点
  let bi = 0, bj = 0, bd = Infinity;
  for (let i = 0; i < no; i++) {
    for (let j = 0; j < ni; j++) {
      const dx = outer[i][0] - inner[j][0], dy = outer[i][1] - inner[j][1];
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = i; bj = j; }
    }
  }
  const tri: number[] = [];
  let i = 0, j = 0;
  // 沿两环前进,选较短对角线
  while (i < no || j < ni) {
    const oi = (bi + i) % no, oi1 = (bi + i + 1) % no;
    const ij = no + (bj + j) % ni, ij1 = no + (bj + j + 1) % ni;
    const takeOuter = j >= ni ? true : i >= no ? false : (() => {
      const ox = pos[oi1 * 3] - pos[ij * 3], oy = pos[oi1 * 3 + 1] - pos[ij * 3 + 1];
      const ix = pos[ij1 * 3] - pos[oi * 3], iy = pos[ij1 * 3 + 1] - pos[oi * 3 + 1];
      return ox * ox + oy * oy < ix * ix + iy * iy;
    })();
    if (takeOuter) { tri.push(oi, oi1, ij); i++; }
    else { tri.push(oi, ij1, ij); j++; }
  }
  return { positions: new Float32Array(pos), triangles: new Uint32Array(tri) };
}

/** 凸多边形扇形三角化 */
function fanMesh(outline: number[][], z: number): MeshData {
  const pos: number[] = [0, 0, z];
  let cx = 0, cy = 0;
  for (const [x, y] of outline) { cx += x; cy += y; }
  pos[0] = cx / outline.length; pos[1] = cy / outline.length;
  for (const [x, y] of outline) pos.push(x, y, z);
  const tri: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    tri.push(0, 1 + i, 1 + (i + 1) % outline.length);
  }
  return { positions: new Float32Array(pos), triangles: new Uint32Array(tri) };
}

/** 规则网格板(盖板用):矩形域规则三角网格,边界整齐 */
function gridPlate(w: number, h: number, nx: number, ny: number, z: number): MeshData {
  const pos: number[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      pos.push(-w / 2 + (i / nx) * w, -h / 2 + (j / ny) * h, z);
    }
  }
  const tri: number[] = [];
  const at = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
      if ((i + j) % 2 === 0) tri.push(a, b, d, a, d, c);
      else tri.push(a, b, c, b, d, c);
    }
  }
  return { positions: new Float32Array(pos), triangles: new Uint32Array(tri) };
}

export interface BuiltinModel { id: string; name: string; desc: string; build: () => MeshData }

export const BUILTIN_MODELS: BuiltinModel[] = [
  {
    id: 'phone-shell',
    name: '手机壳(中面)',
    desc: '140×70mm 圆角矩形带摄像头孔,壁厚 1.2mm',
    build: () => {
      const outer = roundedRectOutline(140, 70, 12, 10);
      const hole = circleOutline(0, 18, 9, 24);
      return annulusMesh(outer, hole, 0);
    },
  },
  {
    id: 'cover-plate',
    name: '盖板(中面)',
    desc: '100×60mm 矩形平板,壁厚 2mm',
    build: () => gridPlate(100, 60, 16, 10, 0),
  },
];

export function getBuiltin(id: string): BuiltinModel | undefined {
  return BUILTIN_MODELS.find(m => m.id === id);
}
