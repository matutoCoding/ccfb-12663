// Hele-Shaw 2.5D 充填求解器（CV-FEM，三角网格）
// 控制方程：∇·(S ∇p) = 0，S = h^3/(12η)
// 流动前沿由节点控制体充填分数 f 跟踪；全部循环顺序固定，保证可复现
import type { Gate, Material, MeshCheckResult, ProcessParams, SimResult, TriangleMesh, WeldLine, AirTrap } from '../core/types';
import { uid } from '../core/utils';
import { SymSparseMatrix, conjugateGradient } from './linalg';
import { materialViscosity, shearRateHeleShaw } from './viscosity';

export interface SolverOptions {
  mesh: TriangleMesh;
  material: Material;
  process: ProcessParams;
  gates: Gate[];
  cacheKey: string;
  schemeId: string;
  onProgress?: (percent: number) => void;
  shouldCancel?: () => boolean;
}

const CG_MAX_ITER = 800;
const CG_TOL = 1e-6;
const FILL_EPS = 1e-10;
const MAX_STEPS = 20000;
const AIR_TRAP_SCAN_INTERVAL = 25;
/** 传导矩阵重新组装间隔（步）；等温下矩阵缓变，复用可大幅降低计算量 */
const REASSEMBLE_INTERVAL = 32;

interface ElementData {
  area: Float64Array; // 每三角面面积 mm²
  grad: Float64Array; // 每三角面形状函数梯度（三角形内常数），长度 triCount*6：(b_i,b_j),(b_k...) 仅需 b,c 存 6 个分量
}

