// Hele-Shaw 充填求解器(控制体积法,三角中面网格)
// 确定性保证:全部按固定索引顺序迭代,不使用随机数与系统时间,
// 同一输入在同一引擎下逐位一致。
import { Material, ProcessParams, SimResult, WeldLine, AirTrap } from './types.js';
import { paramHash } from './util.js';

export interface SolverInput {
  positions: Float32Array; // mm
  triangles: Uint32Array;
  gateNodes: number[];     // 与 gateOpenTime 一一对应
  gateOpenTime: number[];  // s
  material: Material;
  process: ProcessParams;
  onProgress?: (filled: number, total: number) => void;
}

interface Edge { j: number; k: number } // k: 传导系数(不含粘度) m³

const MAX_SOLVES = 160;      // 压力场重解次数上限
const CG_TOL = 1e-4;
const CG_MAX_ITER = 300;

export function runSimulation(input: SolverInput): SimResult {
  const t0 = nowMs();
  const { positions, triangles, gateNodes, gateOpenTime, material, process } = input;
  const N = positions.length / 3;
  const T = triangles.length / 3;
  if (gateNodes.length === 0) throw new Error('未设置浇口');
  for (const g of gateNodes) {
    if (g < 0 || g >= N) throw new Error('浇口节点索引超出网格范围,请重新点选浇口');
  }

  // ---- 单位:内部统一 SI(m, Pa, s, kg) ----
  const px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    px[i] = positions[i * 3] / 1000;
    py[i] = positions[i * 3 + 1] / 1000;
    pz[i] = positions[i * 3 + 2] / 1000;
  }
  const h = process.thickness / 1000; // 壁厚 m

  // ---- 控制体积与边通道 ----
  const cvVol = new Float64Array(N);   // 控制体积 m³
  const cvArea = new Float64Array(N);  // 中面面积 m²
  const adj: Edge[][] = new Array(N);
  for (let i = 0; i < N; i++) adj[i] = [];
  const edgeMap = new Map<number, number>(); // key -> 传导累加

  const addEdge = (i: number, j: number, conduct: number) => {
    const key = i < j ? i * N + j : j * N + i;
    const prev = edgeMap.get(key);
    edgeMap.set(key, (prev ?? 0) + conduct);
  };

  for (let t = 0; t < T; t++) {
    const a = triangles[t * 3], b = triangles[t * 3 + 1], c = triangles[t * 3 + 2];
    const ax = px[a], ay = py[a], az = pz[a];
    const ux = px[b] - ax, uy = py[b] - ay, uz = pz[b] - az;
    const vx = px[c] - ax, vy = py[c] - ay, vz = pz[c] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (area < 1e-18) continue;
    const share = area / 3;
    cvArea[a] += share; cvArea[b] += share; cvArea[c] += share;
    const vol = share * h;
    cvVol[a] += vol; cvVol[b] += vol; cvVol[c] += vol;
    // 每条边:通道传导 = w * h³ / (12 L),w ≈ (2/3)·A_tri/L(该三角形分摊 1/2)
    const edgeLen = (i: number, j: number) =>
      Math.sqrt((px[i] - px[j]) ** 2 + (py[i] - py[j]) ** 2 + (pz[i] - pz[j]) ** 2);
    const pairs: [number, number][] = [[a, b], [b, c], [c, a]];
    for (const [i, j] of pairs) {
      const L = edgeLen(i, j);
      if (L < 1e-12) continue;
      const w = (2 / 3) * area / L; // 近似通道宽度
      const conduct = (w * h * h * h) / (12 * L) / 2; // 每个三角形贡献一半
      addEdge(i, j, conduct);
    }
  }

  // 邻接表(带基础传导系数 G0,实际 k = G0 / μ)
  for (const [key, g] of edgeMap) {
    const i = Math.floor(key / N), j = key % N;
    adj[i].push({ j, k: g });
    adj[j].push({ j: i, k: g });
  }
  // 排序保证确定性
  for (let i = 0; i < N; i++) adj[i].sort((x, y) => x.j - y.j);

  // CSR 结构(矩阵向量乘走连续数组,远快于对象邻接表)
  let nnz = 0;
  for (let i = 0; i < N; i++) nnz += adj[i].length;
  const csrRow = new Int32Array(N + 1);
  const csrCol = new Int32Array(nnz);
  const csrVal = new Float64Array(nnz);
  {
    let p = 0;
    for (let i = 0; i < N; i++) {
      csrRow[i] = p;
      for (const e of adj[i]) { csrCol[p] = e.j; csrVal[p] = e.k; p++; }
    }
    csrRow[N] = p;
  }

  // ---- 粘度(Cross-WLF,等温近似) ----
  const Tm = process.meltTemp + 273.15; // K
  const dT = Tm - (material.d2 + material.d3 * 0);
  let mu0: number;
  if (dT <= 0 || process.meltTemp <= material.noFlowTemp) {
    mu0 = 1e12; // 不流动
  } else {
    mu0 = material.d1 * Math.exp((-material.a1 * dT) / (material.a2 + dT));
  }
  const tauStar = material.tauStar, nIdx = material.n;
  const viscosity = (shear: number): number => {
    const x = (mu0 * shear) / tauStar;
    return mu0 / (1 + Math.pow(x, 1 - nIdx));
  };

  // ---- 充填状态 ----
  const frac = new Float64Array(N);      // 充填比例
  const fillTime = new Float64Array(N).fill(-1);
  const state = new Uint8Array(N);       // 0 空 1 前沿 2 已充满
  const inflowDir = new Float64Array(N * 3); // 充满时的来流方向
  const gateSet = new Int32Array(N).fill(-1);
  gateNodes.forEach((g, gi) => { gateSet[g] = gi; });

  // 前沿节点动态列表(避免每步扫描全部节点)
  const frontList: number[] = [];
  const posInFront = new Int32Array(N).fill(-1);
  const addToFront = (j: number): void => {
    if (posInFront[j] < 0) { posInFront[j] = frontList.length; frontList.push(j); }
  };
  const removeFromFront = (j: number): void => {
    const idx = posInFront[j];
    if (idx < 0) return;
    const last = frontList.pop()!;
    if (last !== j) { frontList[idx] = last; posInFront[last] = idx; }
    posInFront[j] = -1;
  };

  let time = 0;
  // 初始:开启时间为 0 的浇口直接充满;其余等到 openTime
  const totalVol = cvVol.reduce((s, v) => s + v, 0);
  const Qtotal = process.flowRate * 1e-6; // cm³/s -> m³/s

  const openGates = new Set<number>();
  const activateGate = (gi: number) => {
    const g = gateNodes[gi];
    openGates.add(gi);
    if (state[g] === 0) {
      state[g] = 2; frac[g] = 1; fillTime[g] = time;
      // 邻点变前沿
      for (const e of adj[g]) {
        if (state[e.j] === 0) { state[e.j] = 1; addToFront(e.j); }
      }
    }
  };
  gateOpenTime.forEach((ot, gi) => { if (ot <= 0) activateGate(gi); });

  let filledCount = 0;
  for (let i = 0; i < N; i++) if (state[i] === 2) filledCount++;

  // 当前压力场(已充满节点),用于推进
  const pressure = new Float64Array(N);

  // 计算每开启浇口流量(均分)
  const gateFlow = () => (openGates.size > 0 ? Qtotal / openGates.size : 0);

  // ---- 压力求解(活动节点子集上的 CG),滞后标量粘度存外层 ----
  // 复用缓冲区,避免每次求解重新分配
  const activeIdx = new Int32Array(N);
  const map = new Int32Array(N);
  const rowSum = new Float64Array(N); // 每行传导系数和(不含粘度)
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let p = csrRow[i]; p < csrRow[i + 1]; p++) s += csrVal[p];
    rowSum[i] = s;
  }
  const diag = new Float64Array(N);
  const rhs = new Float64Array(N);
  const cx = new Float64Array(N);
  const cr = new Float64Array(N);
  const cz = new Float64Array(N);
  const cp = new Float64Array(N);
  const cAp = new Float64Array(N);
  // 每次求解压实成本地 CSR(顺序访问,避免 map 间接寻址的缓存未命中)
  const lRow = new Int32Array(N + 1);
  const lCol = new Int32Array(nnz);
  const lVal = new Float64Array(nnz);
  let lastMu = viscosity(1);
  const VISC_ITERS = 2; // 粘度定点迭代次数(固定,保证确定性)
  const solveOnce = (): number => { // 返回当前最大剪切率
    // 活动节点:已充满节点;前沿节点压力 = 0(Dirichlet)
    let M = 0;
    map.fill(-1);
    for (let i = 0; i < N; i++) {
      if (state[i] === 2) { map[i] = M; activeIdx[M] = i; M++; }
    }
    if (M === 0) return 1;
    // 装配对角、右端项与本地 CSR
    const invMu = 1 / lastMu;
    const qGate = gateFlow();
    let lnnz = 0;
    for (let r = 0; r < M; r++) {
      const i = activeIdx[r];
      diag[r] = rowSum[i] * invMu;
      rhs[r] = (gateSet[i] >= 0 && openGates.has(gateSet[i])) ? qGate : 0;
      cx[r] = pressure[i]; // 热启动
      lRow[r] = lnnz;
      for (let p = csrRow[i]; p < csrRow[i + 1]; p++) {
        const c = map[csrCol[p]];
        if (c >= 0) { lCol[lnnz] = c; lVal[lnnz] = csrVal[p]; lnnz++; }
      }
    }
    lRow[M] = lnnz;
    // 矩阵向量乘:y = A x(本地 CSR,顺序访问)
    const matvec = (x: Float64Array, y: Float64Array): void => {
      for (let r = 0; r < M; r++) {
        let s = diag[r] * x[r];
        for (let p = lRow[r]; p < lRow[r + 1]; p++) {
          s -= invMu * lVal[p] * x[lCol[p]];
        }
        y[r] = s;
      }
    };
    // Jacobi 预条件 CG
    const x = cx, r0 = cr, z = cz, p = cp, Ap = cAp;
    matvec(x, Ap);
    let rz = 0, bnorm = 0;
    for (let r = 0; r < M; r++) {
      r0[r] = rhs[r] - Ap[r];
      z[r] = r0[r] / (diag[r] || 1);
      p[r] = z[r];
      rz += r0[r] * z[r];
      bnorm += rhs[r] * rhs[r];
    }
    bnorm = Math.sqrt(bnorm) || 1;
    for (let it = 0; it < CG_MAX_ITER; it++) {
      cgIters++;
      matvec(p, Ap);
      let pAp = 0;
      for (let r = 0; r < M; r++) pAp += p[r] * Ap[r];
      if (pAp === 0) break;
      const alpha = rz / pAp;
      let rr = 0;
      for (let r = 0; r < M; r++) {
        x[r] += alpha * p[r];
        r0[r] -= alpha * Ap[r];
        rr += r0[r] * r0[r];
      }
      if (Math.sqrt(rr) / bnorm < CG_TOL) break;
      let rzNew = 0;
      for (let r = 0; r < M; r++) {
        z[r] = r0[r] / (diag[r] || 1);
        rzNew += r0[r] * z[r];
      }
      const beta = rzNew / rz;
      for (let r = 0; r < M; r++) p[r] = z[r] + beta * p[r];
      rz = rzNew;
    }
    // 写回并估计最大剪切率
    let maxShear = 1;
    for (let r = 0; r < M; r++) {
      const i = activeIdx[r];
      pressure[i] = x[r];
      for (const e of adj[i]) {
        if (state[e.j] !== 2) {
          const q = Math.abs(e.k * invMu * x[r]);
          const shear = (6 * q) / (h * h * 1e-3);
          if (shear > maxShear) maxShear = shear;
        }
      }
    }
    return maxShear;
  };
  const solvePressure = (): void => {
    for (let it = 0; it < VISC_ITERS; it++) {
      const shear = solveOnce();
      const newMu = viscosity(Math.min(1e5, shear));
      // A = L/μ,b 不变 → p ∝ μ。粘度更新后按比例缩放热启动初值,CG 几乎立即收敛
      if (newMu !== lastMu && lastMu > 0) {
        const scale = newMu / lastMu;
        for (let i = 0; i < N; i++) pressure[i] *= scale;
      }
      lastMu = newMu;
    }
  };

  // ---- 主推进循环 ----
  let solves = 0;
  let cgIters = 0;
  let sinceSolve = 0;
  const inflowQ = new Float64Array(N);
  let maxGatePressure = 0; // Pa
  let maxClamp = 0;        // N
  const solveInterval = Math.max(1, Math.floor(N / MAX_SOLVES));

  const computeInflow = (): void => {
    inflowQ.fill(0);
    for (let i = 0; i < N; i++) {
      if (state[i] !== 2) continue;
      const pi = pressure[i];
      if (pi <= 0) continue;
      for (const e of adj[i]) {
        if (state[e.j] === 2) continue;
        inflowQ[e.j] += e.k / currentMu * pi;
      }
    }
  };

  // 压力场只在重解时变化,统计也只在重解时更新
  const updateStats = (): void => {
    let gateP = 0, clamp = 0;
    for (let i = 0; i < N; i++) {
      if (state[i] === 2) {
        clamp += pressure[i] * cvArea[i];
        if (gateSet[i] >= 0 && pressure[i] > gateP) gateP = pressure[i];
      }
    }
    if (gateP > maxGatePressure) maxGatePressure = gateP;
    if (clamp > maxClamp) maxClamp = clamp;
  };

  let currentMu = viscosity(1);
  const reSolve = (): void => {
    solvePressure();
    solves++;
    currentMu = lastMu;
    computeInflow();
    updateStats();
    sinceSolve = 0;
  };
  reSolve();

  const maxSteps = N * 8 + 5000;
  let steps = 0;
  while (filledCount < N && steps < maxSteps) {
    steps++;
    // 到点开启新浇口
    gateOpenTime.forEach((ot, gi) => {
      if (!openGates.has(gi) && time >= ot) {
        activateGate(gi);
        sinceSolve = solveInterval; // 强制重解
      }
    });
    // 找最小 dt(只扫前沿节点)
    let dtMin = Infinity;
    for (let fi = 0; fi < frontList.length; fi++) {
      const j = frontList[fi];
      const q = inflowQ[j];
      if (q <= 0) continue;
      const dt = (cvVol[j] * (1 - frac[j])) / q;
      if (dt < dtMin) dtMin = dt;
    }
    if (!isFinite(dtMin)) {
      // 当前前沿的缓存流量已耗尽:重解压力场刷新流量
      reSolve();
      let hasFlow = false;
      for (let fi = 0; fi < frontList.length; fi++) {
        if (inflowQ[frontList[fi]] > 0) { hasFlow = true; break; }
      }
      if (hasFlow) continue;
      // 没有可推进的前沿:可能有未开启浇口或孤岛
      const nextGate = gateOpenTime.findIndex((ot, gi) => !openGates.has(gi) && ot > time);
      if (nextGate >= 0) {
        time = gateOpenTime[nextGate];
        activateGate(nextGate);
        reSolve();
        continue;
      }
      // 未充满但无流动:短射
      break;
    }
    // 限制单步步长,保证充填时间场平滑
    const dtCap = Math.max(1e-7, totalVol / Qtotal / 1000);
    const dt = Math.min(dtMin, dtCap);
    time += dt;
    // 推进(只扫前沿节点)
    for (let fi = 0; fi < frontList.length; fi++) {
      const j = frontList[fi];
      const q = inflowQ[j];
      if (q <= 0) continue;
      frac[j] += (q * dt) / cvVol[j];
      if (frac[j] >= 1 - 1e-12) {
        frac[j] = 1;
        state[j] = 2;
        fillTime[j] = time;
        filledCount++;
        sinceSolve++;
        // 记录来流方向
        let bestQ = 0, bi = -1;
        for (const e of adj[j]) {
          if (state[e.j] === 2 && pressure[e.j] > 0) {
            const qe = e.k * pressure[e.j];
            if (qe > bestQ) { bestQ = qe; bi = e.j; }
          }
        }
        if (bi >= 0) {
          const dx = px[j] - px[bi], dy = py[j] - py[bi], dz = pz[j] - pz[bi];
          const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          inflowDir[j * 3] = dx / L; inflowDir[j * 3 + 1] = dy / L; inflowDir[j * 3 + 2] = dz / L;
        }
        // 邻点变前沿
        for (const e of adj[j]) {
          if (state[e.j] === 0) { state[e.j] = 1; addToFront(e.j); }
        }
      }
    }
    // 充满的节点移出前沿(在遍历后统一处理,避免遍历时改数组)
    for (let fi = frontList.length - 1; fi >= 0; fi--) {
      if (state[frontList[fi]] === 2) removeFromFront(frontList[fi]);
    }

    if (sinceSolve >= solveInterval && filledCount < N) {
      reSolve();
      input.onProgress?.(filledCount, N);
    }
  }

  if (filledCount < N) {
    const pct = ((filledCount / N) * 100).toFixed(1);
    throw new Error(`短射:型腔未充满(${pct}%)。请提高注射速率、提高熔体温度或检查材料粘度参数`);
  }
  if ((globalThis as { DEBUG_SOLVER?: boolean }).DEBUG_SOLVER) {
    console.log(`debug: N=${N} solves=${solves} cgIters=${cgIters} steps=${steps}`);
  }

  // ---- 后处理:熔接痕 ----
  const weldMark = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    for (const e of adj[i]) {
      const j = e.j;
      if (j <= i) continue;
      const ti = fillTime[i], tj = fillTime[j];
      if (ti < 0 || tj < 0) continue;
      const dt = Math.abs(ti - tj);
      const scale = Math.max(ti, tj, 1e-9);
      if (dt / scale > 0.02) continue; // 几乎同时充满
      // 方向相对
      const dot = inflowDir[i * 3] * inflowDir[j * 3] + inflowDir[i * 3 + 1] * inflowDir[j * 3 + 1] + inflowDir[i * 3 + 2] * inflowDir[j * 3 + 2];
      if (dot < -0.3) { weldMark[i] = 1; weldMark[j] = 1; }
    }
  }
  const weldLines = clusterMarks(weldMark, adj, px, py, pz, 'weld') as WeldLine[];

  // ---- 后处理:困气(局部最后充满点) ----
  const trapMark = new Uint8Array(N);
  const totalFill = time;
  for (let i = 0; i < N; i++) {
    if (gateSet[i] >= 0) continue;
    if (fillTime[i] < totalFill * 0.5) continue; // 只看后半程
    let isMax = true;
    for (const e of adj[i]) {
      if (fillTime[e.j] > fillTime[i] + 1e-12) { isMax = false; break; }
    }
    if (isMax) trapMark[i] = 1;
  }
  const airTraps = clusterMarks(trapMark, adj, px, py, pz, 'trap') as AirTrap[];

  // 末端压力场(MPa)
  const pressureOut = new Float32Array(N);
  for (let i = 0; i < N; i++) pressureOut[i] = pressure[i] / 1e6;

  const frameCount = 60;
  const frameTimes: number[] = [];
  for (let i = 0; i <= frameCount; i++) frameTimes.push((totalFill * i) / frameCount);

  const fillTimeOut = new Float32Array(N);
  for (let i = 0; i < N; i++) fillTimeOut[i] = fillTime[i];

  return {
    paramHash: '',
    nodeCount: N,
    triCount: T,
    fillTime: fillTimeOut,
    pressure: pressureOut,
    totalFillTime: totalFill,
    maxInjectionPressure: maxGatePressure / 1e6,
    clampForce: maxClamp / 1000,
    weldLines,
    airTraps,
    frameTimes,
    meshPositions: positions,
    meshTriangles: triangles,
    gateNodes: [...gateNodes],
    computedAt: 0,
    durationMs: nowMs() - t0,
  };
}

