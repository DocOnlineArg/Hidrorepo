/**
 * Capa de seguridad de dosificación: compatibilidad química, interbloqueos,
 * permisos por origen de la orden y subsistema independiente del oxidante.
 *
 * Toda orden de arranque de bomba (automática, prueba manual, cebado) pasa por
 * `evaluatePumpStart`. El controlador no puede saltarse esta capa.
 */
import type {
  CompatStatus,
  DoseOrigin,
  PumpId,
  PumpRuntime,
  SensorId,
  SensorRuntime,
  SystemConfig,
  SystemMode,
} from '../types';
import { PUMP_IDS } from '../types';
import { DAY, pairKey } from '../util';
import { isUsable } from '../sensors/sensor';

export interface SafetyContext {
  now: number;
  config: SystemConfig;
  pumps: Record<PumpId, PumpRuntime>;
  sensors: Record<SensorId, SensorRuntime>;
  mode: SystemMode;
  automationEnabled: boolean;
  safeState: boolean;
  estop: boolean;
  hardwareArmed: boolean;
}

export interface Verdict {
  ok: boolean;
  reasons: string[];
}

/** Sensores de los que depende la dosificación automática de cada bomba. */
export const RELEVANT_SENSORS: Record<PumpId, SensorId[]> = {
  phUp: ['ph'],
  phDown: ['ph'],
  oxidant: ['orp', 'ph'],
  solA: ['ec'],
  solB: ['ec'],
  bloom: ['ec'],
  silicon: ['ec'],
  pk: ['ec'],
};

export function compatStatus(cfg: SystemConfig, a: PumpId, b: PumpId): CompatStatus {
  if (a === b) return 'compatible';
  return cfg.compatibility.pairs[pairKey(a, b)]?.status ?? 'unknown';
}

export function dosedInWindow(rt: PumpRuntime, now: number, windowMs: number): number {
  return rt.doseLog.filter((d) => d.t >= now - windowMs && d.origin !== 'prime').reduce((a, d) => a + d.ml, 0);
}

/** Tiempo (ms) desde el último uso de cualquier bomba distinta de `except`, o 0 si alguna funciona. */
function sinceOtherPumps(ctx: SafetyContext, filter: (id: PumpId) => boolean): number {
  let since = Infinity;
  for (const id of PUMP_IDS) {
    if (!filter(id)) continue;
    const p = ctx.pumps[id];
    if (p.running) return 0;
    if (p.lastRunEndAt !== null) since = Math.min(since, ctx.now - p.lastRunEndAt);
  }
  return since;
}

