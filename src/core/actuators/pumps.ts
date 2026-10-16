/** Gestión del estado de las bombas dosificadoras (independiente del origen de la orden). */
import type { DoseOrigin, PumpConfig, PumpId, PumpRuntime } from '../types';
import { DAY } from '../util';

export function createPumpRuntime(cfg: PumpConfig): PumpRuntime {
  return {
    running: false,
    origin: null,
    runStartedAt: null,
    plannedDurationS: null,
    deliveredThisRunMl: 0,
    reason: '',
    lastRunEndAt: null,
    levelMl: cfg.containerCapacityMl,
    primed: false,
    locked: false,
    lockReason: '',
    totalDosedMl: 0,
    opCount: 0,
    lastOpMl: 0,
    doseLog: [],
  };
}

export interface PumpHooks {
  /** Entrega de líquido al depósito (no se llama durante el cebado). */
  deliver(id: PumpId, ml: number): void;
  onStop(id: PumpId, rt: PumpRuntime, why: string): void;
  onEmpty(id: PumpId): void;
  onMaxRun(id: PumpId): void;
}

export function startPump(
  rt: PumpRuntime,
  now: number,
  plannedDurationS: number | null,
  origin: DoseOrigin,
  reason: string,
): void {
  rt.running = true;
  rt.origin = origin;
  rt.runStartedAt = now;
  rt.plannedDurationS = plannedDurationS;
  rt.deliveredThisRunMl = 0;
  rt.reason = reason;
}

export function stopPump(id: PumpId, rt: PumpRuntime, now: number, why: string, hooks: PumpHooks): void {
  if (!rt.running) return;
  rt.running = false;
  rt.lastRunEndAt = now;
  const ml = rt.deliveredThisRunMl;
  if (rt.origin === 'prime') {
    rt.primed = rt.levelMl > 0;
  } else if (ml > 0) {
    rt.opCount++;
    rt.lastOpMl = ml;
    rt.totalDosedMl += ml;
  }
  if (ml > 0) rt.doseLog.push({ t: now, ml, origin: rt.origin ?? 'manual_test' });
  rt.doseLog = rt.doseLog.filter((d) => d.t >= now - 2 * DAY);
  hooks.onStop(id, rt, why);
  rt.origin = null;
  rt.runStartedAt = null;
  rt.plannedDurationS = null;
}

/**
 * Avanza una bomba `dtS` segundos. Incluye el corte duro por tiempo máximo,
 * independiente de quién dio la orden.
 */
export function stepPump(id: PumpId, cfg: PumpConfig, rt: PumpRuntime, now: number, dtS: number, hooks: PumpHooks): void {
  if (!rt.running || rt.runStartedAt === null) return;
  const elapsed = (now - rt.runStartedAt) / 1000;
  const remainingPlanned = rt.plannedDurationS === null ? dtS : Math.max(0, rt.plannedDurationS - (elapsed - dtS));
  const runS = Math.min(dtS, remainingPlanned);
  const want = (cfg.flowMlPerMin / 60) * runS;
  const ml = Math.min(want, Math.max(0, rt.levelMl));
  rt.levelMl -= ml;
  rt.deliveredThisRunMl += ml;
  if (rt.origin !== 'prime') hooks.deliver(id, ml);

  if (rt.levelMl <= cfg.emptyThresholdMl) {
    rt.primed = false;
    stopPump(id, rt, now, 'Recipiente vacío', hooks);
    hooks.onEmpty(id);
    return;
  }
  if (elapsed >= cfg.maxRunS && (rt.plannedDurationS === null || rt.plannedDurationS > cfg.maxRunS)) {
    stopPump(id, rt, now, `Tiempo máximo de funcionamiento alcanzado (${cfg.maxRunS} s)`, hooks);
    hooks.onMaxRun(id);
    return;
  }
  if (rt.plannedDurationS !== null && elapsed >= rt.plannedDurationS - 1e-9) {
    stopPump(id, rt, now, 'Operación completada', hooks);
  }
}
