// 求解器测试:确定性(两次运行逐位一致)、基本物理合理性、性能
import { runSimulation, computeParamHash } from '../dist/solver.js';
import { getBuiltin, meshAtLevel, checkMesh } from '../dist/geometry.js';
import { DEFAULT_MATERIALS } from '../dist/materials.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  ✓', msg);
  else { console.error('  ✗', msg); failures++; }
}

const abs = DEFAULT_MATERIALS[0];
const proc = { meltTemp: 240, moldTemp: 60, flowRate: 30, pressureLimit: 120, thickness: 1.2 };

console.log('== 内置模型网格检查 ==');
for (const id of ['phone-shell', 'cover-plate']) {
  const mesh = getBuiltin(id).build();
  const check = checkMesh(mesh);
  console.log(`  ${id}: ${check.nodeCount} 节点 / ${check.triCount} 单元, 非流形边 ${check.nonManifoldEdgeCount}, 退化 ${check.degenerateCount}`);
  assert(check.nonManifoldEdgeCount === 0, `${id} 无非流形边`);
  assert(check.degenerateCount === 0, `${id} 无退化三角形`);
}

console.log('== 确定性:同一输入跑两次,结果逐位一致 ==');
const base = getBuiltin('cover-plate').build();
const mesh = meshAtLevel(base, 2);
const midNode = (() => {
  // 找离中心最近的节点作为浇口
  let best = 0, bd = Infinity;
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const d = mesh.positions[i * 3] ** 2 + mesh.positions[i * 3 + 1] ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
})();
const input = {
  positions: mesh.positions, triangles: mesh.triangles,
  gateNodes: [midNode], gateOpenTime: [0],
  material: abs, process: proc,
};
const t0 = Date.now();
const r1 = runSimulation(input);
const t1 = Date.now();
const r2 = runSimulation(input);
const t2 = Date.now();
console.log(`  网格 ${r1.nodeCount} 节点 / ${r1.triCount} 单元,第一次 ${t1 - t0}ms,第二次 ${t2 - t1}ms`);
assert(r1.totalFillTime === r2.totalFillTime, `充填时间一致 (${r1.totalFillTime.toFixed(4)}s)`);
assert(r1.maxInjectionPressure === r2.maxInjectionPressure, `最大压力一致 (${r1.maxInjectionPressure.toFixed(2)}MPa)`);
assert(r1.clampForce === r2.clampForce, `锁模力一致 (${r1.clampForce.toFixed(1)}kN)`);
let same = r1.fillTime.length === r2.fillTime.length;
for (let i = 0; same && i < r1.fillTime.length; i++) if (r1.fillTime[i] !== r2.fillTime[i]) same = false;
assert(same, '每节点充填时间逐位一致');
assert(computeParamHash(input) === computeParamHash(input), '参数哈希稳定');

console.log('== 物理合理性 ==');
assert(r1.totalFillTime > 0, '充填时间 > 0');
assert(r1.maxInjectionPressure > 0 && r1.maxInjectionPressure < 1000, `注射压力在合理范围 (${r1.maxInjectionPressure.toFixed(1)}MPa)`);
assert(r1.clampForce > 0, `锁模力 > 0 (${r1.clampForce.toFixed(1)}kN)`);
const vol = 100 * 60 * 1.2 / 1000; // cm³
const expect = vol / proc.flowRate;
console.log(`  理论充填时间(体积/速率)≈ ${expect.toFixed(3)}s,计算值 ${r1.totalFillTime.toFixed(3)}s`);
assert(Math.abs(r1.totalFillTime - expect) / expect < 0.3, '充填时间与体积守恒一致(±30%)');

console.log('== 多浇口 + 熔接痕 ==');
const n2 = mesh.positions.length / 3;
let left = 0, right = 0, lx = Infinity, rx = -Infinity;
for (let i = 0; i < n2; i++) {
  const x = mesh.positions[i * 3];
  if (x < lx) { lx = x; left = i; }
  if (x > rx) { rx = x; right = i; }
}
const r3 = runSimulation({ ...input, gateNodes: [left, right], gateOpenTime: [0, 0] });
assert(r3.weldLines.length > 0, `双浇口对撞应产生熔接痕(检测到 ${r3.weldLines.length} 条)`);
assert(r3.totalFillTime < r1.totalFillTime * 1.2, '双浇口充填时间合理');

console.log('== 手机壳模型(带孔)==');
const shell = meshAtLevel(getBuiltin('phone-shell').build(), 1);
const sn = shell.positions.length / 3;
let s0 = 0, sd = Infinity;
for (let i = 0; i < sn; i++) {
  const d = shell.positions[i * 3] ** 2 + (shell.positions[i * 3 + 1] + 20) ** 2;
  if (d < sd) { sd = d; s0 = i; }
}
const r4 = runSimulation({
  positions: shell.positions, triangles: shell.triangles,
  gateNodes: [s0], gateOpenTime: [0], material: abs, process: proc,
});
assert(r4.totalFillTime > 0, `手机壳充填完成 (${r4.totalFillTime.toFixed(3)}s, 熔接痕 ${r4.weldLines.length}, 困气 ${r4.airTraps.length})`);

console.log('== 性能:10 万单元级 ==');
const big = meshAtLevel(getBuiltin('cover-plate').build(), 4); // 160*2*4^4? 计算: 320 * 4^4 = 81920
const bn = big.positions.length / 3;
console.log(`  网格 ${bn} 节点 / ${big.triangles.length / 3} 单元`);
let bmid = 0, bd2 = Infinity;
for (let i = 0; i < bn; i++) {
  const d = big.positions[i * 3] ** 2 + big.positions[i * 3 + 1] ** 2;
  if (d < bd2) { bd2 = d; bmid = i; }
}
const tb0 = Date.now();
const r5 = runSimulation({
  positions: big.positions, triangles: big.triangles,
  gateNodes: [bmid], gateOpenTime: [0], material: abs, process: proc,
});
const tb1 = Date.now();
console.log(`  计算耗时 ${((tb1 - tb0) / 1000).toFixed(2)}s`);
assert(tb1 - tb0 < 30000, `10 万单元级计算 < 30s(实际 ${((tb1 - tb0) / 1000).toFixed(1)}s)`);

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
