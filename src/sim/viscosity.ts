// 粘度模型：Cross-WLF 与 Carreau
// 单位：剪切速率 1/s，温度 K，粘度 Pa·s
import type { Material } from '../core/types';

/** WLF 移位因子 aT（温度对零剪切粘度的影响） */
function wlfShift(material: Material, temperatureK: number): number {
  const { wlfC1: c1, wlfC2: c2, wlfTRef: tRef } = material;
  const dt = temperatureK - tRef;
  // aT = 10^(-C1 (T-Tref) / (C2 + T-Tref))
  const exponent = (-c1 * dt) / (c2 + dt);
  return 10 ** exponent;
}

/**
 * Cross 模型剪切变稀：
 *   η(γ,T) = η0(T) / (1 + (η0(T)·γ / τ*)^(1-n))
 * 其中 η0(T) = η0 · aT
 */
export function viscosityCrossWlf(material: Material, shearRate: number, temperatureK: number): number {
  const aT = wlfShift(material, temperatureK);
  const eta0 = material.zeroShearViscosity * aT;
  const x = (eta0 * Math.max(0, shearRate)) / material.crossTauStar;
  const denom = 1 + Math.pow(x, 1 - material.crossN);
  return eta0 / denom;
}

/** Carreau 模型（等温使用，温度项沿用 WLF 移位） */
export function viscosityCarreau(material: Material, shearRate: number, temperatureK: number): number {
  const aT = wlfShift(material, temperatureK);
  const eta0 = material.zeroShearViscosity * aT;
  const g = Math.max(0, shearRate) * material.carreauLambda * aT;
  return eta0 / Math.pow(1 + g * g, (1 - material.carreauN) / 2);
}

export function materialViscosity(material: Material, shearRate: number, temperatureK: number): number {
  const eta =
    material.viscosityModel === 'carreau'
      ? viscosityCarreau(material, shearRate, temperatureK)
      : viscosityCrossWlf(material, shearRate, temperatureK);
  // 数值保护：极端低温下 WLF 可能溢出
  if (!Number.isFinite(eta) || eta <= 0) return 1e12;
  return Math.min(eta, 1e12);
}

/** 单元平均剪切速率（Hele-Shaw 薄壁近似）：γ ≈ 6|q|/h，q 为面内通量 mm/s */
export function shearRateHeleShaw(fluxSpeed: number, thickness: number): number {
  return (6 * Math.max(0, fluxSpeed)) / Math.max(thickness, 1e-6);
}
