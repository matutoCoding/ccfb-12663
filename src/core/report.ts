// 仿真报告导出：自包含 HTML 文件，内嵌云图截图（base64）与全部关键指标
import type { Material, Scheme, SimResult } from './types';
import { downloadBlob } from './utils';

export interface ReportContent {
  scheme: Scheme;
  material: Material;
  result: SimResult;
  screenshot: string; // dataURL
  pressureShot?: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function row(label: string, value: string | number, unit = ''): string {
  return `<tr><td>${esc(label)}</td><td class="num">${value}${unit ? ' ' + esc(unit) : ''}</td></tr>`;
}

export function buildReportHtml(c: ReportContent): string {
  const { scheme, material, result: r } = c;
  const m = r.metrics;
  const weldRows = r.weldLines
    .map((w) => `<tr><td>#${w.nodeIndex}</td><td class="num">(${w.x.toFixed(2)}, ${w.y.toFixed(2)}, ${w.z.toFixed(2)})</td><td class="num">${w.fillTime.toFixed(4)} s</td><td>${esc(w.sourceA.slice(-6))} ↔ ${esc(w.sourceB.slice(-6))}</td></tr>`)
    .join('');
  const airRows = r.airTraps
    .map((a) => `<tr><td>#${a.nodeIndex}</td><td class="num">(${a.x.toFixed(2)}, ${a.y.toFixed(2)}, ${a.z.toFixed(2)})</td><td class="num">${a.fillTime.toFixed(4)} s</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>注塑充填仿真报告 - ${esc(scheme.name)}</title>
<style>
  body { font-family: "Microsoft YaHei", system-ui, sans-serif; margin: 32px; color: #1f2937; background: #f8fafc; }
  h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 28px; border-left: 4px solid #2563eb; padding-left: 8px; }
  table { border-collapse: collapse; width: 100%; background: #fff; margin: 8px 0; }
  td, th { border: 1px solid #d1d5db; padding: 8px 10px; font-size: 13px; }
  th { background: #eff6ff; text-align: left; } .num { text-align: right; font-family: Consolas, monospace; }
  .meta { color: #6b7280; font-size: 12px; } .shot { max-width: 100%; border: 1px solid #d1d5db; border-radius: 8px; background:#0f172a; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; background: #dcfce7; color #166534; }
  .badge.bad { background: #fee2e2; color: #991b1b; }
  @media print { body { margin: 8px; } .shot { max-width: 80%; } }
</style></head><body>
<h1>注塑充填仿真报告</h1>
<p class="meta">方案：${esc(scheme.name)} ｜ 材料：${esc(material.name)}（${esc(material.category)}）｜ 生成时间：${new Date().toLocaleString('zh-CN')} ｜ 求解模型：Hele-Shaw 2.5D / CV-FEM</p>

<h2>一、充填时间云图</h2>
<img class="shot" src="${c.screenshot}" alt="充填时间云图" />
${c.pressureShot ? '<h2>二、峰值压力云图</h2><img class="shot" src="' + c.pressureShot + '" alt="峰值压力云图" />' : ''}

<h2>${c.pressureShot ? '三' : '二'}、关键指标</h2>
<table>
  ${row('充填状态', m.shortShot ? '短射（未充满）' : '完全充满')}
  ${row('充填时间', m.fillTime.toFixed(4), 's')}
  ${row('最大注射压力', m.maxPressure.toFixed(3), 'MPa')}
  ${row('最大锁模力', m.maxClampForce.toFixed(2), 'kN')}
  ${row('平均剪切速率', m.avgShearRate.toFixed(1), '1/s')}
  ${row('充填体积', m.filledVolume.toFixed(1), 'mm³')}
  ${row('总体积', m.totalVolume.toFixed(1), 'mm³')}
  ${row('熔接痕', r.weldLines.length, '处')}
  ${row('困气点', r.airTraps.length, '处')}
  ${row('时间步数 / CG 迭代', `${r.stepCount} / ${r.cgIterationCount}`)}
</table>

<h2>工艺参数</h2>
<table>
  ${row('体积流量', scheme.process.flowRate, 'mm³/s')}
  ${row('熔体温度', scheme.process.meltTemperature, '℃')}
  ${row('模具温度', scheme.process.moldTemperature, '℃')}
  ${row('最大注射压力上限', scheme.process.maxInjectionPressure, 'MPa')}
  ${row('浇口数量', scheme.gates.length)}
  ${scheme.gates.map((g) => row(`浇口 ${esc(g.name)}（节点 #${g.nodeIndex}）开启时间`, g.openTime, 's')).join('')}
</table>

<h2>材料物性</h2>
<table>
  ${row('粘度模型', material.viscosityModel === 'cross-wlf' ? 'Cross-WLF' : 'Carreau')}
  ${row('零剪切粘度 η0', material.zeroShearViscosity.toExponential(3), 'Pa·s')}
  ${row('Cross n / τ*', `${material.crossN} / ${material.crossTauStar}`, 'Pa')}
  ${row('WLF C1 / C2 / Tref', `${material.wlfC1} / ${material.wlfC2} / ${material.wlfTRef}`, 'K')}
  ${row('导热系数', material.thermalConductivity, 'W/(m·K)')}
  ${row('比热容', material.specificHeat, 'J/(kg·K)')}
  ${row('密度', material.density, 'kg/m³')}
  ${row('固化温度', material.solidificationTemperature, '℃')}
</table>

<h2>熔接痕明细（${r.weldLines.length} 处）</h2>
${r.weldLines.length ? `<table><tr><th>节点</th><th>坐标 (mm)</th><th>出现时刻</th><th>汇合浇口</th></tr>${weldRows}</table>` : '<p class="meta">无熔接痕</p>'}
<h2>困气点明细（${r.airTraps.length} 处）</h2>
${r.airTraps.length ? `<table><tr><th>节点</th><th>坐标 (mm)</th><th>发现时刻</th></tr>${airRows}</table>` : '<p class="meta">无困气点</p>'}
<p class="meta" style="margin-top:32px">本报告由浏览器端注塑充填仿真平台生成，全部计算在本机完成，缓存键 ${esc(r.cacheKey)}。</p>
</body></html>`;
}

export function exportReport(content: ReportContent): void {
  const html = buildReportHtml(content);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  downloadBlob(blob, `仿真报告_${content.scheme.name.replace(/[\\/:*?"<>|]/g, '_')}.html`);
}
