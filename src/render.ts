// WebGL2 渲染器:网格云图、充填动画、点选拾取、标记、视角飞行
import { Vec3 } from './types.js';

const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aFill;   // 充填时间
layout(location=3) in float aPress;  // 压力
uniform mat4 uMVP;
uniform mat4 uModel;
uniform float uTime;     // 当前动画时间
uniform int uMode;       // 0 充填动画 1 压力云图 2 素模
out vec3 vNormal;
out vec3 vPos;
out float vValue;
out float vFilled;
void main(){
  vPos = aPos;
  vNormal = aNormal;
  if(uMode==0){ vValue = aFill; vFilled = (aFill <= uTime && aFill >= 0.0) ? 1.0 : 0.0; }
  else if(uMode==1){ vValue = aPress; vFilled = (aFill <= uTime && aFill >= 0.0) ? 1.0 : 0.0; }
  else { vValue = 0.0; vFilled = 1.0; }
  gl_Position = uMVP * vec4(aPos,1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vPos;
in float vValue;
in float vFilled;
uniform float uMin;
uniform float uMax;
uniform int uMode;
out vec4 fragColor;

vec3 colormap(float t){
  // 蓝-青-绿-黄-红
  t = clamp(t, 0.0, 1.0);
  vec3 c1 = vec3(0.10,0.20,0.85);
  vec3 c2 = vec3(0.10,0.75,0.90);
  vec3 c3 = vec3(0.15,0.80,0.30);
  vec3 c4 = vec3(0.98,0.85,0.15);
  vec3 c5 = vec3(0.90,0.15,0.10);
  if(t<0.25) return mix(c1,c2,t/0.25);
  if(t<0.5) return mix(c2,c3,(t-0.25)/0.25);
  if(t<0.75) return mix(c3,c4,(t-0.5)/0.25);
  return mix(c4,c5,(t-0.75)/0.25);
}

void main(){
  vec3 N = normalize(vNormal);
  vec3 L = normalize(vec3(0.4,0.7,0.6));
  float diff = abs(dot(N,L))*0.75 + 0.25;
  vec3 base;
  if(uMode==2){ base = vec3(0.72,0.76,0.82); }
  else if(vFilled < 0.5){ base = vec3(0.82,0.83,0.86); }
  else {
    float t = (vValue - uMin) / max(uMax - uMin, 1e-9);
    base = colormap(t);
  }
  fragColor = vec4(base*diff, 1.0);
}`;

const MARK_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uMVP;
uniform float uSize;
out vec3 vColor;
void main(){
  vColor = aColor;
  gl_Position = uMVP * vec4(aPos,1.0);
  gl_PointSize = uSize;
}`;

const MARK_FS = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 fragColor;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  if(dot(d,d) > 0.25) discard;
  fragColor = vec4(vColor, 1.0);
}`;

export type ViewMode = 'fill' | 'pressure' | 'plain';

interface Marker { pos: Vec3; color: [number, number, number]; size: number }

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
  return s;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

// 列主序 4x4
function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[10] = (far + near) / (near - far); m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}
function lookAt(eye: number[], center: number[], up: number[]): Float32Array {
  const z = norm(sub(eye, center));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}
function mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export class Renderer {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private markProg: WebGLProgram;
  private vao: WebGLVertexArrayObject | null = null;
  private markVao: WebGLVertexArrayObject;
  private markVbo: WebGLBuffer;
  private triCount = 0;
  private nodeCount = 0;
  private positions: Float32Array = new Float32Array(0);
  private triangles: Uint32Array = new Uint32Array(0);
  // 相机
  yaw = -0.7; pitch = 0.6; dist = 200; target = [0, 0, 0];
  private flyAnim: { from: number[]; to: number[]; t0: number; dur: number } | null = null;
  mode: ViewMode = 'plain';
  time = 0;
  valueMin = 0; valueMax = 1;
  canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.prog = link(gl, VS, FS);
    this.markProg = link(gl, MARK_VS, MARK_FS);
    this.markVao = gl.createVertexArray()!;
    this.markVbo = gl.createBuffer()!;
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.13, 0.14, 0.17, 1);
  }

  setMesh(positions: Float32Array, triangles: Uint32Array): void {
    const gl = this.gl;
    this.positions = positions;
    this.triangles = triangles;
    this.nodeCount = positions.length / 3;
    this.triCount = triangles.length / 3;
    // 法线
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i] * 3, b = triangles[i + 1] * 3, c = triangles[i + 2] * 3;
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const o of [a, b, c]) { normals[o] += nx; normals[o + 1] += ny; normals[o + 2] += nz; }
    }
    for (let i = 0; i < normals.length; i += 3) {
      const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
    }
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const mkBuf = (loc: number, data: Float32Array, size: number) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    mkBuf(0, positions, 3);
    mkBuf(1, normals, 3);
    mkBuf(2, new Float32Array(this.nodeCount).fill(-1), 1);
    mkBuf(3, new Float32Array(this.nodeCount), 1);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, triangles, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    // 视野适配
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < positions.length; i += 3) { cx += positions[i]; cy += positions[i + 1]; cz += positions[i + 2]; }
    const n = positions.length / 3;
    this.target = [cx / n, cy / n, cz / n];
    let r = 0;
    for (let i = 0; i < positions.length; i += 3) {
      r = Math.max(r, Math.hypot(positions[i] - this.target[0], positions[i + 1] - this.target[1], positions[i + 2] - this.target[2]));
    }
    this.dist = r * 2.6 || 100;
  }

  setField(loc: 'fill' | 'pressure', data: Float32Array): void {
    const gl = this.gl;
    if (!this.vao) return;
    gl.bindVertexArray(this.vao);
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const locIdx = loc === 'fill' ? 2 : 3;
    gl.enableVertexAttribArray(locIdx);
    gl.vertexAttribPointer(locIdx, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private markers: Marker[] = [];
  setMarkers(markers: Marker[]): void { this.markers = markers; }

  flyTo(pos: Vec3, dist?: number): void {
    this.flyAnim = {
      from: [...this.target, this.dist],
      to: [pos.x, pos.y, pos.z, dist ?? this.dist * 0.5],
      t0: performance.now(),
      dur: 600,
    };
  }

  private mvp(): Float32Array {
    const w = this.canvas.width, h = this.canvas.height;
    const proj = perspective(Math.PI / 4, w / Math.max(1, h), this.dist / 100, this.dist * 20);
    const eye = [
      this.target[0] + this.dist * Math.cos(this.pitch) * Math.cos(this.yaw),
      this.target[1] + this.dist * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.target[2] + this.dist * Math.sin(this.pitch),
    ];
    return mul(proj, lookAt(eye, this.target, [0, 0, 1]));
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(this.canvas.clientWidth * dpr), h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  render(): void {
    const gl = this.gl;
    // 飞行动画
    if (this.flyAnim) {
      const t = Math.min(1, (performance.now() - this.flyAnim.t0) / this.flyAnim.dur);
      const e = t * t * (3 - 2 * t);
      const f = this.flyAnim.from, to = this.flyAnim.to;
      this.target = [f[0] + (to[0] - f[0]) * e, f[1] + (to[1] - f[1]) * e, f[2] + (to[2] - f[2]) * e];
      this.dist = f[3] + (to[3] - f[3]) * e;
      if (t >= 1) this.flyAnim = null;
    }
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.vao || this.triCount === 0) return;
    const mvp = this.mvp();
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uMVP'), false, mvp);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uTime'), this.time);
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uMode'), this.mode === 'fill' ? 0 : this.mode === 'pressure' ? 1 : 2);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uMin'), this.valueMin);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uMax'), this.valueMax);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.triCount * 3, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    // 标记
    if (this.markers.length > 0) {
      const data = new Float32Array(this.markers.length * 6);
      this.markers.forEach((m, i) => {
        data[i * 6] = m.pos.x; data[i * 6 + 1] = m.pos.y; data[i * 6 + 2] = m.pos.z;
        data[i * 6 + 3] = m.color[0]; data[i * 6 + 4] = m.color[1]; data[i * 6 + 5] = m.color[2];
      });
      gl.useProgram(this.markProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.markProg, 'uMVP'), false, mvp);
      gl.uniform1f(gl.getUniformLocation(this.markProg, 'uSize'), this.markers[0]?.size ?? 14);
      gl.bindVertexArray(this.markVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.markVbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.drawArrays(gl.POINTS, 0, this.markers.length);
      gl.bindVertexArray(null);
    }
  }

  /** 屏幕坐标 -> 最近网格节点索引 */
  pick(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = 1 - ((clientY - rect.top) / rect.height) * 2;
    // 由 MVP 逆推射线(手动求逆 4x4 过重,用相机参数直接构造)
    const w = this.canvas.width, h = this.canvas.height;
    const aspect = w / Math.max(1, h);
    const fov = Math.PI / 4;
    const eye = [
      this.target[0] + this.dist * Math.cos(this.pitch) * Math.cos(this.yaw),
      this.target[1] + this.dist * Math.cos(this.pitch) * Math.sin(this.yaw),
      this.target[2] + this.dist * Math.sin(this.pitch),
    ];
    const fwd = norm(sub(this.target, eye));
    const right = norm(cross(fwd, [0, 0, 1]));
    const up = cross(right, fwd);
    const th = Math.tan(fov / 2);
    const dir = norm([
      fwd[0] + right[0] * x * th * aspect + up[0] * y * th,
      fwd[1] + right[1] * x * th * aspect + up[1] * y * th,
      fwd[2] + right[2] * x * th * aspect + up[2] * y * th,
    ]);
    // Möller–Trumbore
    let bestT = Infinity, bestTri = -1;
    const p = this.positions, tr = this.triangles;
    for (let i = 0; i < tr.length; i += 3) {
      const a = tr[i] * 3, b = tr[i + 1] * 3, c = tr[i + 2] * 3;
      const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const pv = cross(dir, e2);
      const det = dot(e1, pv);
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tv = sub(eye, [p[a], p[a + 1], p[a + 2]]);
      const u = dot(tv, pv) * inv;
      if (u < -1e-6 || u > 1 + 1e-6) continue;
      const qv = cross(tv, e1);
      const v = dot(dir, qv) * inv;
      if (v < -1e-6 || u + v > 1 + 1e-6) continue;
      const t = dot(e2, qv) * inv;
      if (t > 0 && t < bestT) { bestT = t; bestTri = i / 3; }
    }
    if (bestTri < 0) return null;
    // 命中点最近的顶点
    const hit = [eye[0] + dir[0] * bestT, eye[1] + dir[1] * bestT, eye[2] + dir[2] * bestT];
    let bestNode = -1, bestD = Infinity;
    for (let k = 0; k < 3; k++) {
      const ni = tr[bestTri * 3 + k];
      const d = Math.hypot(p[ni * 3] - hit[0], p[ni * 3 + 1] - hit[1], p[ni * 3 + 2] - hit[2]);
      if (d < bestD) { bestD = d; bestNode = ni; }
    }
    return bestNode;
  }

  screenshot(): string {
    this.render();
    return this.canvas.toDataURL('image/png');
  }
}
