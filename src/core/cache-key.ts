// 仿真结果缓存键：所有影响数值结果的参数参与哈希，顺序固定
import type { Gate, Material, MeshParams, ProcessParams, Scheme, TriangleMesh } from './types';
import { fnv1a64, stableStringify } from './utils';

interface CacheInput {
  mesh: TriangleMesh;
  meshParams: MeshParams;
  gates: Gate[];
  process: ProcessParams;
  material: Material;
  uniformThickness: number;
}

export function buildCacheKey(input: CacheInput): string {
  const { mesh, meshParams, gates, process, material, uniformThickness } = input;
  // TypedArray 逐元素参与，键顺序固定；不依赖对象字段插入顺序
  const payload = {
    v: 1,
    mesh: {
      nodeCount: mesh.nodeCount,
      triangleCount: mesh.triangleCount,
      positions: mesh.positions,
      triangles: mesh.triangles,
      thickness: mesh.thickness,
    },
    meshParams,
    gates: gates
      .map((g) => ({ nodeIndex: g.nodeIndex, openTime: g.openTime, weight: g.weight }))
      .sort((a, b) => a.nodeIndex - b.nodeIndex),
    process,
    material: {
      viscosityModel: material.viscosityModel,
      zeroShearViscosity: material.zeroShearViscosity,
      crossN: material.crossN,
      crossTauStar: material.crossTauStar,
      wlfC1: material.wlfC1,
      wlfC2: material.wlfC2,
      wlfTRef: material.wlfTRef,
      carreauLambda: material.carreauLambda,
      carreauN: material.carreauN,
      solidificationTemperature: material.solidificationTemperature,
    },
    uniformThickness,
  };
  return `ck_${fnv1a64(stableStringify(payload))}`;
}

export function schemeCacheInputs(scheme: Scheme, material: Material): CacheInput {
  if (!scheme.mesh) throw new Error('方案缺少网格数据');
  return {
    mesh: scheme.mesh,
    meshParams: scheme.meshParams,
    gates: scheme.gates,
    process: scheme.process,
    material,
    uniformThickness: scheme.uniformThickness,
  };
}