export function solveFilling(opts: SolverOptions): SimResult {
  const { mesh, material, process, gates } = opts;
  const N = mesh.nodeCount;
  const T = mesh.triangleCount;
  const pos = mesh.positions;
  const tri = mesh.triangles;
  const h = Float64Array.from(mesh.thickness);
  const tempK = process.meltTemperature + 273.15;

  // ---------- 前置校验 ----------
  if (gates.length === 0) throw new Error('方案未设置浇口，无法启动充填计算');
  const gateNodes = gates.map((g) => g.nodeIndex);
  if (new Set(gateNodes).size !== gateNodes.length) throw new Error('存在两个浇口落在同一节点上，请调整浇口位置');
  for (const g of gates) {
    if (g.nodeIndex < 0 || g.nodeIndex >= N) throw new Error(`浇口「${g.name}」节点索引越界，请重新拾取`);
  }

  // ---------- 单元几何：面积、梯度、节点控制体体积 ----------
  const ed = buildElementData(mesh);
  const cvVolume = new Float64Array(N); // 节点控制体体积 mm³（含厚度）
  for (let f = 0; f < T; f++) {
    const a = tri[f * 3],
      b = tri[f * 3 + 1],
      c = tri[f * 3 + 2];
    const third = ed.area[f] / 3;
    cvVolume[a] += third * h[a];
    cvVolume[b] += third * h[b];
    cvVolume[c] += third * h[c];
  }
  let totalVolume = 0;
  for (let i = 0; i < N; i++) totalVolume += cvVolume[i];

  // ---------- 邻接表（确定性：按节点索引升序） ----------
  const neighbors = buildNeighbors(mesh);

  // ---------- 状态场 ----------
  const fill = new Float64Array(N); // 充填分数 0..1
  const fillTime = new Float64Array(N).fill(-1); // -1 表示未充填
  const peakPressure = new Float64Array(N);
  const source = new Array<string>(N).fill(''); // 充填来源浇口 id
  const pressure = new Float64Array(N); // 当前压力场 MPa（暖启动初值）
  const etaNode = new Float64Array(N).fill(material.zeroShearViscosity);

  let filledVolume = 0;
  let simTime = 0;
  let maxPressurePa = 0;
  let maxClampForce = 0;
  let stepCount = 0;
  let cgIterTotal = 0;
  let haveWarmStart = false;
  let cachedFlow: { Ks: SymSparseMatrix; scale: Float64Array; baseMatrix: SymSparseMatrix; fixedKey: string } | null = null;
  let activeMatrix: SymSparseMatrix | null = null;
  let shearRateSum = 0;
  let shearRateSamples = 0;
  const weldLines: WeldLine[] = [];
  const airTraps: AirTrap[] = [];
  const weldSeen = new Set<number>();
  const airSeen = new Set<number>();

  // 浇口初始充填：仅即刻开启（openTime=0）的浇口在 t=0 充满；
  // 延时浇口保持空穴，到开启时刻再激活，保证其充填时间不早于开启时间
  for (const g of gates) {
    if (g.openTime <= 1e-12) {
      fill[g.nodeIndex] = 1;
      fillTime[g.nodeIndex] = 0;
      source[g.nodeIndex] = g.id;
      filledVolume += cvVolume[g.nodeIndex];
    }
  }

  const activeGateAt = (t: number): Gate[] => gates.filter((g) => t + 1e-12 >= g.openTime);
  const projectedArea = computeProjectedArea(mesh);

  // ---------- 主时间步进 ----------
  let lastProgress = -1;
  while (filledVolume < totalVolume * (1 - 1e-9)) {
    if (opts.shouldCancel?.()) throw new Error('cancel');
    if (stepCount >= MAX_STEPS) throw new Error(`达到最大时间步数 ${MAX_STEPS} 仍未充满，模型可能存在无法充填的封闭区域`);

    const activeGates = activeGateAt(simTime);
    if (activeGates.length === 0) {
      // 所有浇口尚未开启：时间直接推进到最早开启时刻
      simTime = Math.min(...gates.map((g) => g.openTime));
      continue;
    }
    // 延时浇口到达开启时刻：立即充满并登记来源/充填时间
    for (const g of activeGates) {
      if (fill[g.nodeIndex] < 1 - FILL_EPS) {
        fill[g.nodeIndex] = 1;
        fillTime[g.nodeIndex] = Math.max(simTime, g.openTime);
        source[g.nodeIndex] = g.id;
        filledVolume += cvVolume[g.nodeIndex];
      }
    }
    if (filledVolume >= totalVolume * (1 - 1e-9)) break;
    const gateSet = new Uint8Array(N);
    for (const g of activeGates) gateSet[g.nodeIndex] = 1;
    const fixedNodes = activeGates.map((g) => g.nodeIndex).sort((a, b) => a - b);

    // ---------- 压力场求解 ----------
    // 等温假设下传导矩阵随粘度缓慢变化，每 REASSEMBLE_INTERVAL 步才重新组装一次，
    // 中间步复用上一次的矩阵/缩放结构，仅靠暖启动 CG 跟踪压力场变化。
    const freeCount = N - fixedNodes.length;
    let Ks: SymSparseMatrix;
    let scale: Float64Array;
    let baseMatrix: SymSparseMatrix;
    const rhsScaled = new Float64Array(N);
    const needReassemble =
      stepCount % REASSEMBLE_INTERVAL === 0 ||
      cachedFlow === null ||
      cachedFlow.fixedKey !== fixedNodes.join(',');

    if (needReassemble) {
      baseMatrix = assembleConductivity(mesh, ed, etaNode);
      const { matrix: Kd, rhs } = baseMatrix.buildFlowSystem(fixedNodes);
      const perNode = process.flowRate / Math.max(1, freeCount);
      for (let i = 0; i < N; i++) rhs[i] = gateSet[i] ? 0 : perNode;
      const scaled = Kd.diagonallyScaled();
      Ks = scaled.matrix;
      scale = scaled.scale;
      for (let i = 0; i < N; i++) rhsScaled[i] = scale[i] * rhs[i];
      cachedFlow = { Ks, scale, baseMatrix, fixedKey: fixedNodes.join(',') };
    } else {
      const cached = cachedFlow!;
      Ks = cached.Ks;
      scale = cached.scale;
      baseMatrix = cached.baseMatrix;
      const perNode = process.flowRate / Math.max(1, freeCount);
      for (let i = 0; i < N; i++) rhsScaled[i] = gateSet[i] ? 0 : scale[i] * perNode;
    }
    activeMatrix = baseMatrix;

    // 暖启动仅在矩阵未重组装时有效；矩阵变化后旧解与新系统不匹配，须冷启动
    const warmX = new Float64Array(N);
    for (let i = 0; i < N; i++) warmX[i] = pressure[i] / scale[i];
    const useWarm = haveWarmStart && !needReassemble;
    let cgResult = conjugateGradient(Ks, rhsScaled, useWarm ? warmX : new Float64Array(N), {
      maxIterations: CG_MAX_ITER,
      tolerance: CG_TOL,
    });
    cgIterTotal += cgResult.iterations;
    // 暖启动意外失败时回退到零初值重解一次
    if (!cgResult.converged && cgResult.residual > 1e-2) {
      cgResult = conjugateGradient(Ks, rhsScaled, new Float64Array(N), {
        maxIterations: CG_MAX_ITER * 2,
        tolerance: CG_TOL,
      });
      cgIterTotal += cgResult.iterations;
    }
    if (!cgResult.converged && cgResult.residual > 1e-2) {
      throw new Error(`压力场求解不收敛（残差 ${cgResult.residual.toExponential(2)}），请检查网格是否存在破面或非流形边`);
    }
    for (let i = 0; i < N; i++) pressure[i] = scale[i] * cgResult.x[i];
    haveWarmStart = true;

    // 守恒校验
    const kp = multiplyK(baseMatrix, pressure);
    let gateInflow = 0;
    for (const gn of fixedNodes) gateInflow += -kp[gn];
    if (!(gateInflow > 0)) throw new Error('浇口进流为 0：传导矩阵奇异，请检查网格连通性与壁厚设置');

    // 周期性更新粘度（剪切变稀），下次重组装时生效
    if (needReassemble) {
      updateViscosity(mesh, ed, pressure, h, material, tempK, etaNode, (sr) => {
        shearRateSum += sr;
        shearRateSamples++;
      });
    }

    // 前沿节点从已充填区获得的边通量（mm³/s），闭浇口不参与供流
    const closedSet = new Set<number>();
    for (const g of gates) if (simTime + 1e-12 < g.openTime) closedSet.add(g.nodeIndex);
    const inflow = computeInflowFromFilled(activeMatrix!, pressure, fill, neighbors, gateSet, closedSet);

    // 峰值压力 / 锁模力（相对压力为负，幅值 = 浇口 0 与最低压力之差）
    for (let i = 0; i < N; i++) {
      const pAbs = Math.abs(pressure[i]);
      if (pAbs > peakPressure[i]) peakPressure[i] = pAbs;
      if (pAbs > maxPressurePa) maxPressurePa = pAbs;
    }
    const clampNow = (maxPressurePa / 1e6) * projectedArea * 1e3; // MPa·mm² → N → kN
    if (clampNow > maxClampForce) maxClampForce = clampNow;

    if (maxPressurePa / 1e6 > process.maxInjectionPressure) {
      throw new Error(
        `注射压力达到 ${(maxPressurePa / 1e6).toFixed(1)} MPa，超过上限 ${process.maxInjectionPressure} MPa：` +
          `请提高压力上限、降低流量或更换流动性更好的材料`,
      );
    }

    // ---------- 自适应时间步 ----------
    // 收集所有前沿节点的“充满所需时间”，取其较低分位（约前 1/8）作为 dt：
    // 每步让一小批节点同时充满，步数相比“单节点/步”显著下降，
    // 同时用工艺 maxTimeStep 截断保证时间分辨率；节点允许部分充填。
    const fillCandidates: number[] = [];
    for (let i = 0; i < N; i++) {
      if (fill[i] >= 1 - FILL_EPS || gateSet[i]) continue;
      const netIn = inflow[i];
      if (netIn <= FILL_EPS) continue;
      fillCandidates.push(((1 - fill[i]) * cvVolume[i]) / netIn);
    }
    let dt: number;
    if (fillCandidates.length === 0) {
      dt = process.maxTimeStep * 0.1; // 前沿暂无来流，小步长让困气扫描介入
    } else {
      fillCandidates.sort((a, b) => a - b);
      const k = Math.max(0, Math.floor(fillCandidates.length / 8) - 1);
      dt = Math.min(process.maxTimeStep, fillCandidates[k]);
    }
    if (!(dt > 0) || !Number.isFinite(dt)) dt = process.maxTimeStep * 0.1;

    // ---------- 推进充填 ----------
    const newlyFilled: number[] = [];
    for (let i = 0; i < N; i++) {
      if (fill[i] >= 1 - FILL_EPS || gateSet[i] || closedSet.has(i)) continue;
      const netIn = inflow[i];
      if (netIn <= 0) continue;
      const dv = netIn * dt;
      const before = fill[i];
      fill[i] = Math.min(1, fill[i] + dv / cvVolume[i]);
      filledVolume += Math.min(cvVolume[i] * (1 - before), dv);
      if (fill[i] >= 1 - FILL_EPS) newlyFilled.push(i);
    }
    // 新充满节点的来源：取当前给它供流的已充满邻节点中通量贡献最大者（确定性遍历）
    for (const i of newlyFilled) {
      fillTime[i] = simTime + dt;
      let bestSrc = '';
      let bestFlux = -Infinity;
      const nbrs = neighbors[i];
      for (let k = 0; k < nbrs.length; k++) {
        const j = nbrs[k];
        if (fill[j] < 1 - FILL_EPS) continue;
        const q = edgeCoeff(activeMatrix!, i, j) * (pressure[j] - pressure[i]);
        if (q > bestFlux) {
          bestFlux = q;
          bestSrc = source[j];
        }
      }
      if (!bestSrc) bestSrc = activeGates[0].id;
      // 熔接痕：不同来源的两股前沿在此节点相遇
      const neighborSources = new Set<string>();
      for (let k = 0; k < nbrs.length; k++) {
        const j = nbrs[k];
        if (fill[j] >= 1 - FILL_EPS && source[j]) neighborSources.add(source[j]);
      }
      neighborSources.add(bestSrc);
      if (neighborSources.size >= 2 && !weldSeen.has(i)) {
        weldSeen.add(i);
        const ids = [...neighborSources].sort();
        weldLines.push({
          id: uid('weld'),
          nodeIndex: i,
          x: pos[i * 3],
          y: pos[i * 3 + 1],
          z: pos[i * 3 + 2],
          sourceA: ids[0],
          sourceB: ids[1],
          fillTime: fillTime[i],
        });
      }
      source[i] = bestSrc;
    }

    simTime += dt;
    stepCount++;

    // ---------- 周期性困气扫描：被已充填区域包围、且永远等不到来流的空节点 ----------
    if (stepCount % AIR_TRAP_SCAN_INTERVAL === 0 && filledVolume < totalVolume) {
      const traps = scanAirTraps(mesh, fill, inflow, neighbors);
      for (const n of traps) {
        if (airSeen.has(n)) continue;
        airSeen.add(n);
        airTraps.push({
          id: uid('air'),
          nodeIndex: n,
          x: pos[n * 3],
          y: pos[n * 3 + 1],
          z: pos[n * 3 + 2],
          fillTime: simTime,
        });
      }
    }

    const progress = Math.min(99, (filledVolume / totalVolume) * 100);
    const pct = Math.floor(progress);
    if (pct !== lastProgress) {
      lastProgress = pct;
      opts.onProgress?.(pct);
    }
  }

  // ---------- 收尾：未充填节点 → 困气/短射 ----------
  const shortShotNodes: number[] = [];
  for (let i = 0; i < N; i++) {
    if (fill[i] < 1 - FILL_EPS) {
      shortShotNodes.push(i);
      if (!airSeen.has(i)) {
        airSeen.add(i);
        airTraps.push({
          id: uid('air'),
          nodeIndex: i,
          x: pos[i * 3],
          y: pos[i * 3 + 1],
          z: pos[i * 3 + 2],
          fillTime: simTime,
        });
      }
    }
  }
  const shortShot = shortShotNodes.length > 0;

  // 熔接痕/困气按节点索引排序，保证输出顺序确定
  weldLines.sort((a, b) => a.nodeIndex - b.nodeIndex);
  airTraps.sort((a, b) => a.nodeIndex - b.nodeIndex);

  opts.onProgress?.(100);

  return {
    id: uid('res'),
    cacheKey: opts.cacheKey,
    schemeId: opts.schemeId,
    materialId: material.id,
    createdAt: Date.now(),
    fillTimes: fillTime,
    peakPressures: peakPressure,
    sourceGateIds: source,
    metrics: {
      fillTime: simTime,
      maxPressure: maxPressurePa / 1e6,
      maxClampForce,
      filledVolume,
      totalVolume,
      shortShot,
      avgShearRate: shearRateSamples > 0 ? shearRateSum / shearRateSamples : 0,
    },
    weldLines,
    airTraps,
    paramSummary: {
      flowRate: process.flowRate,
      meltTemperature: process.meltTemperature,
      moldTemperature: process.moldTemperature,
      maxInjectionPressure: process.maxInjectionPressure,
      material: material.name,
      gateCount: gates.length,
      nodeCount: N,
      triangleCount: T,
    },
    stepCount,
    cgIterationCount: cgIterTotal,
  };
}

