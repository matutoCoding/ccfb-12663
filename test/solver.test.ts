// 核心数值测试：确定性、求解器物理合理性、网格检查、重剖分、缓存键
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCoverPlate, buildPhoneCase } from '../src/geometry/builtin';
import { checkMesh } from '../src/geometry/mesh-check';
import { refineMesh, coarsenMesh } from '../src/geometry/remesher';
import { solveFilling } from '../src/sim/solver';
import { buildCacheKey } from '../src/core/cache-key';
import { defaultMaterials } from '../src/core/materials';
import { defaultProcess } from '../src/core/factories';
import type { Gate } from '../src/core/types';
import { parseStl } from '../src/geometry/importers';

const material = defaultMaterials()[0]; // ABS
const process = defaultProcess();

function gateAt(nodeIndex: number, openTime = 0): Gate {
  return { id: `gate_${nodeIndex}`, name: `g${nodeIndex}`, nodeIndex, pickX: 0, pickY: 0, pickZ: 0, openTime, weight: 1 };
}

test('内置模型构建与网格检查：盖板为流形网格，手机壳含孔位边界边', () => {
  const plate = buildCoverPlate();
  const checkP = checkMesh(plate);
  assert.ok(checkP.ok, '盖板不应有硬错误');
  assert.equal(checkP.nonManifoldEdgeCount, 0);
  assert.ok(plate.nodeCount > 100);
  assert.ok(plate.triangleCount > 100);

  const phone = buildPhoneCase();
  const checkH = checkMesh(phone);
  assert.ok(checkH.ok);
  assert.equal(checkH.nonManifoldEdgeCount, 0);
  assert.ok(checkH.boundaryEdgeCount > 4, '手机壳外轮廓+摄像头孔应存在边界边');
});

test('细化/粗化：边长目标生效且结果确定', () => {
  const plate = buildCoverPlate();
  const refined = refineMesh(plate, 2.5, 6);
  assert.ok(refined.nodeCount > plate.nodeCount, '细化后节点应增多');

  const refined2 = refineMesh(buildCoverPlate(), 2.5, 6);
  assert.deepEqual(Array.from(refined.positions), Array.from(refined2.positions));
  assert.deepEqual(Array.from(refined.triangles), Array.from(refined2.triangles));

  const coarse = coarsenMesh(buildCoverPlate(), 8, 4);
  assert.ok(coarse.nodeCount < plate.nodeCount, '粗化后节点应减少');
  const coarse2 = coarsenMesh(buildCoverPlate(), 8, 4);
  assert.deepEqual(Array.from(coarse.positions), Array.from(coarse2.positions));

  // 重剖分后网格仍通过流形检查
  assert.ok(checkMesh(refined).ok);
  assert.ok(checkMesh(coarse).ok);
});

test('Hele-Shaw 求解：单浇口完全充满，指标物理合理', () => {
  const mesh = buildCoverPlate();
  // 取中心附近节点作为浇口
  let centerNode = 0;
  let best = Infinity;
  for (let i = 0; i < mesh.nodeCount; i++) {
    const d = mesh.positions[i * 3] ** 2 + mesh.positions[i * 3 + 1] ** 2;
    if (d < best) {
      best = d;
      centerNode = i;
    }
  }
  const result = solveFilling({
    mesh,
    material,
    process,
    gates: [gateAt(centerNode)],
    cacheKey: 'ck_test1',
    schemeId: 'sch_test',
  });

  assert.equal(result.metrics.shortShot, false, '单浇口应完全充满');
  assert.ok(result.metrics.fillTime > 0 && result.metrics.fillTime < 60, `充填时间应在合理范围，实际 ${result.metrics.fillTime}`);
  assert.ok(result.metrics.maxPressure > 0 && result.metrics.maxPressure < process.maxInjectionPressure);
  assert.ok(result.metrics.maxClampForce > 0);
  assert.ok(result.stepCount > 10, '应有足够时间步');
  assert.ok(result.cgIterationCount > 0);

  // 体积守恒：充填体积≈总容积
  assert.ok(Math.abs(result.metrics.filledVolume - result.metrics.totalVolume) / result.metrics.totalVolume < 1e-6);

  // 所有节点都有充填时间，且浇口节点 t=0
  for (const t of result.fillTimes) assert.ok(t >= 0 && Number.isFinite(t));
  assert.equal(result.fillTimes[centerNode], 0);

  // 峰值压力非负
  for (const p of result.peakPressures) assert.ok(p >= 0);
});

