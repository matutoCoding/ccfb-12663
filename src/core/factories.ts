// 方案/项目工厂：默认工艺参数与网格参数
import type { MeshParams, ProcessParams, Project, Scheme } from './types';
import { uid, now } from './utils';

export function defaultMeshParams(targetEdge: number): MeshParams {
  return {
    targetEdgeLength: targetEdge,
    maxRefineIterations: 8,
    maxCoarsenIterations: 4,
  };
}

export function defaultProcess(): ProcessParams {
  return {
    flowRate: 8000, // mm³/s
    meltTemperature: 230,
    moldTemperature: 50,
    maxInjectionPressure: 120, // MPa
    maxTimeStep: 0.05, // s
  };
}

export function createScheme(projectId: string, materialId: string, name: string, targetEdge: number): Scheme {
  const t = now();
  return {
    id: uid('sch'),
    projectId,
    name,
    createdAt: t,
    updatedAt: t,
    geometrySource: { kind: 'builtin', modelId: 'cover-plate' },
    mesh: null,
    meshParams: defaultMeshParams(targetEdge),
    meshCheck: null,
    gates: [],
    process: defaultProcess(),
    materialId,
    uniformThickness: 0,
  };
}

export function createProjectEntity(name: string): Project {
  const t = now();
  return { id: uid('proj'), name, description: '', createdAt: t, updatedAt: t, schemeIds: [] };
}
