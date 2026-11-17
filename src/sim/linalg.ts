// 对称稀疏矩阵（CSR 格式）与投影共轭梯度求解器
// 所有数组按固定规则构建/遍历，浮点求和顺序确定 → 同输入同输出

/**
 * 以 (i,j,value) 三元组构建对称 CSR。
 * 调用方对每个无向对只写一次上三角即可，内部自动补对称项。
 */
export class SymSparseMatrix {
  n: number;
  rowPtr: Uint32Array;
  colIdx: Uint32Array;
  values: Float64Array;

  private constructor(n: number, rowPtr: Uint32Array, colIdx: Uint32Array, values: Float64Array) {
    this.n = n;
    this.rowPtr = rowPtr;
    this.colIdx = colIdx;
    this.values = values;
  }

  static fromTriplets(n: number, rows: number[], cols: number[], vals: number[]): SymSparseMatrix {
    // 按行、再按列排序收集；重复位置求和
    const entries = new Map<number, Map<number, number>>();
    const add = (i: number, j: number, v: number) => {
      let row = entries.get(i);
      if (!row) entries.set(i, (row = new Map()));
      row.set(j, (row.get(j) ?? 0) + v);
    };
    for (let k = 0; k < vals.length; k++) {
      const i = rows[k],
        j = cols[k],
        v = vals[k];
      add(i, j, v);
      if (i !== j) add(j, i, v);
    }
    const rowPtr = new Uint32Array(n + 1);
    let nnz = 0;
    for (let i = 0; i < n; i++) {
      rowPtr[i] = nnz;
      const row = entries.get(i);
      if (row) nnz += row.size;
    }
    rowPtr[n] = nnz;
    const colIdx = new Uint32Array(nnz);
    const values = new Float64Array(nnz);
    for (let i = 0; i < n; i++) {
      const row = entries.get(i);
      if (!row) continue;
      const keys = [...row.keys()].sort((a, b) => a - b);
      let p = rowPtr[i];
      for (const j of keys) {
        colIdx[p] = j;
        values[p] = row.get(j)!;
        p++;
      }
    }
    return new SymSparseMatrix(n, rowPtr, colIdx, values);
  }

  /** y = A·x（全矩阵乘法；Dirichlet 节点通过投影 CG 处理，无需拆矩阵） */
  multiply(x: Float64Array, y: Float64Array): void {
    const { n, rowPtr, colIdx, values } = this;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) {
        sum += values[p] * x[colIdx[p]];
      }
      y[i] = sum;
    }
  }

  /**
   * 返回对称对角缩放后的新矩阵 Ã = DAD（D 对角，D_ii=1/sqrt(|K_ii|)），
   * 以及缩放向量 d。调用方解 Ã·x̃ = d∘b 后用 x = d∘x̃ 还原。
   * 缩放把对角元归一到 1，显著降低条件数且不改变收敛解。
   */
  diagonallyScaled(): { matrix: SymSparseMatrix; scale: Float64Array } {
    const n = this.n;
    const scale = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = this.diag(i);
      scale[i] = d > 0 ? 1 / Math.sqrt(d) : 1;
    }
    const values = new Float64Array(this.values.length);
    for (let i = 0; i < n; i++) {
      for (let p = this.rowPtr[i]; p < this.rowPtr[i + 1]; p++) {
        const j = this.colIdx[p];
        values[p] = this.values[p] * scale[i] * scale[j];
      }
    }
    return { matrix: new SymSparseMatrix(n, this.rowPtr, this.colIdx, values), scale };
  }

  /** 对角线取值（用于诊断） */
  diag(i: number): number {
    for (let p = this.rowPtr[i]; p < this.rowPtr[i + 1]; p++) {
      if (this.colIdx[p] === i) return this.values[p];
    }
    return 0;
  }

  /**
   * 构造不可压流动求解系统：所有浇口节点接地（p=0 压力基准），
   * 对角线置 1、该行/列耦合清零；自由节点保留原 K 行，右端项由调用方填注入流量。
   * 解出的自由节点压力为负（低于浇口），调用方平移后得到绝对压力口径。
   */
  buildFlowSystem(pinnedNodes: number[]): { matrix: SymSparseMatrix; rhs: Float64Array } {
    const pinned = new Uint8Array(this.n);
    for (const s of pinnedNodes) pinned[s] = 1;
    const values = new Float64Array(this.values);
    const rhs = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      if (pinned[i]) {
        for (let p = this.rowPtr[i]; p < this.rowPtr[i + 1]; p++) {
          if (this.colIdx[p] === i) values[p] = 1;
          else values[p] = 0;
        }
        rhs[i] = 0;
      } else {
        for (let p = this.rowPtr[i]; p < this.rowPtr[i + 1]; p++) {
          if (pinned[this.colIdx[p]]) values[p] = 0;
        }
      }
    }
    return { matrix: new SymSparseMatrix(this.n, this.rowPtr, this.colIdx, values), rhs };
  }
}