// ---------------- 内部辅助 ----------------

function buildElementData(mesh: TriangleMesh): ElementData {
  const T = mesh.triangleCount;
  const tri = mesh.triangles;
  const p = mesh.positions;
  const area = new Float64Array(T);
  // 每面存 ∇N_a 与 ∇N_b（∇N_c = -∇N_a-∇N_b）
  const grad = new Float64Array(T * 6);
  for (let f = 0; f < T; f++) {
    const a = tri[f * 3],
      b = tri[f * 3 + 1],
      c = tri[f * 3 + 2];
    const ax = p[a * 3],
      ay = p[a * 3 + 1],
      az = p[a * 3 + 2];
    const bx = p[b * 3],
      by = p[b * 3 + 1],
      bz = p[b * 3 + 2];
    const cx = p[c * 3],
      cy = p[c * 3 + 1],
      cz = p[c * 3 + 2];
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az;
    const vx = cx - ax,
      vy = cy - ay,
      vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const crossLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const ar = crossLen / 2;
    area[f] = ar;
    if (crossLen < 1e-15) continue;
    // 三角形切平面上的二维协变基（e1=u 方向，e2 为面内垂直方向）
    const invU = 1 / Math.sqrt(ux * ux + uy * uy + uz * uz);
    const e1x = ux * invU,
      e1y = uy * invU,
      e1z = uz * invU;
    // n̂ = cross/|cross|，e2 = n̂ × e1
    const nnx = nx / crossLen,
      nny = ny / crossLen,
      nnz = nz / crossLen;
    const e2x = nny * e1z - nnz * e1y;
    const e2y = nnz * e1x - nnx * e1z;
    const e2z = nnx * e1y - nny * e1x;
    const u1 = ux * e1x + uy * e1y + uz * e1z; // = |u|
    const v1 = vx * e1x + vy * e1y + vz * e1z;
    const v2 = vx * e2x + vy * e2y + vz * e2z;
    // 局部二维三角形：a=(0,0), b=(u1,0), c=(v1,v2)，det = u1*v2
    const det2 = u1 * v2;
    const invDet = 1 / det2;
    // ∇N_b = (v2, -v1)/det，∇N_c = (0, u1)/det，∇N_a = -∇N_b-∇N_c
    const gB1 = v2 * invDet;
    const gB2 = -v1 * invDet;
    const gC1 = 0;
    const gC2 = u1 * invDet;
    // 转回三维：∇N = g1*e1 + g2*e2
    const gbx = gB1 * e1x + gB2 * e2x;
    const gby = gB1 * e1y + gB2 * e2y;
    const gbz = gB1 * e1z + gB2 * e2z;
    const gcx = gC1 * e1x + gC2 * e2x;
    const gcy = gC1 * e1y + gC2 * e2y;
    const gcz = gC1 * e1z + gC2 * e2z;
    grad[f * 6] = gbx;
    grad[f * 6 + 1] = gby;
    grad[f * 6 + 2] = gbz;
    grad[f * 6 + 3] = gcx;
    grad[f * 6 + 4] = gcy;
    grad[f * 6 + 5] = gcz;
  }
  return { area, grad };
}

