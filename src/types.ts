// 全局共享类型定义

export interface Vec3 { x: number; y: number; z: number }

/** 三角网格(中面模型,单位 mm) */
export interface MeshData {
  positions: Float32Array; // 3 * 节点数
  triangles: Uint32Array;  // 3 * 单元数
}

export interface MeshCheckResult {
  nodeCount: number;
  triCount: number;
  boundaryEdgeCount: number;   // 只被一个三角形引用的边(破面/开口)
  nonManifoldEdgeCount: number; // 被 3 个及以上三角形引用的边
  boundaryLoops: number;        // 边界环数量(外轮廓 + 内孔)
  degenerateCount: number;      // 退化(零面积)三角形
  ok: boolean;
  messages: string[];
}

export type ModelSource =
  | { kind: 'builtin'; builtinId: string }
  | { kind: 'stl'; fileName: string; stlText: string }; // stlText: base64 编码的原始文件

export interface Gate {
  id: string;
  nodeIndex: number;     // 网格节点索引
  position: Vec3;        // 冗余存一份坐标,便于显示
  openTime: number;      // 开启时间 s
}

/** Cross-WLF 粘度模型 + 热物性参数 */
export interface Material {
  id: string;
  name: string;
  n: number;        // 幂律指数
  tauStar: number;  // 过渡剪切应力 Pa
  d1: number;       // WLF D1 Pa·s
  d2: number;       // WLF D2 K(玻璃化温度)
  d3: number;       // WLF D3 K/Pa(常压下为 0)
  a1: number;       // WLF A1
  a2: number;       // WLF A2 K
  thermalConductivity: number; // 导热系数 W/(m·K)
  specificHeat: number;        // 比热 J/(kg·K)
  density: number;             // 密度 kg/m³
  noFlowTemp: number;          // 固化(不流动)温度 ℃
  defaultMeltTemp: number;     // 默认熔体温度 ℃
  defaultMoldTemp: number;     // 默认模具温度 ℃
  builtin?: boolean;
}

export interface ProcessParams {
  meltTemp: number;    // ℃
  moldTemp: number;    // ℃
  flowRate: number;    // 总注射速率 cm³/s
  pressureLimit: number; // 注射压力上限 MPa(超过则报警)
  thickness: number;   // 壁厚 mm
}

export interface Scheme {
  id: string;
  projectId: string;
  name: string;
  model: ModelSource;
  meshLevel: number;   // 细分级别 0..3
  gates: Gate[];
  materialId: string;
  process: ProcessParams;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export type TaskStatus = 'queued' | 'meshing' | 'running' | 'done' | 'failed' | 'canceled';

export interface SimTask {
  id: string;
  schemeId: string;
  projectId: string;
  schemeName: string;
  paramHash: string;    // 输入参数哈希,用于结果缓存
  status: TaskStatus;
  progress: number;     // 0..1
  etaSeconds: number | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WeldLine {
  id: string;
  position: Vec3;      // 质心,用于视角定位
  nodeIndices: number[];
  length: number;      // 近似长度 mm
}

export interface AirTrap {
  id: string;
  position: Vec3;
  nodeIndices: number[];
}

export interface SimResult {
  paramHash: string;
  nodeCount: number;
  triCount: number;
  fillTime: Float32Array;   // 每节点充填时间 s
  pressure: Float32Array;   // 每节点末端压力 MPa(近似)
  totalFillTime: number;    // s
  maxInjectionPressure: number; // MPa
  clampForce: number;       // kN
  weldLines: WeldLine[];
  airTraps: AirTrap[];
  // 动画帧:等间隔时间戳(前端用 fillTime 阈值回放,无需逐帧存场量)
  frameTimes: number[];
  meshPositions: Float32Array; // 计算用网格(细分后),随结果缓存
  meshTriangles: Uint32Array;
  gateNodes: number[];
  computedAt: number;
  durationMs: number;
}

export interface Settings {
  meshLevel: number;          // 默认网格细分级别
  lengthUnit: 'mm' | 'inch';
  pressureUnit: 'MPa' | 'bar';
  compareThresholdPct: number; // 对比差异阈值 %
  animSpeed: number;           // 动画默认倍速
  maxElements: number;         // 网格规模上限
}

export const DEFAULT_SETTINGS: Settings = {
  meshLevel: 1,
  lengthUnit: 'mm',
  pressureUnit: 'MPa',
  compareThresholdPct: 10,
  animSpeed: 1,
  maxElements: 100000,
};
