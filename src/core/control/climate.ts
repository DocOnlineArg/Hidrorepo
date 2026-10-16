/**
 * Control ambiental con histéresis, tiempos mínimos e interbloqueos.
 *
 * Regla de histéresis (con objetivo T y banda muerta B):
 *  - Humidificador: ON si HR < T − B; OFF cuando HR ≥ T.
 *  - Deshumidificador: ON si HR > T + B; OFF cuando HR ≤ T.
 *  - Ventilador (temperatura): ON si Ta > T + B; OFF cuando Ta ≤ T.
 */
import type { ClimateConfig, ProfileConfig, RelayId, RelayRuntime, SensorId, SensorRuntime, SystemMode } from '../types';
import { RELAY_IDS } from '../types';
import { isUsable } from '../sensors/sensor';
import { minuteOfDay } from '../util';
import { scheduleInfo } from './lights';

export interface RelayDecision {
  on: boolean;
  reason: string;
  condition: string;
  /** Orden de seguridad: ignora tiempos mínimos. */
  force: boolean;
}

export interface ClimateContext {
  now: number;
  profile: ProfileConfig;
  climate: ClimateConfig;
  relays: Record<RelayId, RelayRuntime>;
  sensors: Record<SensorId, SensorRuntime>;
  mode: SystemMode;
  automationEnabled: boolean;
  safeState: boolean;
  lightsOverTemp: boolean;
}

export interface ClimateResult {
  decisions: Record<RelayId, RelayDecision>;
  interlockConflict: boolean;
  lightsOverTemp: boolean;
}

export function createRelayRuntime(): RelayRuntime {
  return { on: false, lastChangeAt: null, onTimeTotalS: 0, cycles: 0, reason: 'Inicial', condition: '—' };
}

const fmt = (v: number | null, d = 1) => (v === null ? '—' : v.toFixed(d));