/**
 * 组装全局传导矩阵 K_ij = Σ_f S_f A_f (∇N_i·∇N_j)
 * 几何量全部 mm；S = h³/(12η)，其中 h 由 mm 换算为 m，保证 S 单位 m³/(Pa·s)。
 * 矩阵乘压力(Pa)得到体积通量 m³/s；为与 mm³/s 的流量口径一致，统一 ×1e9 输出 mm³/s。
 */
const MM3_PER_M3 = 1e9;

function assembleConductivity(mesh: TriangleMesh, ed: ElementData, etaNode: Float64Array): SymSparseMatrix {
  const T = mesh.triangleCount;
  const tri = mesh.triangles;
  const h = mesh.thickness;
  const rows: number[] = [];
  const cols: number[] = [];
  const vals: number[] = [];
  for (let f = 0; f < T; f++) {
    const a = tri[f * 3],
      b = tri[f * 3 + 1],
      c = tri[f * 3 + 2];
    const etaF = (etaNode[a] + etaNode[b] + etaNode[c]) / 3;
    const hFmm = (h[a] + h[b] + h[c]) / 3;
    const hM = hFmm * 1e-3; // mm → m
    const S = (hM * hM * hM) / (12 * Math.max(etaF, 1e-6)); // m³/(Pa·s)
    const gbx = ed.grad[f * 6],
      gby = ed.grad[f * 6 + 1],
      gbz = ed.grad[f * 6 + 2];
    const gcx = ed.grad[f * 6 + 3],
      gcy = ed.grad[f * 6 + 4],
      gcz = ed.grad[f * 6 + 5];
    const gax = -gbx - gcx,
      gay = -gby - gcy,
      gaz = -gbz - gcz;
    const g = [
      [gax, gay, gaz],
      [gbx, gby, gbz],
      [gcx, gcy, gcz],
    ];
    const ids = [a, b, c];
    // 梯度 1/mm、面积 mm²，二者点积量纲自洽；S(m³/(Pa·s))×1e9 → mm³/(Pa·s)
    const coef = S * ed.area[f] * MM3_PER_M3;
    for (let u = 0; u < 3; u++) {
      for (let v = u; v < 3; v++) {
        const dot = g[u][0] * g[v][0] + g[u][1] * g[v][1] + g[u][2] * g[v][2];
        rows.push(ids[u]);
        cols.push(ids[v]);
        vals.push(coef * dot);
      }
    }
  }
  return SymSparseMatrix.fromTriplets(mesh.nodeCount, rows, cols, vals);
}

