/**
 * Modelo físico SIMPLIFICADO de la instalación (parámetros concentrados).
 *
 * Qué es validado y qué no:
 * - Presión de saturación (fórmula de Magnus, coef. Sonntag/WMO): ecuación empírica
 *   ampliamente validada en el rango 0–50 °C (error < 0,4 %).
 * - Relación HR ↔ humedad absoluta (gas ideal): validada.
 * - TODO LO DEMÁS es una aproximación de primer orden: balance térmico de un único
 *   nodo, intercambio de aire perfectamente mezclado, mezcla del depósito como
 *   primer orden, efectos químicos lineales por mL/L, deriva lineal de pH/EC y
 *   relajación exponencial del ORP. Sirve para estudiar la lógica de control,
 *   NO para predecir valores reales.
 */
import type { LiquidConfig, OutputId, PlantParams, PlantState, PumpId } from '../types';
import { OUTPUT_IDS } from '../types';
import { HOUR, clamp } from '../util';

export const MODEL_NOTES = {
  validated: ['Presión de vapor de saturación (Magnus)', 'Conversión HR ↔ humedad absoluta (gas ideal)'],
  approximate: [
    'Balance térmico de un nodo (lámparas, deshumidificador, envolvente, ventilación)',
    'Intercambio de humedad por ventilación y fugas, aire perfectamente mezclado',
    'Temperatura del agua: acoplamiento de primer orden con el aire',
    'Mezcla del depósito: primer orden con constante configurable',
    'Efecto químico lineal por mL/L de cada líquido (configurable, no validado)',
    'Deriva de pH/EC lineal y relajación exponencial del ORP',
  ],
};

/** Presión de vapor de saturación (hPa), Magnus. */
export function saturationVaporPressure(tC: number): number {
  return 6.112 * Math.exp((17.62 * tC) / (243.12 + tC));
}

/** Humedad absoluta de saturación (g/m³). */
export function saturationAbsHumidity(tC: number): number {
  return (216.7 * saturationVaporPressure(tC)) / (273.15 + tC);
}

export function rhFromAbs(abs: number, tC: number): number {
  return clamp((abs / saturationAbsHumidity(tC)) * 100, 0, 100);
}

export function absFromRh(rh: number, tC: number): number {
  return (clamp(rh, 0, 100) / 100) * saturationAbsHumidity(tC);
}

export function allOff(): Record<OutputId, boolean> {
  const r = {} as Record<OutputId, boolean>;
  for (const id of OUTPUT_IDS) r[id] = false;
  return r;
}

export interface InitialConditions {
  airTemp: number;
  rh: number;
  waterTemp: number;
  volumeL: number;
  ph: number;
  ec: number;
  orp: number;
  extTemp: number;
  extRh: number;
}

export const DEFAULT_INITIAL: InitialConditions = {
  airTemp: 23,
  rh: 55,
  waterTemp: 20,
  volumeL: 100,
  ph: 7.0,
  ec: 0.4,
  orp: 250,
  extTemp: 22,
  extRh: 50,
};

export function createPlantState(ic: InitialConditions = DEFAULT_INITIAL): PlantState {
  return {
    airTemp: ic.airTemp,
    absHumidity: absFromRh(ic.rh, ic.airTemp),
    waterTemp: ic.waterTemp,
    volumeL: ic.volumeL,
    ph: ic.ph,
    ecMass: ic.ec * ic.volumeL,
    orp: ic.orp,
    pending: { ecMass: 0, ph: 0, orp: 0, volumeL: 0 },
    extTemp: ic.extTemp,
    extRh: ic.extRh,
    applied: allOff(),
  };
}

export class PlantModel {
  constructor(
    public state: PlantState,
    public params: PlantParams,
  ) {}

  get rh(): number {
    return rhFromAbs(this.state.absHumidity, this.state.airTemp);
  }
  get ec(): number {
    return this.state.volumeL > 0 ? this.state.ecMass / this.state.volumeL : 0;
  }

  /** Valor "verdadero" del modelo para cada sensor. */
  truth(id: 'ph' | 'ec' | 'orp' | 'airTemp' | 'rh' | 'waterTemp'): number {
    switch (id) {
      case 'ph':
        return this.state.ph;
      case 'ec':
        return this.ec;
      case 'orp':
        return this.state.orp;
      case 'airTemp':
        return this.state.airTemp;
      case 'rh':
        return this.rh;
      case 'waterTemp':
        return this.state.waterTemp;
    }
  }

