/** Validación y comparación de perfiles ambientales. */
import type { Band, ProfileConfig } from './types';

export interface ProfileField {
  path: string;
  label: string;
  unit: string;
  get(p: ProfileConfig): unknown;
}

const band = (key: string, label: string, unit: string, get: (p: ProfileConfig) => Band): ProfileField[] => [
  { path: `${key}.target`, label: `${label} · objetivo`, unit, get: (p) => get(p).target },
  { path: `${key}.deadband`, label: `${label} · banda muerta / histéresis`, unit, get: (p) => get(p).deadband },
  { path: `${key}.alarmLow`, label: `${label} · alarma baja`, unit, get: (p) => get(p).alarmLow },
  { path: `${key}.alarmHigh`, label: `${label} · alarma alta`, unit, get: (p) => get(p).alarmHigh },
];

export const PROFILE_FIELDS: ProfileField[] = [
  ...band('reservoir.ph', 'pH', 'pH', (p) => p.reservoir.ph),
  ...band('reservoir.ec', 'EC', 'mS/cm', (p) => p.reservoir.ec),
  ...band('reservoir.orp', 'ORP', 'mV', (p) => p.reservoir.orp),
  ...band('reservoir.waterTemp', 'Temp. agua', '°C', (p) => p.reservoir.waterTemp),
  ...band('climate.airTemp', 'Temp. ambiente', '°C', (p) => p.climate.airTemp),
  ...band('climate.rh', 'HR', '%', (p) => p.climate.rh),
  { path: 'climate.fanOnHighRh', label: 'Ventilar si HR > alarma alta', unit: '', get: (p) => p.climate.fanOnHighRh },
  { path: 'climate.fanCycleOnMin', label: 'Ventilación periódica · ON', unit: 'min', get: (p) => p.climate.fanCycleOnMin },
  { path: 'climate.fanCycleOffMin', label: 'Ventilación periódica · OFF', unit: 'min', get: (p) => p.climate.fanCycleOffMin },
  { path: 'climate.lightsOverTempCutoff', label: 'Corte de luces por temperatura', unit: '°C', get: (p) => p.climate.lightsOverTempCutoff },
  { path: 'lights.onTime', label: 'Luces · hora de encendido', unit: 'HH:MM', get: (p) => p.lights.onTime },
  { path: 'lights.photoperiodH', label: 'Luces · fotoperiodo', unit: 'h', get: (p) => p.lights.photoperiodH },
  { path: 'dosing.abRatio', label: 'Relación B/A', unit: 'mL/mL', get: (p) => p.dosing.abRatio },
  { path: 'dosing.additives.silicon', label: 'Silicio por mL de A', unit: 'mL/mL', get: (p) => p.dosing.additives.silicon },
  { path: 'dosing.additives.bloom', label: 'Bloom por mL de A', unit: 'mL/mL', get: (p) => p.dosing.additives.bloom },
  { path: 'dosing.additives.pk', label: 'PK por mL de A', unit: 'mL/mL', get: (p) => p.dosing.additives.pk },
  { path: 'automation.ph', label: 'Automatizar pH', unit: '', get: (p) => p.automation.ph },
  { path: 'automation.ec', label: 'Automatizar EC', unit: '', get: (p) => p.automation.ec },
  { path: 'automation.orp', label: 'Automatizar ORP', unit: '', get: (p) => p.automation.orp },
  { path: 'automation.climate', label: 'Automatizar clima', unit: '', get: (p) => p.automation.climate },
  { path: 'automation.lights', label: 'Automatizar luces', unit: '', get: (p) => p.automation.lights },
];

export interface ProfileDiff {
  path: string;
  label: string;
  unit: string;
  a: unknown;
  b: unknown;
}

export function diffProfiles(a: ProfileConfig, b: ProfileConfig): ProfileDiff[] {
  return PROFILE_FIELDS.filter((f) => JSON.stringify(f.get(a)) !== JSON.stringify(f.get(b))).map((f) => ({
    path: f.path,
    label: f.label,
    unit: f.unit,
    a: f.get(a),
    b: f.get(b),
  }));
}

/** Devuelve la lista de problemas que impiden validar el perfil (vacía = válido). */
export function profileProblems(p: ProfileConfig): string[] {
  const out: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) out.push(msg);
  };
  const checkBand = (b: Band, name: string, lo: number, hi: number, control: boolean) => {
    if (control) {
      need(b.target !== null, `${name}: falta objetivo`);
      need(b.deadband !== null, `${name}: falta banda muerta`);
    }
    if (b.deadband !== null) need(b.deadband > 0, `${name}: la banda muerta debe ser > 0`);
    for (const [k, v] of [['objetivo', b.target], ['alarma baja', b.alarmLow], ['alarma alta', b.alarmHigh]] as const)
      if (v !== null) need(v >= lo && v <= hi, `${name}: ${k} fuera del rango ${lo}…${hi}`);
    if (b.alarmLow !== null && b.alarmHigh !== null) need(b.alarmLow < b.alarmHigh, `${name}: alarma baja ≥ alarma alta`);
    if (b.target !== null && b.alarmLow !== null) need(b.target > b.alarmLow, `${name}: objetivo ≤ alarma baja`);
    if (b.target !== null && b.alarmHigh !== null) need(b.target < b.alarmHigh, `${name}: objetivo ≥ alarma alta`);
  };
  checkBand(p.reservoir.ph, 'pH', 0, 14, p.automation.ph);
  checkBand(p.reservoir.ec, 'EC', 0, 20, p.automation.ec);
  checkBand(p.reservoir.orp, 'ORP', -1000, 1000, p.automation.orp);
  checkBand(p.reservoir.waterTemp, 'Temp. agua', -10, 60, false);
  checkBand(p.climate.airTemp, 'Temp. ambiente', -10, 60, p.automation.climate);
  checkBand(p.climate.rh, 'HR', 0, 100, p.automation.climate);
  if (p.automation.ec) need(p.dosing.abRatio !== null && p.dosing.abRatio >= 0, 'Dosificación: falta relación B/A');
  if (p.automation.lights) {
    need(p.lights.onTime !== null && /^\d{1,2}:\d{2}$/.test(p.lights.onTime), 'Luces: hora de encendido inválida');
    need(p.lights.photoperiodH !== null && p.lights.photoperiodH >= 0 && p.lights.photoperiodH <= 24, 'Luces: fotoperiodo entre 0 y 24 h');
  }
  return out;
}

/** Asigna un valor en una ruta "a.b.c" del perfil. */
export function setProfilePath(p: ProfileConfig, path: string, value: unknown): void {
  const parts = path.split('.');
  let o = p as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] as Record<string, unknown>;
  o[parts[parts.length - 1]] = value;
}
