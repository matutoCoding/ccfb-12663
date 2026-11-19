// 仿真报告导出:独立 HTML 文件,内嵌云图截图与关键指标
import { Scheme, SimResult, Material, Settings } from '../types.js';
import { Renderer } from '../render.js';
import { download, fmt } from '../util.js';

export function generateReport(scheme: Scheme, result: SimResult, mat: Material | undefined, renderer: Renderer, settings: Settings): void {
  // 依次渲染三种视图并截图
  const shots: { title: string; img: string }[] = [];
  const prevMode = renderer.mode, prevTime = renderer.time;

  renderer.mode = 'fill';
  renderer.valueMin = 0;
  renderer.valueMax = result.totalFillTime;
  renderer.time = result.totalFillTime * 0.5;
  shots.push({ title: `充填过程(t=${fmt(result.totalFillTime * 0.5)}s)`, img: renderer.screenshot() });
  renderer.time = result.totalFillTime;
  shots.push({ title: `充填完成(t=${fmt(result.totalFillTime)}s)`, img: renderer.screenshot() });
  renderer.mode = 'pressure';
  renderer.valueMin = 0;
  let pMax = 0.01;
  for (let i = 0; i < result.pressure.length; i++) if (result.pressure[i] > pMax) pMax = result.pressure[i];
  renderer.valueMax = pMax;
  shots.push({ title: '末端压力分布(MPa)', img: renderer.screenshot() });
  renderer.mode = prevMode;
  renderer.time = prevTime;
  renderer.render();

  const pUnit = settings.pressureUnit;
  const pConv = (mpa: number) => pUnit === 'bar' ? mpa * 10 : mpa;
  const weldRows = result.weldLines.map((w, i) =>
    `<tr><td>熔接痕 ${i + 1}</td><td>(${fmt(w.position.x)}, ${fmt(w.position.y)}, ${fmt(w.position.z)})</td><td>${fmt(w.length)} mm</td></tr>`).join('');
  const trapRows = result.airTraps.map((a, i) =>
    `<tr><td>困气 ${i + 1}</td><td>(${fmt(a.position.x)}, ${fmt(a.position.y)}, ${fmt(a.position.z)})</td><td>—</td></tr>`).join('');

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>仿真报告 - ${scheme.name}</title>
<style>
body{font-family:"Microsoft YaHei",sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#222}
h1{border-bottom:2px solid #1f6feb;padding-bottom:8px}
table{border-collapse:collapse;width:100%;margin:12px 0}
td,th{border:1px solid #ccc;padding:6px 10px;text-align:left}
th{background:#f0f3f8}
img{max-width:100%;border:1px solid #ddd;border-radius:6px;margin:6px 0}
.shot{margin:16px 0}
</style></head><body>
<h1>注塑充填仿真报告</h1>
<p>方案:<b>${scheme.name}</b> &nbsp;·&nbsp; 生成时间:${new Date().toLocaleString('zh-CN')} &nbsp;·&nbsp; 参数哈希:<code>${result.paramHash}</code></p>
<h2>工艺与材料</h2>
<table>
<tr><th>材料</th><td>${mat?.name ?? scheme.materialId}</td></tr>
<tr><th>熔体温度</th><td>${scheme.process.meltTemp} ℃</td></tr>
<tr><th>模具温度</th><td>${scheme.process.moldTemp} ℃</td></tr>
<tr><th>注射速率</th><td>${scheme.process.flowRate} cm³/s</td></tr>
<tr><th>壁厚</th><td>${scheme.process.thickness} mm</td></tr>
<tr><th>浇口数量</th><td>${scheme.gates.length}</td></tr>
<tr><th>网格规模</th><td>${result.nodeCount} 节点 / ${result.triCount} 单元</td></tr>
</table>
<h2>关键指标</h2>
<table>
<tr><th>指标</th><th>数值</th></tr>
<tr><td>总充填时间</td><td>${fmt(result.totalFillTime, 3)} s</td></tr>
<tr><td>最大注射压力</td><td>${fmt(pConv(result.maxInjectionPressure))} ${pUnit}</td></tr>
<tr><td>锁模力</td><td>${fmt(result.clampForce)} kN</td></tr>
<tr><td>熔接痕数量</td><td>${result.weldLines.length}</td></tr>
<tr><td>困气点数量</td><td>${result.airTraps.length}</td></tr>
<tr><td>计算耗时</td><td>${(result.durationMs / 1000).toFixed(2)} s</td></tr>
</table>
<h2>云图</h2>
${shots.map(s => `<div class="shot"><h3>${s.title}</h3><img src="${s.img}"></div>`).join('')}
<h2>熔接痕位置</h2>
<table><tr><th>编号</th><th>质心坐标 (mm)</th><th>近似长度</th></tr>${weldRows || '<tr><td colspan="3">未检测到</td></tr>'}</table>
<h2>困气位置</h2>
<table><tr><th>编号</th><th>坐标 (mm)</th><th></th></tr>${trapRows || '<tr><td colspan="3">未检测到</td></tr>'}</table>
</body></html>`;
  download(`仿真报告-${scheme.name}.html`, html, 'text/html');
}
