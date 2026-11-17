// 网格质量检查：非流形边、破面（边界边）、退化面、重复面、孤立节点
import type { MeshCheckResult, MeshIssue, TriangleMesh } from '../core/types';
import { triangleArea } from './vector';

const DEGEN_AREA_EPS = 1e-12;

export function checkMesh(mesh: TriangleMesh): MeshCheckResult {
  const issues: MeshIssue[] = [];
  const { nodeCount, triangleCount, triangles: tri, positions: pos } = mesh;

  // ---- 边 → 邻接三角面（规范键 min-max，保证与输入顺序无关的确定性） ----
  const edgeMap = new Map<string, number[]>();
  const edgeNodes = new Map<string, [number, number]>();
  const addEdge = (a: number, b: number, faceIdx: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}_${hi}`;
    const list = edgeMap.get(key);
    if (list) list.push(faceIdx);
    else {
      edgeMap.set(key, [faceIdx]);
      edgeNodes.set(key, [lo, hi]);
    }
  };

  // ---- 退化面 / 重复面 ----
  const faceKeys = new Map<string, number>();
  let degenerateCount = 0;
  let duplicateFaceCount = 0;
  for (let f = 0; f < triangleCount; f++) {
    const a = tri[f * 3];
    const b = tri[f * 3 + 1];
    const c = tri[f * 3 + 2];
    addEdge(a, b, f);
    addEdge(b, c, f);
    addEdge(c, a, f);

    if (a === b || b === c || c === a) {
      degenerateCount++;
      issues.push({
        level: 'error',
        kind: 'degenerate',
        message: `第 ${f + 1} 个三角面存在重复顶点索引`,
        triangleIndices: [f],
      });
      continue;
    }
    const area = triangleArea(
      pos[a * 3],
      pos[a * 3 + 1],
      pos[a * 3 + 2],
      pos[b * 3],
      pos[b * 3 + 1],
      pos[b * 3 + 2],
      pos[c * 3],
      pos[c * 3 + 1],
      pos[c * 3 + 2],
    );
    if (area < DEGEN_AREA_EPS) {
      degenerateCount++;
      issues.push({
        level: 'error',
        kind: 'degenerate',
        message: `第 ${f + 1} 个三角面面积接近 0（${area.toExponential(2)} mm²），为退化面`,
        triangleIndices: [f],
      });
    }
    const fk = [a, b, c].sort((x, y) => x - y).join('_');
    const prev = faceKeys.get(fk);
    if (prev !== undefined) {
      duplicateFaceCount++;
      issues.push({
        level: 'warning',
        kind: 'duplicate-face',
        message: `第 ${f + 1} 个三角面与第 ${prev + 1} 个面重复`,
        triangleIndices: [prev, f],
      });
    } else {
      faceKeys.set(fk, f);
    }
  }

  // ---- 非流形边 / 边界边（破面） ----
  let nonManifoldEdgeCount = 0;
  let boundaryEdgeCount = 0;
  const boundarySamples: number[] = [];
  const nonManifoldSamples: number[] = [];
  for (const [key, faces] of edgeMap) {
    if (faces.length > 2) {
      nonManifoldEdgeCount++;
      if (nonManifoldSamples.length < 10) {
        const [na, nb] = edgeNodes.get(key)!;
        nonManifoldSamples.push(na, nb);
      }
    } else if (faces.length === 1) {
      boundaryEdgeCount++;
      if (boundarySamples.length < 10) {
        const [na, nb] = edgeNodes.get(key)!;
        boundarySamples.push(na, nb);
      }
    }
  }
  if (nonManifoldEdgeCount > 0) {
    issues.push({
      level: 'error',
      kind: 'non-manifold',
      message: `检测到 ${nonManifoldEdgeCount} 条非流形边（被 3 个及以上三角面共用），无法进行可靠充填计算`,
      nodeIndices: Array.from(new Set(nonManifoldSamples)),
    });
  }
  if (boundaryEdgeCount > 0) {
    issues.push({
      level: boundaryEdgeCount <= 4 ? 'info' : 'warning',
      kind: 'hole',
      message:
        `检测到 ${boundaryEdgeCount} 条边界边（开放轮廓/孔位）。` +
        (boundaryEdgeCount <= 4 ? ' 内置薄壳模型的外轮廓属正常现象。' : ' 数量较多时请检查模型是否存在破面。'),
      nodeIndices: Array.from(new Set(boundarySamples)),
    });
  }

  // ---- 孤立节点 ----
  const used = new Uint8Array(nodeCount);
  for (let i = 0; i < tri.length; i++) used[tri[i]] = 1;
  let isolatedNodeCount = 0;
  const isolatedSamples: number[] = [];
  for (let n = 0; n < nodeCount; n++) {
    if (!used[n]) {
      isolatedNodeCount++;
      if (isolatedSamples.length < 10) isolatedSamples.push(n);
    }
  }
  if (isolatedNodeCount > 0) {
    issues.push({
      level: 'warning',
      kind: 'isolated',
      message: `${isolatedNodeCount} 个节点未被任何三角面引用（孤立节点）`,
      nodeIndices: isolatedSamples,
    });
  }

  const hardErrors = issues.filter((i) => i.level === 'error').length;
  issues.unshift({
    level: 'info',
    kind: 'info',
    message: `网格统计：${nodeCount} 节点 / ${triangleCount} 三角面 / ${edgeMap.size} 边`,
  });

  return {
    ok: hardErrors === 0,
    edgeCount: edgeMap.size,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
    degenerateCount,
    duplicateFaceCount,
    isolatedNodeCount,
    issues,
  };
}

export function issueLevelCount(result: MeshCheckResult): Record<MeshIssue['level'], number> {
  const c = { error: 0, warning: 0, info: 0 };
  for (const i of result.issues) c[i.level]++;
  return c;
}
