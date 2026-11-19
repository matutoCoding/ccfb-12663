// 内置材料库(Cross-WLF 参数为典型量级,供演示与对比)
import { Material } from './types.js';

export const DEFAULT_MATERIALS: Material[] = [
  {
    id: 'mat-abs', name: 'ABS(通用级)', builtin: true,
    n: 0.32, tauStar: 2.9e4, d1: 3.2e11, d2: 373.15, d3: 0, a1: 26.5, a2: 51.6,
    thermalConductivity: 0.17, specificHeat: 2100, density: 1040,
    noFlowTemp: 105, defaultMeltTemp: 240, defaultMoldTemp: 60,
  },
  {
    id: 'mat-pc', name: 'PC(透明级)', builtin: true,
    n: 0.28, tauStar: 4.5e4, d1: 1.9e12, d2: 418.15, d3: 0, a1: 30.0, a2: 51.6,
    thermalConductivity: 0.20, specificHeat: 1900, density: 1200,
    noFlowTemp: 145, defaultMeltTemp: 290, defaultMoldTemp: 90,
  },
  {
    id: 'mat-pp', name: 'PP(均聚)', builtin: true,
    n: 0.38, tauStar: 2.2e4, d1: 5.5e10, d2: 263.15, d3: 0, a1: 24.2, a2: 51.6,
    thermalConductivity: 0.22, specificHeat: 2300, density: 900,
    noFlowTemp: 20, defaultMeltTemp: 220, defaultMoldTemp: 40,
  },
  {
    id: 'mat-pa66', name: 'PA66-GF30', builtin: true,
    n: 0.30, tauStar: 3.8e4, d1: 8.0e11, d2: 323.15, d3: 0, a1: 28.0, a2: 51.6,
    thermalConductivity: 0.28, specificHeat: 2000, density: 1360,
    noFlowTemp: 60, defaultMeltTemp: 285, defaultMoldTemp: 80,
  },
  {
    id: 'mat-pom', name: 'POM(共聚)', builtin: true,
    n: 0.33, tauStar: 3.1e4, d1: 2.4e11, d2: 333.15, d3: 0, a1: 25.0, a2: 51.6,
    thermalConductivity: 0.25, specificHeat: 1950, density: 1410,
    noFlowTemp: 60, defaultMeltTemp: 200, defaultMoldTemp: 70,
  },
];