  /**
   * Añade una dosis al depósito. El efecto entra en un "volumen sin mezclar"
   * que se incorpora con la constante de mezcla, de modo que los sensores ven
   * el cambio de forma gradual.
   */
  addDose(liquid: LiquidConfig, ml: number): void {
    const s = this.state;
    const V = Math.max(1, s.volumeL);
    const mlPerL = ml / V;
    const m = liquid.model;
    s.pending.ecMass += m.ecPerMlPerL * mlPerL * V;
    s.pending.ph += (m.phPerMlPerL * mlPerL) / Math.max(0.05, this.params.phBufferFactor);
    s.pending.orp += m.orpPerMlPerL * mlPerL;
    s.pending.volumeL += ml / 1000;
  }

  addWater(liters: number, ph?: number, ec?: number): void {
    const s = this.state;
    const V = s.volumeL;
    const nv = V + liters;
    if (nv <= 0) return;
    if (ph !== undefined) s.ph = (s.ph * V + ph * liters) / nv; // mezcla aproximada (no logarítmica)
    if (ec !== undefined) s.ecMass += ec * liters;
    s.volumeL = nv;
  }

  step(dtS: number, simTime: number, liquids: Record<PumpId, LiquidConfig>): void {
    void liquids;
    const s = this.state;
    const p = this.params;
    const out = s.applied;

    // Temperatura exterior con oscilación diaria opcional.
    const hourOfDay = ((simTime / HOUR) % 24 + 24) % 24;
    const extT = s.extTemp + p.extTempAmplitude * Math.sin(((hourOfDay - 9) / 24) * 2 * Math.PI);
    const extAbs = absFromRh(s.extRh, extT);

    // --- Balance térmico (aproximado)
    const flowM3s = (out.fan ? p.fanFlowM3h : 0) / 3600;
    const leakM3s = (p.leakACH * p.roomVolumeM3) / 3600;
    const airRhoCp = 1.2 * 1005;
    let qW = 0;
    if (out.lights) qW += p.lightsPowerW * p.lightsHeatFraction;
    if (out.dehumidifier) qW += p.dehumidifierHeatW;
    qW -= p.envelopeUA * (s.airTemp - extT);
    qW -= airRhoCp * (flowM3s + leakM3s) * (s.airTemp - extT);
    s.airTemp += (qW / p.heatCapacityJPerK) * dtS;

    // --- Humedad absoluta (aproximado)
    let gps = 0;
    if (out.humidifier) gps += p.humidifierGPerH / 3600;
    if (out.dehumidifier) gps -= p.dehumidifierGPerH / 3600;
    gps += (out.lights ? p.transpirationLightGPerH : p.transpirationDarkGPerH) / 3600;
    let dAbs = gps / p.roomVolumeM3;
    dAbs -= ((flowM3s + leakM3s) / p.roomVolumeM3) * (s.absHumidity - extAbs);
    s.absHumidity = Math.max(0, s.absHumidity + dAbs * dtS);
    const sat = saturationAbsHumidity(s.airTemp);
    if (s.absHumidity > sat) s.absHumidity = sat; // condensación: solo se recorta

    // --- Agua
    s.waterTemp += ((s.airTemp - s.waterTemp) / (p.waterTauMin * 60)) * dtS;
    const evapL = (p.evaporationLPerH / 3600) * dtS * Math.max(0, 1 + (s.waterTemp - 20) * 0.03);
    s.volumeL = Math.max(1, s.volumeL - evapL); // la sal permanece → EC sube

    // --- Mezcla de dosis pendientes (primer orden)
    const f = 1 - Math.exp(-dtS / Math.max(1, p.mixingTauS));
    s.ecMass += s.pending.ecMass * f;
    s.ph += s.pending.ph * f;
    s.orp += s.pending.orp * f;
    s.volumeL += s.pending.volumeL * f;
    s.pending.ecMass *= 1 - f;
    s.pending.ph *= 1 - f;
    s.pending.orp *= 1 - f;
    s.pending.volumeL *= 1 - f;

    // --- Derivas (aproximadas)
    s.ph = clamp(s.ph + (p.phDriftPerH / 3600) * dtS, 0, 14);
    s.ecMass = Math.max(0, s.ecMass + ((p.ecDriftPerH * s.volumeL) / 3600) * dtS);
    s.orp += ((p.orpBaselineMv - s.orp) / (p.orpRelaxTauH * 3600)) * dtS;
  }
}
