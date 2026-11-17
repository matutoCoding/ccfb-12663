// WebGL2 渲染器：三角网格云图、标记点、拾取、轨道相机
// 零第三方依赖，所有缓冲按固定顺序上传，保证渲染结果可复现
import { computeBBox } from '../geometry/vector';
import type { SimResult, TriangleMesh } from '../core/types';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in float aScalar;
layout(location=2) in vec3 aNormal;
uniform mat4 uViewProj;
uniform float uScalarMin;
uniform float uScalarMax;
uniform int uMode; // 0 实体 1 云图 2 灰度压力
out float vScalar;
out vec3 vNormal;
out vec3 vWorldPos;
vec3 turbo(float t) {
  // Turbo 近似配色（蓝→青→绿→黄→红）
  vec3 c0 = vec3(0.19,0.07,0.47);
  vec3 c1 = vec3(0.10,0.65,0.95);
  vec3 c2 = vec3(0.30,0.95,0.40);
  vec3 c3 = vec3(0.98,0.85,0.20);
  vec3 c4 = vec3(0.85,0.12,0.10);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}
vec3 colorFor(float s) {
  if (uMode == 2) return vec3(s);
  float t = clamp((s - uScalarMin) / max(uScalarMax - uScalarMin, 1e-9), 0.0, 1.0);
  return turbo(t);
}
void main() {
  vScalar = aScalar;
  vNormal = aNormal;
  vWorldPos = aPos;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in float vScalar;
in vec3 vNormal;
in vec3 vWorldPos;
uniform int uMode;
uniform vec3 uColor;
uniform vec3 uCamPos;
uniform float uOpacity;
out vec4 outColor;
vec3 turbo(float t) {
  vec3 c0 = vec3(0.19,0.07,0.47);
  vec3 c1 = vec3(0.10,0.65,0.95);
  vec3 c2 = vec3(0.30,0.95,0.40);
  vec3 c3 = vec3(0.98,0.85,0.20);
  vec3 c4 = vec3(0.85,0.12,0.10);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}
void main() {
  vec3 base = uColor;
  if (uMode == 1 || uMode == 2) {
    float t = clamp(vScalar, 0.0, 1.0);
    base = uMode == 2 ? vec3(t) : turbo(t);
  }
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(0.4, 0.6, 0.8));
  float diff = 0.55 + 0.45 * max(dot(n, lightDir), 0.0);
  // 简单边缘高光增强立体感
  vec3 viewDir = normalize(uCamPos - vWorldPos);
  float rim = 0.12 * pow(1.0 - max(dot(n, viewDir), 0.0), 2.0);
  outColor = vec4(base * diff + vec3(rim), uOpacity);
}`;

const POINT_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aColor;
uniform mat4 uViewProj;
uniform float uPointSize;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
  gl_PointSize = uPointSize;
}`;