/** 计算 K·x（节点“源”通量，浇口为正注入） */
function multiplyK(K: SymSparseMatrix, x: Float64Array): Float64Array {
  const out = new Float64Array(K.n);
  K.multiply(x, out);
  return out;
}

/**
 * 每个节点从其已充填邻节点获得的净流入（mm³/s）。
 * 边通量 q_ji = K_ij·(p_j − p_i)，只累计从高压侧（已充填区）指向当前节点的部分。
 */
function computeInflowFromFilled(
  K: SymSparseMatrix,
  pressure: Float64Array,
  fill: Float64Array,
  neighbors: number[][],
  gateSet: Uint8Array,
  closedGateNodes?: Set<number>,
): Float64Array {
  const n = K.n;
  const inflow = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (fill[i] >= 1 - FILL_EPS || gateSet[i]) continue;
    let sum = 0;
    const nbrs = neighbors[i];
    for (let k = 0; k < nbrs.length; k++) {
      const j = nbrs[k];
      if (fill[j] < 1 - FILL_EPS) continue; // 只接收已充填区来流
      // 未开启的浇口不向外供流
      if (closedGateNodes && closedGateNodes.has(j)) continue;
      let kij = 0;
      for (let p = K.rowPtr[i]; p < K.rowPtr[i + 1]; p++) {
        if (K.colIdx[p] === j) {
          kij = K.values[p];
          break;
        }
      }
      // K_ij ≤ 0（Laplacian 离对角项）；已充填邻节点 j 压力更高（p_j > p_i，差值为正）
      // 达西流从 j 流向 i 的体积通量 q = K_ij·(p_j − p_i) ≥ 0
      sum += kij * (pressure[j] - pressure[i]);
    }
    inflow[i] = sum;
  }
  return inflow;
}