export function decideClimate(ctx: ClimateContext): ClimateResult {
  const { profile: p, climate: c, relays, sensors } = ctx;
  const d = {} as Record<RelayId, RelayDecision>;
  let lightsOverTemp = ctx.lightsOverTemp;

  if (ctx.safeState) {
    for (const id of RELAY_IDS) d[id] = { on: false, reason: 'Estado seguro: todas las salidas apagadas', condition: 'estado seguro', force: true };
    return { decisions: d, interlockConflict: false, lightsOverTemp };
  }

  const rh = sensors.rh.reading;
  const ta = sensors.airTemp.reading;
  const rhOk = isUsable(rh);
  const taOk = isUsable(ta);
  const profileOk = p.validated && p.automation.climate;
  const autoActive = ctx.mode !== 'manual' && ctx.automationEnabled;

  const manual = (id: RelayId): RelayDecision | null => {
    const rc = c[id];
    if (ctx.mode === 'manual' || rc.mode === 'manual')
      return { on: rc.manualOn, reason: 'Control manual del operador', condition: 'manual', force: false };
    return null;
  };

  // --- Humidificador / deshumidificador
  const rhT = p.climate.rh.target;
  const rhB = p.climate.rh.deadband;
  for (const id of ['humidifier', 'dehumidifier'] as const) {
    const m = manual(id);
    if (m) {
      d[id] = m;
      continue;
    }
    const isHum = id === 'humidifier';
    const cond =
      rhT === null || rhB === null
        ? 'objetivo HR sin configurar'
        : isHum
          ? `ON si HR < ${fmt(rhT - rhB)} % · OFF si HR ≥ ${fmt(rhT)} %`
          : `ON si HR > ${fmt(rhT + rhB)} % · OFF si HR ≤ ${fmt(rhT)} %`;
    if (!autoActive) d[id] = { on: false, reason: 'Automatización desactivada', condition: cond, force: false };
    else if (!profileOk) d[id] = { on: false, reason: 'Perfil sin validar o clima no automatizado', condition: cond, force: false };
    else if (rhT === null || rhB === null) d[id] = { on: false, reason: 'Objetivo de HR sin configurar', condition: cond, force: false };
    else if (!rhOk) d[id] = { on: false, reason: `Sensor HR no válido (${rh.status}) → apagado seguro`, condition: cond, force: true };
    else {
      const v = rh.value as number;
      const cur = relays[id].on;
      let on: boolean;
      if (isHum) on = cur ? v < rhT : v < rhT - rhB;
      else on = cur ? v > rhT : v > rhT + rhB;
      d[id] = { on, reason: `HR ${fmt(v)} % (objetivo ${fmt(rhT)} ± ${fmt(rhB)})`, condition: cond, force: false };
    }
  }

  // --- Interbloqueo humidificador/deshumidificador (también para órdenes manuales)
  let interlockConflict = false;
  if (d.humidifier.on && d.dehumidifier.on && !c.allowHumDehumSimultaneous) {
    interlockConflict = true;
    let keep: 'humidifier' | 'dehumidifier';
    if (relays.humidifier.on !== relays.dehumidifier.on) keep = relays.humidifier.on ? 'humidifier' : 'dehumidifier';
    else if (rhOk && rhT !== null) keep = (rh.value as number) < rhT ? 'humidifier' : 'dehumidifier';
    else keep = 'dehumidifier';
    const drop = keep === 'humidifier' ? 'dehumidifier' : 'humidifier';
    d[drop] = {
      on: false,
      reason: `Interbloqueo: ${keep === 'humidifier' ? 'humidificador' : 'deshumidificador'} activo, orden simultánea rechazada`,
      condition: d[drop].condition,
      force: true,
    };
  }

  // --- Ventilador
  {
    const m = manual('fan');
    const tT = p.climate.airTemp.target;
    const tB = p.climate.airTemp.deadband;
    const condParts: string[] = [];
    if (tT !== null && tB !== null) condParts.push(`ON si Ta > ${fmt(tT + tB)} °C · OFF si Ta ≤ ${fmt(tT)} °C`);
    if (p.climate.fanOnHighRh && p.climate.rh.alarmHigh !== null) condParts.push(`ON si HR > ${fmt(p.climate.rh.alarmHigh)} %`);
    if (p.climate.fanCycleOnMin && p.climate.fanCycleOffMin)
      condParts.push(`ciclo ${p.climate.fanCycleOnMin}/${p.climate.fanCycleOffMin} min`);
    const cond = condParts.join(' | ') || 'sin reglas configuradas';
    if (m) d.fan = m;
    else if (!autoActive) d.fan = { on: false, reason: 'Automatización desactivada', condition: cond, force: false };
    else if (!profileOk) d.fan = { on: false, reason: 'Perfil sin validar o clima no automatizado', condition: cond, force: false };
    else if (!taOk && tT !== null) {
      const on = c.fan.onSensorFault === 'on';
      d.fan = { on, reason: `Sensor de temperatura no válido → estado de fallo configurado (${on ? 'ON' : 'OFF'})`, condition: cond, force: true };
    } else {
      const reasons: string[] = [];
      let on = false;
      if (taOk && tT !== null && tB !== null) {
        const v = ta.value as number;
        const tempOn = relays.fan.on ? v > tT : v > tT + tB;
        if (tempOn) reasons.push(`Ta ${fmt(v)} °C sobre objetivo`);
        on ||= tempOn;
      }
      if (p.climate.fanOnHighRh && rhOk && p.climate.rh.alarmHigh !== null && (rh.value as number) > p.climate.rh.alarmHigh) {
        reasons.push(`HR ${fmt(rh.value)} % sobre límite`);
        on = true;
      }
      const onM = p.climate.fanCycleOnMin;
      const offM = p.climate.fanCycleOffMin;
      if (onM && offM && onM > 0 && offM >= 0) {
        if (minuteOfDay(ctx.now) % (onM + offM) < onM) {
          reasons.push('ventilación periódica');
          on = true;
        }
      }
      d.fan = { on, reason: reasons.join(', ') || 'Condiciones normales', condition: cond, force: false };
    }
  }

  // --- Luces (temporizador; no es lazo de realimentación)
  {
    const m = manual('lights');
    const info = scheduleInfo(p.lights, ctx.now);
    const cond = info.configured ? `Encendido ${p.lights.onTime} · ${info.lightH} h luz / ${info.darkH} h oscuridad` : 'horario sin configurar';
    const cutoff = p.climate.lightsOverTempCutoff;
    if (taOk && cutoff !== null) {
      const v = ta.value as number;
      if (v > cutoff) lightsOverTemp = true;
      else if (v < cutoff - 2) lightsOverTemp = false;
    } else if (cutoff === null) lightsOverTemp = false;
    if (m) d.lights = m;
    else if (!p.validated || !p.automation.lights) d.lights = { on: false, reason: 'Perfil sin validar o iluminación no automatizada', condition: cond, force: false };
    else if (!info.configured) d.lights = { on: false, reason: 'Horario de iluminación sin configurar', condition: cond, force: false };
    else if (lightsOverTemp && info.on)
      d.lights = { on: false, reason: `Protección por sobretemperatura (> ${cutoff} °C)`, condition: cond, force: true };
    else d.lights = { on: info.on, reason: info.on ? 'Dentro del fotoperiodo' : 'Fuera del fotoperiodo', condition: cond, force: false };
  }

  return { decisions: d, interlockConflict, lightsOverTemp };
}

/** Aplica una decisión respetando tiempos mínimos ON/OFF (anti ciclos cortos). Devuelve true si cambió. */
export function applyRelayDecision(
  rt: RelayRuntime,
  dec: RelayDecision,
  minOnS: number,
  minOffS: number,
  now: number,
): boolean {
  rt.condition = dec.condition;
  if (dec.on === rt.on) {
    rt.reason = dec.reason;
    return false;
  }
  if (!dec.force && rt.lastChangeAt !== null) {
    const since = (now - rt.lastChangeAt) / 1000;
    const min = rt.on ? minOnS : minOffS;
    if (since < min) {
      rt.reason = `${dec.reason} · esperando tiempo mínimo ${rt.on ? 'ON' : 'OFF'} (${Math.ceil(min - since)} s)`;
      return false;
    }
  }
  rt.on = dec.on;
  rt.lastChangeAt = now;
  if (dec.on) rt.cycles++;
  rt.reason = dec.reason;
  return true;
}
