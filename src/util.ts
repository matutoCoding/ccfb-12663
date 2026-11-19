// 通用工具:确定性哈希、格式化、下载等

/** FNV-1a 64 位哈希(确定性,用于参数缓存键) */
export function fnv1a(str: string): string {
  let h1 = 0xcbf29ce4 >>> 0, h2 = 0x84222325 >>> 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ (c & 0xff), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c >> 8), 0x01000193) >>> 0;
    h1 = (h1 + h2) >>> 0;
    h2 = (h2 + h1) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** 数值稳定序列化:保留足够精度且与键序无关 */
export function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    if (typeof obj === 'number') return Number(obj.toPrecision(12)).toString();
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const o = obj as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

export function paramHash(obj: unknown): string {
  return fnv1a(stableStringify(obj));
}

let uidCounter = 0;
export function uid(prefix = ''): string {
  uidCounter = (uidCounter + 1) % 46656;
  return prefix + Date.now().toString(36) + uidCounter.toString(36).padStart(3, '0') +
    Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
}

export function fmt(n: number, digits = 2): string {
  if (!isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtTime(s: number): string {
  if (s < 1) return (s * 1000).toFixed(0) + ' ms';
  if (s < 60) return s.toFixed(2) + ' s';
  return Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s';
}

export function download(fileName: string, content: string | Blob, mime = 'application/octet-stream'): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v as unknown as EventListener);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

export function base64Encode(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function base64Decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