/** 取矩阵中 K_ij 系数（离对角项为负值） */
function edgeCoeff(K: SymSparseMatrix, i: number, j: number): number {
  for (let p = K.rowPtr[i]; p < K.rowPtr[i + 1]; p++) {
    if (K.colIdx[p] === j) return K.values[p];
  }
  return 0;
}

/** 依据压力梯度更新节点粘度（面内速度 → 剪切速率 → Cross-WLF） */
function updateViscosity(
  mesh: TriangleMesh,
  ed: ElementData,
  pressure: Float64Array,
  h: Float64Array,
  material: Material,
  tempK: number,
  etaNode: Float64Array,
  onShear: (sr: number) => void,
): void {
  const T = mesh.triangleCount;
  const tri = mesh.triangles;
  const acc = new Float64Array(mesh.nodeCount);
  const cnt = new Uint32Array(mesh.nodeCount);
  for (let f = 0; f < T; f++) {
    const a = tri[f * 3],
      b = tri[f * 3 + 1],
      c = tri[f * 3 + 2];
    const gbx = ed.grad[f * 6],
      gby = ed.grad[f * 6 + 1],
      gbz = ed.grad[f * 6 + 2];
    const gcx = ed.grad[f * 6 + 3],
      gcy = ed.grad[f * 6 + 4],
      gcz = ed.grad[f * 6 + 5];
    const gax = -gbx - gcx,
      gay = -gby - gcy,
      gaz = -gbz - gcz;
    const gradPx = gax * pressure[a] + gbx * pressure[b] + gcx * pressure[c];
    const gradPy = gay * pressure[a] + gby * pressure[b] + gcy * pressure[c];
    const gradPz = gaz * pressure[a] + gbz * pressure[b] + gcz * pressure[c];
    const gradLen = Math.sqrt(gradPx * gradPx + gradPy * gradPy + gradPz * gradPz); // Pa/mm
    const hM = ((h[a] + h[b] + h[c]) / 3) * 1e-3; // mm → m
    const etaF = (etaNode[a] + etaNode[b] + etaNode[c]) / 3;
    // Hele-Shaw 面内平均速度（m/s）：v = h²/(12η)·|∇p|，∇p 由 Pa/mm 换算为 Pa/m（×1000）
    const speed = ((hM * hM) / (12 * Math.max(etaF, 1e-6))) * gradLen * 1000;
    const sr = shearRateHeleShaw(speed, hM); // 1/s（h 与 v 同为 SI）
    onShear(sr);
    const eta = materialViscosity(material, sr, tempK);
    acc[a] += eta;
    acc[b] += eta;
    acc[c] += eta;
    cnt[a]++;
    cnt[b]++;
    cnt[c]++;
  }
  for (let i = 0; i < mesh.nodeCount; i++) {
    if (cnt[i] > 0) etaNode[i] = acc[i] / cnt[i];
  }
}

