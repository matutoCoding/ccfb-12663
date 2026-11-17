// 方案打包导出/导入：单个 .imsim.json 文件，同事打开即可查看
import { db, idbGet } from './db';
import type { ExportPackage, Project, Scheme, SerializedResult, SimResult, Material } from './types';
import { uid, now, downloadBlob } from './utils';

function serializeResult(r: SimResult): SerializedResult {
  return {
    ...r,
    fillTimes: Array.from(r.fillTimes),
    peakPressures: Array.from(r.peakPressures),
  };
}

function deserializeResult(r: SerializedResult): SimResult {
  return {
    ...r,
    fillTimes: Float64Array.from(r.fillTimes),
    peakPressures: Float64Array.from(r.peakPressures),
  };
}

/** 导出项目（含全部方案、引用材料、已有仿真结果） */
export async function exportProject(projectId: string): Promise<ExportPackage> {
  const project = await idbGet<Project>('projects', projectId);
  if (!project) throw new Error('待导出的项目不存在');
  const schemes: Scheme[] = [];
  const materialIds = new Set<string>();
  for (const sid of project.schemeIds) {
    const s = await db.getScheme(sid);
    if (s) {
      schemes.push(s);
      materialIds.add(s.materialId);
    }
  }
  const allMaterials = await db.listMaterials();
  const materials = allMaterials.filter((m) => materialIds.has(m.id));

  const allResults = await db.listResults();
  const schemeIdSet = new Set(schemes.map((s) => s.id));
  const results = allResults.filter((r) => schemeIdSet.has(r.schemeId)).map(serializeResult);

  return {
    format: 'imsim-package',
    version: 1,
    exportedAt: now(),
    project,
    schemes,
    materials,
    results,
  };
}

export async function downloadPackage(pkg: ExportPackage): Promise<void> {
  const blob = new Blob([JSON.stringify(pkg)], { type: 'application/json' });
  downloadBlob(blob, `${pkg.project.name.replace(/[\\/:*?"<>|]/g, '_')}.imsim.json`);
}

export interface ImportOutcome {
  project: Project;
  schemeCount: number;
  materialCount: number;
  resultCount: number;
  idRemap: Map<string, string>;
}

/**
 * 导入方案包：全部 id 重新分配避免与本机数据冲突，
 * 实体间引用关系按映射重写；结果缓存同步入库。
 */
export async function importPackage(pkg: ExportPackage): Promise<ImportOutcome> {
  if (pkg.format !== 'imsim-package' || pkg.version !== 1) {
    throw new Error('文件格式或版本不受支持，请确认是本平台导出的 .imsim.json');
  }
  const idRemap = new Map<string, string>();
  const remap = (oldId: string, prefix: string) => {
    let nid = idRemap.get(oldId);
    if (!nid) {
      nid = uid(prefix);
      idRemap.set(oldId, nid);
    }
    return nid;
  };

  const newProject: Project = {
    ...pkg.project,
    id: remap(pkg.project.id, 'proj'),
    name: `${pkg.project.name}（导入）`,
    createdAt: now(),
    updatedAt: now(),
    schemeIds: [],
  };

  const materials: Material[] = [];
  const materialRemap = new Map<string, string>();
  for (const m of pkg.materials) {
    const nid = remap(m.id, 'mat');
    materialRemap.set(m.id, nid);
    materials.push({ ...m, id: nid, builtin: false });
  }

  const schemes: Scheme[] = [];
  for (const s of pkg.schemes) {
    const nid = remap(s.id, 'sch');
    const ns: Scheme = {
      ...structuredClone(s),
      id: nid,
      projectId: newProject.id,
      materialId: materialRemap.get(s.materialId) ?? s.materialId,
      gates: s.gates.map((g) => ({ ...g, id: remap(g.id, 'gate') })),
      createdAt: now(),
      updatedAt: now(),
    };
    schemes.push(ns);
    newProject.schemeIds.push(nid);
  }

  // 落库
  await db.putProject(newProject);
  for (const m of materials) await db.putMaterial(m);
  for (const s of schemes) await db.putScheme(s);

  let resultCount = 0;
  for (const sr of pkg.results ?? []) {
    const newSchemeId = idRemap.get(sr.schemeId);
    if (!newSchemeId) continue;
    const result = deserializeResult(sr);
    result.id = remap(sr.id, 'res');
    result.schemeId = newSchemeId;
    if (materialRemap.has(result.materialId)) result.materialId = materialRemap.get(result.materialId)!;
    await db.putResult(result);
    resultCount++;
  }

  return {
    project: newProject,
    schemeCount: schemes.length,
    materialCount: materials.length,
    resultCount,
    idRemap,
  };
}

export async function readPackageFile(file: File): Promise<ExportPackage> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('文件不是合法 JSON，无法解析为方案包');
  }
  const pkg = parsed as Partial<ExportPackage>;
  if (pkg.format !== 'imsim-package') throw new Error('缺少 imsim-package 格式标识，不是有效的方案包文件');
  return pkg as ExportPackage;
}