const POINT_FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float edge = smoothstep(0.25, 0.18, r2);
  outColor = vec4(vColor, edge);
}`;

// 拾取 FBO 用的 id 编码着色器：每个三角面三顶点携带同一种 id 颜色，单次绘制完成拾取
const PICK_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aIdColor;
uniform mat4 uViewProj;
out vec3 vIdColor;
void main() {
  vIdColor = aIdColor;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;
const PICK_FRAG = `#version 300 es
precision highp float;
in vec3 vIdColor;
out vec4 outColor;
void main() { outColor = vec4(vIdColor, 1.0); }`;

export type RenderMode = 'solid' | 'fill-contour' | 'pressure';

export interface Marker {
  id: string;
  x: number;
  y: number;
  z: number;
  color: [number, number, number];
  size: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('着色器编译失败: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

function mat4Perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return Float32Array.from([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function mat4LookAt(eye: number[], center: number[], up: number[]): Float32Array {
  const zx = eye[0] - center[0],
    zy = eye[1] - center[1],
    zz = eye[2] - center[2];
  let zl = Math.hypot(zx, zy, zz) || 1;
  const z0 = zx / zl,
    z1 = zy / zl,
    z2 = zz / zl;
  const xx = up[1] * z2 - up[2] * z1;
  const xy = up[2] * z0 - up[0] * z2;
  const xz = up[0] * z1 - up[1] * z0;
  const xl = Math.hypot(xx, xy, xz) || 1;
  const x0 = xx / xl,
    x1 = xy / xl,
    x2 = xz / xl;
  const y0 = z1 * x2 - z2 * x1;
  const y1 = z2 * x0 - z0 * x2;
  const y2 = z0 * x1 - z1 * x0;
  return Float32Array.from([
    x0, y0, z0, 0,
    x1, y1, z1, 0,
    x2, y2, z2, 0,
    -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]),
    -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]),
    -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]),
    1,
  ]);
}

function multiply4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export class OrbitCamera {
  target = [0, 0, 0];
  distance = 200;
  yaw = 0.7;
  pitch = 0.5;
  fovy = Math.PI / 5;
  near = 0.1;
  far = 10000;

  fit(bbox: ReturnType<typeof computeBBox>): void {
    this.target = [bbox.centerX, bbox.centerY, bbox.centerZ];
    const radius = Math.max(bbox.sizeX, bbox.sizeY, bbox.sizeZ) / 2 || 10;
    this.distance = radius / Math.tan(this.fovy / 2) * 1.35;
    this.near = Math.max(0.01, this.distance / 1000);
    this.far = this.distance * 100;
  }

  eye(): number[] {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * cp * Math.cos(this.yaw),
      this.target[1] + this.distance * cp * Math.sin(this.yaw),
      this.target[2] + this.distance * Math.sin(this.pitch),
    ];
  }

  viewProj(aspect: number): Float32Array {
    const proj = mat4Perspective(this.fovy, aspect, this.near, this.far);
    const view = mat4LookAt(this.eye(), this.target, [0, 0, 1]);
    return multiply4(proj, view);
  }

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * 0.008;
    this.pitch += dy * 0.008;
    const lim = Math.PI / 2 - 0.02;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  zoom(factor: number): void {
    this.distance = Math.max(1, this.distance * factor);
  }

  pan(dx: number, dy: number): void {
    // 在相机局部坐标系（右向量/上向量）内平移目标点
    const eye = this.eye();
    const fx = (this.target[0] - eye[0]) / this.distance;
    const fy = (this.target[1] - eye[1]) / this.distance;
    const fz = (this.target[2] - eye[2]) / this.distance;
    // 右向量 = forward × worldUp(0,0,1)
    let rx = fy * 1 - fz * 0;
    let ry = fz * 0 - fx * 1;
    let rz = fx * 0 - fy * 0;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl;
    ry /= rl;
    rz /= rl;
    // 上向量 = right × forward
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;
    const scale = this.distance * 0.0014;
    this.target[0] += (-dx * scale * rx + dy * scale * ux);
    this.target[1] += (-dx * scale * ry + dy * scale * uy);
    this.target[2] += (-dx * scale * rz + dy * scale * uz);
  }
}

export class Renderer {
  gl: WebGL2RenderingContext;
  camera = new OrbitCamera();
  private meshProg: WebGLProgram;
  private pointProg: WebGLProgram;
  private pickProg: WebGLProgram;
  private vao: WebGLVertexArrayObject | null = null;
  private posBuf: WebGLBuffer | null = null;
  private scalarBuf: WebGLBuffer | null = null;
  private normalBuf: WebGLBuffer | null = null;
  private indexBuf: WebGLBuffer | null = null;
  private indexCount = 0;
  private pointVao: WebGLVertexArrayObject | null = null;
  private pointPosBuf: WebGLBuffer | null = null;
  private pointColorBuf: WebGLBuffer | null = null;
  private pointCount = 0;
  private pickVao: WebGLVertexArrayObject | null = null;
  private pickIdBuf: WebGLBuffer | null = null;
  private pickFbo: WebGLFramebuffer | null = null;
  private pickTex: WebGLTexture | null = null;
  private pickDepth: WebGLRenderbuffer | null = null;
  private bbox: ReturnType<typeof computeBBox> | null = null;
  mode: RenderMode = 'solid';
  scalarRange: [number, number] = [0, 1];
  baseColor: [number, number, number] = [0.62, 0.72, 0.85];
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2，请使用最新版 Chrome/Edge');
    this.gl = gl;
    this.meshProg = program(gl, VERT, FRAG);
    this.pointProg = program(gl, POINT_VERT, POINT_FRAG);
    this.pickProg = program(gl, PICK_VERT, PICK_FRAG);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.075, 0.09, 0.12, 1);
  }

  setMesh(mesh: TriangleMesh): void {
    const gl = this.gl;
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.posBuf = this.uploadBuffer(gl.ARRAY_BUFFER, mesh.positions, this.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const normals = computeVertexNormals(mesh);
    this.normalBuf = this.uploadBuffer(gl.ARRAY_BUFFER, normals, this.normalBuf);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);

    const scalars = new Float32Array(mesh.nodeCount);
    this.scalarBuf = this.uploadBuffer(gl.ARRAY_BUFFER, scalars, this.scalarBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);

    this.indexBuf = this.uploadBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.triangles, this.indexBuf);
    this.indexCount = mesh.triangles.length;
    gl.bindVertexArray(null);

    // 拾取 VAO：位置 + 逐节点三角面 id 颜色（同一三角面三顶点同色）
    if (this.pickVao) gl.deleteVertexArray(this.pickVao);
    this.pickVao = gl.createVertexArray();
    gl.bindVertexArray(this.pickVao);
    this.uploadBuffer(gl.ARRAY_BUFFER, mesh.positions, this.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const idColors = buildTriangleIdColors(mesh);
    this.pickIdBuf = this.uploadBuffer(gl.ARRAY_BUFFER, idColors, this.pickIdBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    this.uploadBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.triangles, this.indexBuf);
    gl.bindVertexArray(null);

    this.bbox = computeBBox(mesh.positions);
    this.camera.fit(this.bbox);
    this.currentMesh = mesh;
  }

  private uploadBuffer(target: number, data: ArrayBufferView, old: WebGLBuffer | null): WebGLBuffer {
    const gl = this.gl;
    const buf = old ?? gl.createBuffer();
    if (!buf) throw new Error('WebGL 缓冲区创建失败');
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data, gl.DYNAMIC_DRAW);
    return buf;
  }

  /** 更新节点标量场（充填时间归一化值 0..1，或压力归一化值） */
  setScalarField(values: Float32Array | Float64Array, min: number, max: number): void {
    const gl = this.gl;
    const normalized = new Float32Array(values.length);
    const span = Math.max(max - min, 1e-12);
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      normalized[i] = v < 0 ? 0 : Math.min(1, (v - min) / span);
    }
    gl.bindVertexArray(this.vao);
    this.scalarBuf = this.uploadBuffer(gl.ARRAY_BUFFER, normalized, this.scalarBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.scalarRange = [min, max];
  }

  setMarkers(markers: Marker[]): void {
    const gl = this.gl;
    if (this.pointVao) gl.deleteVertexArray(this.pointVao);
    this.pointVao = gl.createVertexArray();
    gl.bindVertexArray(this.pointVao);
    const positions = new Float32Array(markers.length * 3);
    const colors = new Float32Array(markers.length * 3);
    for (let i = 0; i < markers.length; i++) {
      positions[i * 3] = markers[i].x;
      positions[i * 3 + 1] = markers[i].y;
      positions[i * 3 + 2] = markers[i].z;
      colors[i * 3] = markers[i].color[0];
      colors[i * 3 + 1] = markers[i].color[1];
      colors[i * 3 + 2] = markers[i].color[2];
    }
    this.pointPosBuf = this.uploadBuffer(gl.ARRAY_BUFFER, positions, this.pointPosBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    this.pointColorBuf = this.uploadBuffer(gl.ARRAY_BUFFER, colors, this.pointColorBuf);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    this.pointCount = markers.length;
    gl.bindVertexArray(null);
  }

  render(): void {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.indexCount === 0) return;

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const vp = this.camera.viewProj(aspect);
    const eye = this.camera.eye();

    gl.useProgram(this.meshProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.meshProg, 'uViewProj'), false, vp);
    gl.uniform1i(gl.getUniformLocation(this.meshProg, 'uMode'), this.mode === 'solid' ? 0 : this.mode === 'fill-contour' ? 1 : 2);
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uScalarMin'), this.scalarRange[0]);
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uScalarMax'), this.scalarRange[1]);
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uColor'), this.baseColor);
    gl.uniform3fv(gl.getUniformLocation(this.meshProg, 'uCamPos'), eye);
    gl.uniform1f(gl.getUniformLocation(this.meshProg, 'uOpacity'), 1);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    if (this.pointCount > 0) {
      gl.useProgram(this.pointProg);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.pointProg, 'uViewProj'), false, vp);
      gl.uniform1f(gl.getUniformLocation(this.pointProg, 'uPointSize'), 18 * dpr);
      gl.bindVertexArray(this.pointVao);
      gl.drawArrays(gl.POINTS, 0, this.pointCount);
    }
    gl.bindVertexArray(null);
  }

  /**
   * 屏幕坐标拾取最近三角面，返回吸附节点（固定规则：三角面内屏幕投影距离最小的顶点）。
   * 离屏 FBO 单次绘制，每三角面编码唯一 id 颜色，复杂度 O(面数)。
   */
  pickTriangle(clientX: number, clientY: number): { nodeIndex: number; x: number; y: number; z: number } | null {
    if (this.indexCount === 0 || !this.currentMesh) return null;
    const gl = this.gl;
    const rect = this.canvas.getBoundingClientRect();
    const sx = Math.floor((clientX - rect.left) * (this.canvas.width / rect.width));
    const sy = Math.floor((rect.bottom - clientY) * (this.canvas.height / rect.height));
    this.ensurePickFbo();
    const aspect = this.canvas.width / this.canvas.height;
    const vp = this.camera.viewProj(aspect);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.pickProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.pickProg, 'uViewProj'), false, vp);
    gl.bindVertexArray(this.pickVao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    // 3×3 邻域采样，取深度最小的命中像素，提升边缘点选稳定性
    let bestTri = -1;
    let bestDepth = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const x = sx + ox,
          y = sy + oy;
        if (x < 0 || y < 0 || x >= this.canvas.width || y >= this.canvas.height) continue;
        const color = new Uint8Array(4);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, color);
        const depth = new Float32Array(1);
        gl.readPixels(x, y, 1, 1, gl.DEPTH_COMPONENT, gl.FLOAT, depth);
        const tri = decodeTriangleId(color[0], color[1], color[2]);
        if (tri >= 0 && depth[0] < bestDepth) {
          bestDepth = depth[0];
          bestTri = tri;
        }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0.075, 0.09, 0.12, 1);
    if (bestTri < 0) return null;

    const mesh = this.currentMesh;
    const t = bestTri * 3;
    const ids = [mesh.triangles[t], mesh.triangles[t + 1], mesh.triangles[t + 2]];
    let nodeIndex = ids[0];
    let bestDist = Infinity;
    for (const id of ids) {
      const proj = this.projectToScreen(mesh.positions[id * 3], mesh.positions[id * 3 + 1], mesh.positions[id * 3 + 2]);
      const d = (proj.x - sx) ** 2 + (proj.y - sy) ** 2;
      if (d < bestDist) {
        bestDist = d;
        nodeIndex = id;
      }
    }
    return {
      nodeIndex,
      x: mesh.positions[nodeIndex * 3],
      y: mesh.positions[nodeIndex * 3 + 1],
      z: mesh.positions[nodeIndex * 3 + 2],
    };
  }

  private currentMesh: TriangleMesh | null = null;

  private ensurePickFbo(): void {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (this.pickFbo && this.pickFboWidth === w && this.pickFboHeight === h) return;
    this.pickFboWidth = w;
    this.pickFboHeight = h;
    if (this.pickFbo) gl.deleteFramebuffer(this.pickFbo);
    if (this.pickTex) gl.deleteTexture(this.pickTex);
    if (this.pickDepth) gl.deleteRenderbuffer(this.pickDepth);
    this.pickFbo = gl.createFramebuffer();
    this.pickTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.pickTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.pickDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.pickDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pickFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pickTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.pickDepth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  private pickFboWidth = 0;
  private pickFboHeight = 0;

  private projectToScreen(x: number, y: number, z: number): { x: number; y: number } {
    const vp = this.camera.viewProj(this.canvas.width / this.canvas.height);
    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    return {
      x: (ndcX * 0.5 + 0.5) * this.canvas.width,
      y: (1 - (ndcY * 0.5 + 0.5)) * this.canvas.height,
    };
  }

  /** 飞行定位到指定模型坐标（列表点选视角跳转） */
  flyTo(x: number, y: number, z: number, durationMs = 600): Promise<void> {
    return new Promise((resolve) => {
      const startTarget = [...this.camera.target];
      const startDist = this.camera.distance;
      const bboxRadius = this.bbox ? Math.max(this.bbox.sizeX, this.bbox.sizeY, this.bbox.sizeZ) / 2 : 20;
      const endDist = Math.max(bboxRadius * 0.35, 8);
      const t0 = performance.now();
      const tick = () => {
        const t = Math.min(1, (performance.now() - t0) / durationMs);
        const e = 1 - Math.pow(1 - t, 3);
        this.camera.target = [
          startTarget[0] + (x - startTarget[0]) * e,
          startTarget[1] + (y - startTarget[1]) * e,
          startTarget[2] + (z - startTarget[2]) * e,
        ];
        this.camera.distance = startDist + (endDist - startDist) * e;
        this.render();
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  screenshot(): string {
    this.render();
    return this.canvas.toDataURL('image/png');
  }

  getBBox() {
    return this.bbox;
  }

  dispose(): void {
    const gl = this.gl;
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
  }
}

/** 三角面 id 编解码：24 位颜色通道，最多支持 1600 万面，0 保留为背景 */
function encodeTriangleId(id: number): [number, number, number] {
  const v = id + 1;
  return [v & 255, (v >> 8) & 255, (v >> 16) & 255];
}

function decodeTriangleId(r: number, g: number, b: number): number {
  const v = r | (g << 8) | (b << 16);
  return v === 0 ? -1 : v - 1;
}

/** 为每个三角面的三个顶点写入相同 id 颜色 */
function buildTriangleIdColors(mesh: TriangleMesh): Float32Array {
  const out = new Float32Array(mesh.triangles.length * 3);
  for (let f = 0; f < mesh.triangleCount; f++) {
    const [r, g, b] = encodeTriangleId(f);
    for (let k = 0; k < 3; k++) {
      const o = (f * 3 + k) * 3;
      out[o] = r / 255;
      out[o + 1] = g / 255;
      out[o + 2] = b / 255;
    }
  }
  return out;
}

/** 面积加权顶点法线（固定邻接遍历顺序） */
export function computeVertexNormals(mesh: TriangleMesh): Float32Array {
  const n = mesh.nodeCount;
  const normals = new Float32Array(n * 3);
  const p = mesh.positions;
  const t = mesh.triangles;
  for (let f = 0; f < t.length; f += 3) {
    const a = t[f] * 3,
      b = t[f + 1] * 3,
      c = t[f + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const idx of [t[f], t[f + 1], t[f + 2]]) {
      normals[idx * 3] += nx;
      normals[idx * 3 + 1] += ny;
      normals[idx * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < n; i++) {
    const x = normals[i * 3],
      y = normals[i * 3 + 1],
      z = normals[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    normals[i * 3] = x / l;
    normals[i * 3 + 1] = y / l;
    normals[i * 3 + 2] = z / l;
  }
  return normals;
}

/** 从仿真结果构造充填时刻的标量场（动画帧：当前时间之前=已充填） */
export function fillFieldAtTime(result: SimResult, time: number): Float32Array {
  const out = new Float32Array(result.fillTimes.length);
  for (let i = 0; i < result.fillTimes.length; i++) {
    const ft = result.fillTimes[i];
    out[i] = ft < 0 ? -1 : Math.min(1, ft <= time ? ft : -1);
  }
  return out;
}
