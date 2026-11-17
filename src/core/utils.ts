// 通用工具：ID、哈希、数值、断言

export function uid(prefix = 'id'): string {
  // 时间戳 + 计数器 + 随机后缀；同毫秒内也不碰撞
  uidCounter++;
  const rand = Math.floor(Math.random() * 0xffffff).toString(16);
  return `${prefix}_${Date.now().toString(36)}_${uidCounter.toString(36)}_${rand}`;
}
let uidCounter = 0;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 确定性 JSON 字符串化：对象键按字典序排序，保证缓存键稳定 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const arr = ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : (value as unknown[]);
    return `[${arr.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * FNV-1a 64 位哈希（BigInt 实现，跨浏览器/Node 结果一致），
 * 用于仿真参数缓存键。字符串按 UTF-8 编码逐字节处理。
 */
export function fnv1a64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const MASK = (1n << 64n) - 1n;
  const PRIME = 0x100000001b3n;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

export function formatNumber(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e6 || abs < 1e-4) return v.toExponential(digits);
  return v.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${Math.round(s % 60)} 秒`;
}

export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** 深拷贝（结构化克隆，IndexedDB 数据天然支持；Node 17+ 同样可用） */
export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function now(): number {
  return Date.now();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