function buildNeighbors(mesh: TriangleMesh): number[][] {
  const N = mesh.nodeCount;
  const sets: Set<number>[] = Array.from({ length: N }, () => new Set());
  const tri = mesh.triangles;
  for (let f = 0; f < tri.length; f += 3) {
    const a = tri[f],
      b = tri[f + 1],
      c = tri[f + 2];
    sets[a].add(b);
    sets[a].add(c);
    sets[b].add(a);
    sets[b].add(c);
    sets[c].add(a);
    sets[c].add(b);
  }
  return sets.map((s) => [...s].sort((a, b) => a - b));
}

/**
 * 困气识别：当前未充填且入流 ≤ 0 的节点，若其所有未充填邻节点也无来流，
 * 形成封闭死区（从边界不可达流动前沿），判定为困气点。
 */
function scanAirTraps(mesh: TriangleMesh, fill: Float64Array, flux: Float64Array, neighbors: number[][]): number[] {
  const N = mesh.nodeCount;
  // 从“仍有正向来流的未充填前沿节点”做 BFS，能到达的未充填节点都还有机会被充填
  const reachable = new Uint8Array(N);
  const queue: number[] = [];
  for (let i = 0; i < N; i++) {
    if (fill[i] < 1 - FILL_EPS && flux[i] > FILL_EPS) {
      reachable[i] = 1;
      queue.push(i);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const j of neighbors[cur]) {
      if (fill[j] < 1 - FILL_EPS && !reachable[j]) {
        reachable[j] = 1;
        queue.push(j);
      }
    }
  }
  const traps: number[] = [];
  for (let i = 0; i < N; i++) {
    if (fill[i] < 1 - FILL_EPS && !reachable[i]) traps.push(i);
  }
  return traps;
}

