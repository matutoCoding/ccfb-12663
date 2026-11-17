// 全局领域模型与类型定义

export type ID = string;

/** 三角网格（全部使用定长 TypedArray，便于结构化克隆与 IndexedDB 存储） */
export interface TriangleMesh {
  positions: Float32Array; // 节点坐标，长度 nodeCount*3，单位 mm
  triangles: Uint32Array; // 三角面顶点索引，长度 triangleCount*3
  /** 每个节点对应的壁厚 h（mm），长度 nodeCount；Hele-Shaw 流动厚度 */
  thickness: Float32Array;
  nodeCount: number;
  triangleCount: number;
}

export type MeshIssueLevel = 'error' | 'warning' | 'info';

export interface MeshIssue {
  level: MeshIssueLevel;
  kind: 'non-manifold' | 'hole' | 'degenerate' | 'duplicate-face' | 'isolated' | 'info';
  message: string;
  /** 涉及的节点或三角面索引，用于视图定位 */
  nodeIndices?: number[];
  triangleIndices?: number[];
}

export interface MeshCheckResult {
  ok: boolean;
  edgeCount: number;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  degenerateCount: number;
  duplicateFaceCount: number;
  isolatedNodeCount: number;
  issues: MeshIssue[];
}

export interface MeshParams {
  /** 目标平均边长（mm），用于细化/粗化 */
  targetEdgeLength: number;
  /** 细化迭代上限，保证确定性与耗时可控 */
  maxRefineIterations: number;
  /** 粗化迭代上限 */
  maxCoarsenIterations: number;
}

export interface Gate {
  id: ID;
  name: string;
  /** 吸附到的网格节点 */
  nodeIndex: number;
  /** 拾取位置（模型坐标 mm），节点吸附前的原始点 */
  pickX: number;
  pickY: number;
  pickZ: number;
  /** 开启延迟时间 s（该时刻之前浇口关闭） */
  openTime: number;
  /** 各浇口流量分配权重（默认 1，按权重比例分配总流量） */
  weight: number;
}

export interface ProcessParams {
  /** 总体积流量 mm^3/s（多浇口按权重分配） */
  flowRate: number;
  /** 熔体温度 ℃（粘度模型参考温度） */
  meltTemperature: number;
  /** 模具温度 ℃ */
  moldTemperature: number;
  /** 最大允许注射压力 MPa，超出则任务失败并给出原因 */
  maxInjectionPressure: number;
  /** 仿真时间步长上限 s（实际步长自适应，取 min） */
  maxTimeStep: number;
}

/** 粘度模型：Cross-WLF（主流注塑 CAE 标配）+ 简化 Carreau 备选 */
export interface Material {
  id: ID;
  name: string;
  vendor?: string;
  /** 聚合物类别，如 ABS / PP / PC */
  category: string;
  viscosityModel: 'cross-wlf' | 'carreau';
  /** 零剪切粘度 η0（Pa·s，参考温度下） */
  zeroShearViscosity: number;
  /** Cross 模型常数 n（幂律指数） */
  crossN: number;
  /** Cross 模型常数 τ*（Pa） */
  crossTauStar: number;
  /** WLF 常数 C1 / C2（参考温度取熔体温度） */
  wlfC1: number;
  wlfC2: number;
  /** WLF 参考温度 K */
  wlfTRef: number;
  /** Carreau 模型参数（viscosityModel=carreau 时使用） */
  carreauLambda: number;
  carreauN: number;
  /** 导热系数 W/(m·K) */
  thermalConductivity: number;
  /** 比热容 J/(kg·K) */
  specificHeat: number;
  /** 密度 kg/m^3（固体） */
  density: number;
  /** 固化温度 ℃（低于此温度视为凝固，充填阶段用于报告提示） */
  solidificationTemperature: number;
  /** 加工温度下限/上限 ℃ */
  processTempLow: number;
  processTempHigh: number;
  builtin?: boolean;
}

export interface Scheme {
  id: ID;
  projectId: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 几何来源：内置模型或导入文件 */
  geometrySource:
    | { kind: 'builtin'; modelId: 'phone-case' | 'cover-plate' }
    | { kind: 'import'; fileName: string; importedAt: number };
  /** 已检查并网格化的网格数据；未生成时为 null */
  mesh: TriangleMesh | null;
  meshParams: MeshParams;
  meshCheck: MeshCheckResult | null;
  gates: Gate[];
  process: ProcessParams;
  materialId: ID;
  /** 方案级壁厚覆盖（mm），>0 时统一覆盖网格节点厚度 */
  uniformThickness: number;
}

export interface Project {
  id: ID;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  schemeIds: ID[];
}

export interface WeldLine {
  id: ID;
  nodeIndex: number;
  x: number;
  y: number;
  z: number;
  /** 相遇的两股前沿来源浇口 id */
  sourceA: ID;
  sourceB: ID;
  fillTime: number;
}

export interface AirTrap {
  id: ID;
  nodeIndex: number;
  x: number;
  y: number;
  z: number;
  fillTime: number;
}

export interface SimMetrics {
  fillTime: number;
  maxPressure: number; // MPa
  maxClampForce: number; // kN
  filledVolume: number; // mm^3
  totalVolume: number; // mm^3
  shortShot: boolean;
  avgShearRate: number; // 1/s
}

export interface SimResult {
  id: ID;
  cacheKey: string;
  schemeId: ID;
  materialId: ID;
  createdAt: number;
  /** 节点充填时间场 s，未充填节点为 Infinity（序列化为 -1） */
  fillTimes: Float64Array;
  /** 节点压力峰值场 MPa */
  peakPressures: Float64Array;
  /** 每个节点最终充填来源浇口 id（未充填为空串） */
  sourceGateIds: string[];
  metrics: SimMetrics;
  weldLines: WeldLine[];
  airTraps: AirTrap[];
  /** 仿真参数摘要，供报告展示 */
  paramSummary: Record<string, number | string>;
  /** 求解器实际使用的时间步数与 CG 迭代总数（性能/质量诊断） */
  stepCount: number;
  cgIterationCount: number;
}

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'canceled';

export interface SimTask {
  id: ID;
  schemeId: ID;
  cacheKey: string;
  status: TaskStatus;
  progress: number; // 0..1
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 进度估算用：已耗时 ms 与进度，推算剩余时间 */
  elapsedMs: number;
  estimatedRemainingMs: number;
  resultId: ID | null;
  errorMessage: string | null;
}

export type UnitSystem = 'mm-t-s-MPa' | 'mm-g-s' | 'm-kg-s';

export interface AppSettings {
  defaultMeshTargetEdge: number;
  defaultUnit: UnitSystem;
  /** 方案对比指标差异告警阈值（相对百分比） */
  compareThresholdPercent: number;
  /** 结果缓存上限（条），超出按最久未访问淘汰 */
  cacheLimit: number;
  /** 动画默认播放倍速档位 */
  defaultPlaybackSpeed: number;
  /** 撤销栈深度 */
  undoDepth: number;
}

/** 打包导出文件结构（.imsim.json） */
export interface ExportPackage {
  format: 'imsim-package';
  version: 1;
  exportedAt: number;
  project: Project;
  schemes: Scheme[];
  materials: Material[];
  results: SerializedResult[];
}

/** 可 JSON 序列化的结果（TypedArray → 普通数组） */
export type SerializedResult = Omit<SimResult, 'fillTimes' | 'peakPressures'> & {
  fillTimes: number[];
  peakPressures: number[];
};
