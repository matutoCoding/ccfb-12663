// 性能专项:10 万单元级网格
globalThis.DEBUG_SOLVER = true;
const { runSimulation } = await import('../dist/solver.js');
const { getBuiltin, meshAtLevel } = await import('../dist/geometry.js');
const { DEFAULT_MATERIALS } = await import('../dist/materials.js');

const big = meshAtLevel(getBuiltin('cover-plate').build(), 4);
const N = big.positions.length / 3;
console.log(`网格 ${N} 节点 / ${big.triangles.length / 3} 单元`);
let mid = 0, bd = Infinity;
for (let i = 0; i < N; i++) {
  const d = big.positions[i * 3] ** 2 + big.positions[i * 3 + 1] ** 2;
  if (d < bd) { bd = d; mid = i; }
}
const t0 = Date.now();
runSimulation({
  positions: big.positions, triangles: big.triangles,
  gateNodes: [mid], gateOpenTime: [0],
  material: DEFAULT_MATERIALS[0],
  process: { meltTemp: 240, moldTemp: 60, flowRate: 30, pressureLimit: 120, thickness: 1.2 },
});
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