/** 锁模力用投影面积：取包围盒主轴方向上最大投影面积（mm²） */
function computeProjectedArea(mesh: TriangleMesh): number {
  const p = mesh.positions;
  const tri = mesh.triangles;
  let aXY = 0,
    aXZ = 0,
    aYZ = 0;
  for (let f = 0; f < tri.length; f += 3) {
    const i0 = tri[f] * 3,
      i1 = tri[f + 1] * 3,
      i2 = tri[f + 2] * 3;
    const ux = p[i1] - p[i0],
      uy = p[i1 + 1] - p[i0 + 1],
      uz = p[i1 + 2] - p[i0 + 2];
    const vx = p[i2] - p[i0],
      vy = p[i2 + 1] - p[i0 + 1],
      vz = p[i2 + 2] - p[i0 + 2];
    aXY += Math.abs(ux * vy - uy * vx) / 2;
    aXZ += Math.abs(ux * vz - uz * vx) / 2;
    aYZ += Math.abs(uy * vz - uz * vy) / 2;
  }
  return Math.max(aXY, aXZ, aYZ);
}

export function checkSolverPrerequisites(mesh: TriangleMesh | null, check: MeshCheckResult | null, gates: Gate[]): string | null {
  if (!mesh) return '方案尚未生成网格，请先导入或选择模型并剖分网格';
  if (!check) return '网格尚未完成质量检查';
  if (!check.ok) return '网格存在严重错误（非流形边/退化面），请修复后再仿真';
  if (gates.length === 0) return '请至少设置一个浇口';
  return null;
}