export interface CGOptions {
  maxIterations: number;
  tolerance: number; // 残差相对容差
  /** 固定值节点（Dirichlet），其解被投影为 fixedValue */
  fixedNodes?: number[];
  fixedValue?: number;
  onIteration?: (iter: number, residualNorm: number) => void;
}

export interface CGResult {
  x: Float64Array;
  iterations: number;
  residual: number;
  converged: boolean;
}

/**
 * 投影共轭梯度：每轮迭代后把 fixedNodes 上的搜索方向/残差清零，
 * 数学等价于消去约束自由度，但避免矩阵重排，确定性与可复现性更好。
 */
export function conjugateGradient(A: SymSparseMatrix, b: Float64Array, x0: Float64Array, opts: CGOptions): CGResult {
  const n = A.n;
  const x = Float64Array.from(x0);
  const r = new Float64Array(n);
  const p = new Float64Array(n);
  const Ap = new Float64Array(n);

  const fixed = opts.fixedNodes;
  const fixedValue = opts.fixedValue ?? 0;
  const isFixed = fixed && fixed.length > 0 ? new Uint8Array(n) : null;
  if (isFixed && fixed) for (const f of fixed) isFixed[f] = 1;
  if (isFixed) for (const f of fixed!) x[f] = fixedValue;

  A.multiply(x, Ap);
  for (let i = 0; i < n; i++) r[i] = b[i] - Ap[i];
  if (isFixed) for (let i = 0; i < n; i++) if (isFixed[i]) r[i] = 0;
  p.set(r);

  let bNorm = 0;
  for (let i = 0; i < n; i++) bNorm += b[i] * b[i];
  bNorm = Math.sqrt(bNorm);
  if (bNorm === 0) bNorm = 1;

  let rDot = 0;
  for (let i = 0; i < n; i++) rDot += r[i] * r[i];
  // 相对容差 + 绝对容差双门槛：避免量纲悬殊时在舍入误差附近空转
  const tolSq = Math.max((opts.tolerance * bNorm) ** 2, 1e-14);
  let iter = 0;

  if (rDot <= tolSq) {
    return { x, iterations: 0, residual: Math.sqrt(rDot) / bNorm, converged: true };
  }

  // 标准共轭梯度（对称正定矩阵保证有限步收敛；对角缩放后条件数已改善）
  let minResidualSq = rDot;
  for (iter = 1; iter <= opts.maxIterations; iter++) {
    A.multiply(p, Ap);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * Ap[i];
    if (pAp <= 0 || !Number.isFinite(pAp)) {
      return { x, iterations: iter, residual: Math.sqrt(minResidualSq) / bNorm, converged: false };
    }
    const alpha = rDot / pAp;
    for (let i = 0; i < n; i++) x[i] += alpha * p[i];
    for (let i = 0; i < n; i++) r[i] -= alpha * Ap[i];
    if (isFixed) for (let i = 0; i < n; i++) if (isFixed[i]) r[i] = 0;

    let newRDot = 0;
    for (let i = 0; i < n; i++) newRDot += r[i] * r[i];
    if (newRDot < minResidualSq) minResidualSq = newRDot;
    opts.onIteration?.(iter, Math.sqrt(newRDot) / bNorm);
    if (newRDot <= tolSq) {
      return { x, iterations: iter, residual: Math.sqrt(newRDot) / bNorm, converged: true };
    }
    const beta = newRDot / rDot;
    for (let i = 0; i < n; i++) p[i] = r[i] + beta * p[i];
    if (isFixed) for (let i = 0; i < n; i++) if (isFixed[i]) p[i] = 0;
    rDot = newRDot;
  }
  return { x, iterations: iter - 1, residual: Math.sqrt(minResidualSq) / bNorm, converged: false };
}