function clusterMarks(
  mark: Uint8Array, adj: { j: number }[][],
  px: Float64Array, py: Float64Array, pz: Float64Array,
  kind: 'weld' | 'trap',
): (WeldLine | AirTrap)[] {
  const N = mark.length;
  const comp = new Int32Array(N).fill(-1);
  let nc = 0;
  for (let s = 0; s < N; s++) {
    if (!mark[s] || comp[s] >= 0) continue;
    // BFS
    const queue = [s];
    comp[s] = nc;
    while (queue.length) {
      const i = queue.pop()!;
      for (const e of adj[i]) {
        if (mark[e.j] && comp[e.j] < 0) {
          comp[e.j] = nc;
          queue.push(e.j);
        }
      }
    }
    nc++;
  }
  const groups: number[][] = Array.from({ length: nc }, () => []);
  for (let i = 0; i < N; i++) if (comp[i] >= 0) groups[comp[i]].push(i);
  const out: (WeldLine | AirTrap)[] = [];
  groups.forEach((nodes, ci) => {
    if (kind === 'weld' && nodes.length < 2) return; // 单点不成线
    let cx = 0, cy = 0, cz = 0;
    for (const i of nodes) { cx += px[i]; cy += py[i]; cz += pz[i]; }
    cx /= nodes.length; cy /= nodes.length; cz /= nodes.length;
    // 近似长度:组内最大跨度
    let maxD = 0;
    for (const i of nodes) {
      const d = Math.sqrt((px[i] - cx) ** 2 + (py[i] - cy) ** 2 + (pz[i] - cz) ** 2);
      if (d > maxD) maxD = d;
    }
    out.push({
      id: kind + '-' + ci,
      position: { x: cx * 1000, y: cy * 1000, z: cz * 1000 },
      nodeIndices: nodes,
      ...(kind === 'weld' ? { length: maxD * 2 * 1000 } : {}),
    } as WeldLine | AirTrap);
  });
  // 排序保证确定性:按质心坐标
  out.sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y || a.position.z - b.position.z);
  return out;
}

/** 计算输入参数哈希(缓存键) */
export function computeParamHash(input: Omit<SolverInput, 'onProgress'>): string {
  return paramHash({
    pos: hashF32(input.positions),
    tri: hashU32(input.triangles),
    gates: input.gateNodes.map((g, i) => [g, input.gateOpenTime[i]]),
    mat: input.material,
    proc: input.process,
  });
}

function hashF32(a: Float32Array): string {
  let s = '';
  for (let i = 0; i < a.length; i++) s += a[i].toPrecision(7) + ',';
  return fnv(s);
}
function hashU32(a: Uint32Array): string {
  let s = '';
  for (let i = 0; i < a.length; i++) s += a[i] + ',';
  return fnv(s);
}
function fnv(str: string): string {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16);
}

// 性能计时只用于展示,不参与计算
const nowMs: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => 0;