/** Subsistema de seguridad independiente para el oxidante. */
export function evaluateOxidant(ctx: SafetyContext, ml: number, origin: DoseOrigin): Verdict {
  const g = ctx.config.oxidantGuard;
  const reasons: string[] = [];
  const rt = ctx.pumps.oxidant;
  if (!g.enabled || !g.acknowledgedWarning)
    reasons.push('Subsistema de desinfección deshabilitado: requiere habilitación explícita y aceptar advertencias');
  if (origin === 'manual_hold') reasons.push('El oxidante no admite accionamiento mantenido');
  if (origin !== 'prime' && ml > g.maxDoseMl) reasons.push(`Dosis ${ml.toFixed(1)} mL > máximo por operación (${g.maxDoseMl} mL)`);
  const daily = dosedInWindow(rt, ctx.now, DAY);
  if (origin !== 'prime' && daily + ml > g.maxDailyMl)
    reasons.push(`Límite diario: ${daily.toFixed(1)} + ${ml.toFixed(1)} mL > ${g.maxDailyMl} mL`);
  const since = sinceOtherPumps(ctx, (id) => id !== 'oxidant');
  if (since < g.separationS * 1000)
    reasons.push(
      since === 0
        ? 'Otra bomba en funcionamiento: no se mezcla oxidante con otros productos'
        : `Separación insuficiente con otra dosificación (${Math.round(since / 1000)} s < ${g.separationS} s)`,
    );
  const orp = ctx.sensors.orp.reading;
  if (orp.value !== null && isUsable(orp) && orp.value >= g.orpHardMaxMv)
    reasons.push(`ORP ${orp.value.toFixed(0)} mV ≥ límite absoluto ${g.orpHardMaxMv} mV`);
  if (origin === 'auto') {
    if (!isUsable(orp)) reasons.push('ORP sin lectura válida y calibrada');
    if (!isUsable(ctx.sensors.ph.reading)) reasons.push('pH sin lectura válida (el ORP depende del pH)');
    const chk = g.lastIndependentCheckAt;
    if (chk === null || ctx.now - chk > g.independentCheckValidityH * 3600_000)
      reasons.push('Falta verificación independiente vigente (el ORP no determina por sí solo una concentración segura)');
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Evalúa si una bomba puede arrancar. `ml` es el volumen previsto
 * (para 'manual_hold' se usa el máximo que permitiría maxRunS).
 */
export function evaluatePumpStart(ctx: SafetyContext, id: PumpId, ml: number, origin: DoseOrigin): Verdict {
  const cfg = ctx.config;
  const pc = cfg.pumps[id];
  const rt = ctx.pumps[id];
  const reasons: string[] = [];

  if (ctx.estop) reasons.push('Paro de emergencia activo');
  if (ctx.safeState) reasons.push('Estado seguro activo: salidas bloqueadas');
  if (ctx.mode === 'hardware' && !ctx.hardwareArmed) reasons.push('Salidas de hardware no habilitadas (armado requerido)');
  if (!pc.enabled) reasons.push('Bomba deshabilitada en configuración');
  if (rt.locked) reasons.push(`Bloqueo de seguridad: ${rt.lockReason || 'manual'}`);
  if (rt.running) reasons.push('La bomba ya está en funcionamiento');
  if (rt.levelMl <= pc.emptyThresholdMl) reasons.push('Recipiente vacío o por debajo del umbral');
  else if (origin !== 'manual_hold' && rt.levelMl - ml < 0) reasons.push('Volumen insuficiente en el recipiente');
  if (pc.flowMlPerMin <= 0) reasons.push('Caudal no configurado');
  const durS = pc.flowMlPerMin > 0 ? (ml / pc.flowMlPerMin) * 60 : Infinity;
  if (origin !== 'manual_hold' && durS > pc.maxRunS)
    reasons.push(`Duración ${durS.toFixed(0)} s supera el máximo (${pc.maxRunS} s)`);

  // Concurrencia y compatibilidad química.
  for (const other of PUMP_IDS) {
    if (other === id || !ctx.pumps[other].running) continue;
    if (!cfg.compatibility.allowSimultaneousDosing) {
      reasons.push(`Dosificación simultánea deshabilitada (${cfg.pumps[other].label} en marcha)`);
      continue;
    }
    const st = compatStatus(cfg, id, other);
    if (st === 'incompatible') reasons.push(`Combinación incompatible con ${cfg.liquids[other].name}`);
    else if (st === 'unknown')
      reasons.push(`Compatibilidad con ${cfg.liquids[other].name} desconocida: bloqueado hasta validación`);
  }

  // Separación con el oxidante (para cualquier producto que no sea el propio oxidante).
  if (id !== 'oxidant') {
    const ox = ctx.pumps.oxidant;
    const sep = cfg.oxidantGuard.separationS * 1000;
    if (!ox.running && ox.lastRunEndAt !== null && ctx.now - ox.lastRunEndAt < sep)
      reasons.push(`Separación con oxidante insuficiente (${Math.round((ctx.now - ox.lastRunEndAt) / 1000)} s < ${cfg.oxidantGuard.separationS} s)`);
  } else {
    reasons.push(...evaluateOxidant(ctx, ml, origin).reasons);
  }

  if (origin === 'auto') {
    if (ctx.mode === 'manual') reasons.push('Modo manual: automatización suspendida');
    if (!ctx.automationEnabled) reasons.push('Automatización desactivada');
    if (!rt.primed) reasons.push('Bomba sin cebar');
    if (rt.lastRunEndAt !== null && ctx.now - rt.lastRunEndAt < pc.minIntervalS * 1000)
      reasons.push(`Intervalo mínimo no cumplido (${Math.round((ctx.now - rt.lastRunEndAt) / 1000)} s < ${pc.minIntervalS} s)`);
    for (const s of RELEVANT_SENSORS[id]) {
      const r = ctx.sensors[s].reading;
      if (!isUsable(r)) reasons.push(`${cfg.sensors[s].label}: ${r.status} (${r.message})`);
    }
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * Vigilancia en ejecución del oxidante (independiente del controlador):
 * devuelve un motivo de parada o null.
 */
export function oxidantRuntimeCheck(ctx: SafetyContext): string | null {
  const rt = ctx.pumps.oxidant;
  if (!rt.running) return null;
  const g = ctx.config.oxidantGuard;
  if (!g.enabled || !g.acknowledgedWarning) return 'Subsistema de desinfección deshabilitado durante la operación';
  for (const id of PUMP_IDS) if (id !== 'oxidant' && ctx.pumps[id].running) return 'Otra bomba arrancó durante la dosificación de oxidante';
  if (rt.deliveredThisRunMl > g.maxDoseMl + 1e-6) return `Volumen por operación superado (${g.maxDoseMl} mL)`;
  const orp = ctx.sensors.orp.reading;
  if (orp.value !== null && isUsable(orp) && orp.value >= g.orpHardMaxMv) return `ORP alcanzó el límite absoluto (${g.orpHardMaxMv} mV)`;
  return null;
}