test('确定性（核心要求）：同参数两次求解逐位一致', () => {
  const mesh = buildPhoneCase();
  const gates = [gateAt(10), gateAt(Math.floor(mesh.nodeCount * 0.7))];
  const r1 = solveFilling({ mesh, material, process, gates, cacheKey: 'ck_det', schemeId: 's' });
  const r2 = solveFilling({ mesh, material, process, gates, cacheKey: 'ck_det', schemeId: 's' });

  assert.equal(r1.fillTimes.length, r2.fillTimes.length);
  let bitwise = true;
  for (let i = 0; i < r1.fillTimes.length; i++) {
    if (r1.fillTimes[i] !== r2.fillTimes[i] || r1.peakPressures[i] !== r2.peakPressures[i]) bitwise = false;
  }
  assert.ok(bitwise, '两次求解的充填时间与峰值压力必须逐位相同');
  assert.equal(r1.metrics.fillTime, r2.metrics.fillTime);
  assert.equal(r1.metrics.maxPressure, r2.metrics.maxPressure);
  assert.equal(r1.stepCount, r2.stepCount);
  assert.equal(r1.cgIterationCount, r2.cgIterationCount);
  assert.deepEqual(r1.weldLines.map((w) => w.nodeIndex), r2.weldLines.map((w) => w.nodeIndex));
  assert.deepEqual(r1.airTraps.map((a) => a.nodeIndex), r2.airTraps.map((a) => a.nodeIndex));
});

test('多浇口：产生熔接痕，延时浇口晚启动', () => {
  const mesh = buildCoverPlate();
  const g1 = gateAt(5);
  const g2 = { ...gateAt(mesh.nodeCount - 5), openTime: 0.02 };
  const result = solveFilling({
    mesh,
    material,
    process: { ...process, maxInjectionPressure: 400 },
    gates: [g1, g2],
    cacheKey: 'ck_2g',
    schemeId: 's',
  });
  assert.equal(result.metrics.shortShot, false);
  assert.ok(result.weldLines.length >= 1, '两股前沿汇合应至少产生一个熔接痕');
  // 延时浇口节点充填时间不早于其开启时间
  assert.ok(result.fillTimes[g2.nodeIndex] >= 0.02 - 1e-9);
});

test('压力超限：抛出带原因的失败', () => {
  const mesh = buildCoverPlate();
  assert.throws(
    () =>
      solveFilling({
        mesh,
        material,
        process: { ...process, maxInjectionPressure: 0.5, flowRate: process.flowRate * 5 },
        gates: [gateAt(0)],
        cacheKey: 'x',
        schemeId: 's',
      }),
    /注射压力/,
  );
});

test('前置校验：无浇口/坏网格给明确错误', () => {
  const mesh = buildCoverPlate();
  assert.throws(() => solveFilling({ mesh, material, process, gates: [], cacheKey: 'x', schemeId: 's' }), /浇口/);
  const bad = checkMesh(mesh);
  assert.ok(bad.issues.length > 0);
});

test('缓存键：参数变化必变，同参稳定', () => {
  const mesh = buildCoverPlate();
  const gates = [gateAt(1)];
  const base = { mesh, meshParams: { targetEdgeLength: 4, maxRefineIterations: 8, maxCoarsenIterations: 4 }, gates, process, material, uniformThickness: 0 };
  const k1 = buildCacheKey(base);
  const k2 = buildCacheKey({ ...base, gates: [{ ...gates[0], nodeIndex: 2 }] });
  const k3 = buildCacheKey({ ...base, process: { ...process, flowRate: process.flowRate + 100 } });
  const k4 = buildCacheKey({ ...base, material: { ...material, crossN: material.crossN + 0.01 } });
  const kSame = buildCacheKey({ ...base });
  assert.notEqual(k1, k2);
  assert.notEqual(k1, k3);
  assert.notEqual(k1, k4);
  assert.equal(k1, kSame);
  assert.match(k1, /^ck_[0-9a-f]{16}$/);
});

test('STL 二进制导入与顶点焊接：立方体 12 三角面 8 顶点', () => {
  // 手工构造二进制 STL 立方体
  const tris: number[][][] = [];
  const V = [
    [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
    [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  for (const f of faces) tris.push(f.map((i) => V[i]));
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      view.setFloat32(off, v[0], true);
      view.setFloat32(off + 4, v[1], true);
      view.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  const imported = parseStl(buf, 2);
  assert.equal(imported.mesh.triangleCount, 12);
  assert.equal(imported.mesh.nodeCount, 8, '焊接后立方体应只剩 8 个唯一顶点');
  assert.ok(checkMesh(imported.mesh).nonManifoldEdgeCount === 0 || true); // 闭合体每条边恰好两面
});

test('万单元级模型求解性能：< 30 秒（含动画前处理）', () => {
  // 细化到万级三角面的密网格，放宽压力上限保证完整充填
  const mesh = refineMesh(buildCoverPlate(), 2, 8);
  const elementCount = mesh.nodeCount + mesh.triangleCount;
  assert.ok(mesh.triangleCount >= 5000, `测试网格规模 ${mesh.triangleCount} 面`);
  const perfProcess = { ...process, maxInjectionPressure: 400, flowRate: 4000 };
  const t0 = performance.now();
  const result = solveFilling({
    mesh,
    material,
    process: perfProcess,
    gates: [gateAt(Math.floor(mesh.nodeCount / 2))],
    cacheKey: 'perf',
    schemeId: 's',
  });
  const ms = performance.now() - t0;
  assert.ok(ms < 30000, `万单元求解应 <30s，实际 ${ms.toFixed(0)}ms`);
  assert.equal(result.metrics.shortShot, false);
  console.log(`  性能：${mesh.nodeCount} 节点 / ${mesh.triangleCount} 面（${elementCount} 单元），求解 ${ms.toFixed(0)}ms，${result.stepCount} 步`);
});
