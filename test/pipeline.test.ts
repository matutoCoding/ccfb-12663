// Worker 协议与端到端流水线集成测试（Node 环境直接调用算法层，验证消息处理逻辑）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverPlate, buildPhoneCase } from '../src/geometry/builtin';
import { checkMesh } from '../src/geometry/mesh-check';
import { refineMesh, coarsenMesh } from '../src/geometry/remesher';
import { solveFilling } from '../src/sim/solver';
import { buildCacheKey } from '../src/core/cache-key';
import { defaultMaterials } from '../src/core/materials';
import { defaultProcess, createScheme } from '../src/core/factories';
import { stableStringify, fnv1a64 } from '../src/core/utils';
import { buildReportHtml } from '../src/core/report';
import type { Gate } from '../src/core/types';

test('完整流水线：内置模型→检查→细化→拾取浇口→仿真→缓存键→报告，全程可跑通', () => {
  // 1. 内置模型
  let mesh = buildPhoneCase();
  assert.ok(mesh.nodeCount > 0);

  // 2. 网格检查
  const check = checkMesh(mesh);
  assert.ok(check.ok);

  // 3. Worker 同款细化算法
  mesh = refineMesh(mesh, 4, 4);
  const check2 = checkMesh(mesh);
  assert.ok(check2.ok, '细化后仍须为流形网格');

  // 4. 模拟浇口拾取（取两个节点）
  const gates: Gate[] = [
    { id: 'g1', name: '浇口 1', nodeIndex: 10, pickX: 0, pickY: 0, pickZ: 0, openTime: 0, weight: 1 },
    { id: 'g2', name: '浇口 2', nodeIndex: Math.floor(mesh.nodeCount * 0.6), pickX: 1, pickY: 1, pickZ: 0, openTime: 0, weight: 1 },
  ];

  // 5. 仿真
  const material = defaultMaterials()[0];
  const result = solveFilling({
    mesh,
    material,
    process: { ...defaultProcess(), maxInjectionPressure: 400 },
    gates,
    cacheKey: 'ck_e2e',
    schemeId: 'sch_e2e',
  });
  assert.equal(result.metrics.shortShot, false);
  assert.ok(result.fillTimes.every((t) => t >= 0));

  // 6. 缓存键稳定
  const key = buildCacheKey({
    mesh,
    meshParams: { targetEdgeLength: 4, maxRefineIterations: 4, maxCoarsenIterations: 4 },
    gates,
    process: defaultProcess(),
    material,
    uniformThickness: 0,
  });
  assert.match(key, /^ck_[0-9a-f]{16}$/);

  // 7. 报告生成（自包含 HTML）
  const scheme = createScheme('proj', material.id, '集成测试方案', 2);
  const html = buildReportHtml({
    scheme,
    material,
    result,
    screenshot: 'data:image/png;base64,AAAA',
  });
  assert.ok(html.includes('注塑充填仿真报告'));
  assert.ok(html.includes(String(result.metrics.fillTime.toFixed(4))));
  assert.ok(html.includes('data:image/png;base64'));
});

test('粗化流水线：盖板粗化后仍可完整充填', () => {
  const mesh = coarsenMesh(buildCoverPlate(), 8, 4);
  const gate: Gate = { id: 'g', name: 'g', nodeIndex: Math.floor(mesh.nodeCount / 2), pickX: 0, pickY: 0, pickZ: 0, openTime: 0, weight: 1 };
  const r = solveFilling({
    mesh,
    material: defaultMaterials()[0],
    process: { ...defaultProcess(), maxInjectionPressure: 400 },
    gates: [gate],
    cacheKey: 'ck_coarse',
    schemeId: 's',
  });
  assert.equal(r.metrics.shortShot, false);
  assert.ok(r.metrics.maxClampForce > 0);
});

test('确定性工具：stableStringify 键序无关，fnv1a64 跨调用稳定', () => {
  const a = stableStringify({ b: 1, a: 2, c: [3, 1] });
  const b = stableStringify({ c: [3, 1], a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(fnv1a64('injection-mold-sim'), fnv1a64('injection-mold-sim'));
  assert.notEqual(fnv1a64('a'), fnv1a64('b'));
});

test('失败路径：无浇口/压力超限给出可读原因，可被任务管理器标红展示', () => {
  const mesh = buildCoverPlate();
  assert.throws(() => solveFilling({ mesh, material: defaultMaterials()[0], process: defaultProcess(), gates: [], cacheKey: 'x', schemeId: 's' }), /浇口/);
  assert.throws(
    () =>
      solveFilling({
        mesh,
        material: defaultMaterials()[0],
        process: { ...defaultProcess(), maxInjectionPressure: 0.1, flowRate: 50000 },
        gates: [{ id: 'g', name: 'g', nodeIndex: 0, pickX: 0, pickY: 0, pickZ: 0, openTime: 0, weight: 1 }],
        cacheKey: 'x',
        schemeId: 's',
      }),
    /注射压力/,
  );
});
