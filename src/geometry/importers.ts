// STL（二进制/ASCII）与 OBJ 导入器
// STL 每个三角形顶点天然重复，这里用空间哈希做确定性焊接，输出共享顶点网格
import type { TriangleMesh } from '../core/types';
import { MeshBuilder } from './mesh';

export interface ImportedGeometry {
  mesh: TriangleMesh;
  format: 'stl' | 'obj';
  warnings: string[];
}

const WELD_TOL = 1e-3; // mm，焊接距离阈值
const INV_TOL = 1 / WELD_TOL;

/** 确定性顶点焊接：按量化坐标分桶，逐顶点顺序处理，相同输入必得相同输出 */
class VertexWelder {
  private buckets = new Map<string, number[]>();
  private builder = new MeshBuilder();
  private thickness: number;

  constructor(thickness: number) {
    this.thickness = thickness;
  }

  private keyOf(cx: number, cy: number, cz: number): string {
    return `${cx}_${cy}_${cz}`;
  }

  add(x: number, y: number, z: number): number {
    const cx = Math.round(x * INV_TOL);
    const cy = Math.round(y * INV_TOL);
    const cz = Math.round(z * INV_TOL);
    // 检查 3×3×3 邻域桶，保证阈值内顶点都能合并
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.buckets.get(this.keyOf(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const idx of list) {
            const p = idx * 3;
            const ex = this.builder.positions[p] - x;
            const ey = this.builder.positions[p + 1] - y;
            const ez = this.builder.positions[p + 2] - z;
            if (ex * ex + ey * ey + ez * ez <= WELD_TOL * WELD_TOL) return idx;
          }
        }
      }
    }
    const idx = this.builder.addVertex(x, y, z, this.thickness);
    const key = this.keyOf(cx, cy, cz);
    const list = this.buckets.get(key);
    if (list) list.push(idx);
    else this.buckets.set(key, [idx]);
    return idx;
  }

  tri(a: number, b: number, c: number) {
    if (a !== b && b !== c && c !== a) this.builder.addTriangle(a, b, c);
  }

  build(): TriangleMesh {
    return this.builder.build();
  }
}

export function parseStl(buffer: ArrayBuffer, thickness: number): ImportedGeometry {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const asciiHead = new TextDecoder().decode(bytes.subarray(0, 5)).toLowerCase();
  const warnings: string[] = [];

  const welder = new VertexWelder(thickness);

  if (asciiHead === 'solid' && !looksLikeBinaryStl(bytes, view)) {
    const text = new TextDecoder().decode(bytes);
    const verts: number[] = [];
    const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) verts.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (verts.length < 9) throw new Error('ASCII STL 解析失败：未找到有效的 facet/vertex 数据');
    for (let i = 0; i < verts.length; i += 9) {
      const a = welder.add(verts[i], verts[i + 1], verts[i + 2]);
      const b = welder.add(verts[i + 3], verts[i + 4], verts[i + 5]);
      const c = welder.add(verts[i + 6], verts[i + 7], verts[i + 8]);
      welder.tri(a, b, c);
    }
  } else {
    if (bytes.length < 84) throw new Error('二进制 STL 文件长度不足 84 字节，文件可能已损坏');
    const count = view.getUint32(80, true);
    const expected = 84 + count * 50;
    if (bytes.length < expected) {
      throw new Error(`二进制 STL 长度不匹配：头部声明 ${count} 个三角面，需要 ${expected} 字节，实际 ${bytes.length} 字节`);
    }
    let offset = 84;
    for (let f = 0; f < count; f++) {
      offset += 12; // 法向量（忽略，由坐标重算）
      const ids: number[] = [];
      for (let k = 0; k < 3; k++) {
        const x = view.getFloat32(offset, true);
        const y = view.getFloat32(offset + 4, true);
        const z = view.getFloat32(offset + 8, true);
        offset += 12;
        ids.push(welder.add(x, y, z));
      }
      offset += 2; // 属性字节
      welder.tri(ids[0], ids[1], ids[2]);
    }
  }

  const mesh = welder.build();
  if (mesh.triangleCount === 0) throw new Error('STL 中没有解析出任何三角面');
  if (mesh.triangleCount > 200000) warnings.push(`模型面数 ${mesh.triangleCount} 较大，建议先粗化再仿真`);
  return { mesh, format: 'stl', warnings };
}

function looksLikeBinaryStl(bytes: Uint8Array, view: DataView): boolean {
  if (bytes.length < 84) return false;
  const count = view.getUint32(80, true);
  return bytes.length >= 84 + count * 50;
}

export function parseObj(text: string, thickness: number): ImportedGeometry {
  const warnings: string[] = [];
  const rawVerts: number[] = [];
  const faces: [number, number, number][] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('v ')) {
      const parts = line.trim().split(/\s+/);
      rawVerts.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (line.startsWith('f ')) {
      const parts = line.trim().split(/\s+/).slice(1);
      // OBJ 索引从 1 开始；支持 v/vt/vn 格式，只取顶点索引
      const idx = parts.map((p) => {
        const n = Number(p.split('/')[0]);
        return n > 0 ? n - 1 : rawVerts.length / 3 + n;
      });
      // 多边形扇形三角化
      for (let k = 1; k + 1 < idx.length; k++) {
        faces.push([idx[0], idx[k], idx[k + 1]]);
      }
    }
  }
  if (faces.length === 0) throw new Error('OBJ 解析失败：未找到有效的面数据（仅支持三角/多边形 f 语句）');

  const welder = new VertexWelder(thickness);
  const remap = new Map<number, number>();
  const mapped = (i: number) => {
    let out = remap.get(i);
    if (out === undefined) {
      out = welder.add(rawVerts[i * 3], rawVerts[i * 3 + 1], rawVerts[i * 3 + 2]);
      remap.set(i, out);
    }
    return out;
  };
  for (const [a, b, c] of faces) welder.tri(mapped(a), mapped(b), mapped(c));

  const mesh = welder.build();
  if (mesh.triangleCount > 200000) warnings.push(`模型面数 ${mesh.triangleCount} 较大，建议先粗化再仿真`);
  return { mesh, format: 'obj', warnings };
}

export async function importGeometryFile(file: File, thickness: number): Promise<ImportedGeometry> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.stl')) {
    const buf = await file.arrayBuffer();
    return parseStl(buf, thickness);
  }
  if (name.endsWith('.obj')) {
    const text = await file.text();
    return parseObj(text, thickness);
  }
  throw new Error('不支持的文件格式，目前支持 .stl（二进制/ASCII）与 .obj');
}
