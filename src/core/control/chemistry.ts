/**
 * Controlador de pH, EC y ORP.
 *
 * Ciclo de cada lazo (solo un lazo puede corregir a la vez, porque comparten depósito):
 *   idle → confirming (la desviación debe persistir `confirmS`) → dosing (secuencia
 *   de bombas, con separación entre productos) → mixing (`mixS`) → stabilizing
 *   (espera mínima + desviación estándar bajo tolerancia) → medición → idle.
 *
 * La dosis se calcula con la ESTIMACIÓN del controlador (configurable), nunca con
 * valores universales; sin estimación, el lazo no dosifica.
 */
import type {
  Decision,
  DoseOrigin,
  LoopId,
  LoopRuntime,
  ProfileConfig,
  PumpId,
  SensorId,
  SensorRuntime,
  SystemConfig,
} from '../types';
import type { AlarmManager } from '../alarms';
import type { SafetyContext, Verdict } from '../safety/safety';
import { evaluatePumpStart } from '../safety/safety';
import { isUsable, windowStddev } from '../sensors/sensor';
import { HOUR, clamp } from '../util';

export interface ChemContext {
  now: number;
  config: SystemConfig;
  profile: ProfileConfig;
  sensors: Record<SensorId, SensorRuntime>;
  safety: SafetyContext;
  alarms: AlarmManager;
  autoAllowed: boolean;
  startPump(id: PumpId, ml: number, origin: DoseOrigin, reason: string): Verdict;
  isPumpRunning(id: PumpId): boolean;
}

export const LOOP_LABEL: Record<LoopId, string> = { ph: 'pH', ec: 'EC', orp: 'ORP' };

export function createLoopRuntime(now: number): LoopRuntime {
  return {
    phase: 'idle',
    phaseSince: now,
    confirmSince: null,
    sequence: [],
    mixUntil: null,
    valueBefore: null,
    expectedChange: null,
    correctionTimes: [],
    noProgressCount: 0,
    lastReason: '',
  };
}

export class ChemistryController {
  loops: Record<LoopId, LoopRuntime>;
  activeLoop: LoopId | null = null;
  decisions: Decision[] = [];
  private nextId = 1;

  constructor(now: number) {
    this.loops = { ph: createLoopRuntime(now), ec: createLoopRuntime(now), orp: createLoopRuntime(now) };
  }

  private setPhase(id: LoopId, phase: LoopRuntime['phase'], now: number): void {
    const L = this.loops[id];
    if (L.phase !== phase) {
      L.phase = phase;
      L.phaseSince = now;
    }
  }

  private decide(ctx: ChemContext, id: LoopId, action: Decision['action'], justification: string[], force = false): void {
    const L = this.loops[id];
    const key = action + ':' + justification.join('|');
    if (!force && key === L.lastReason) return;
    L.lastReason = key;
    const r = ctx.sensors[id].reading;
    this.decisions.push({
      id: this.nextId++,
      t: ctx.now,
      loop: id,
      action,
      value: r.value,
      target: ctx.profile.reservoir[id].target,
      justification,
    });
    if (this.decisions.length > 500) this.decisions.splice(0, this.decisions.length - 500);
  }

  resetLoop(id: LoopId, now: number): void {
    const L = this.loops[id];
    L.noProgressCount = 0;
    L.confirmSince = null;
    L.lastReason = '';
    this.setPhase(id, 'idle', now);
    if (this.activeLoop === id) this.activeLoop = null;
  }

  /** Aborta cualquier corrección en curso (cambio de modo, estado seguro…). */
  abortAll(now: number, why: string): void {
    for (const id of Object.keys(this.loops) as LoopId[]) {
      const L = this.loops[id];
      if (L.phase !== 'locked_out') this.setPhase(id, 'disabled', now);
      L.sequence = [];
      L.confirmSince = null;
      L.lastReason = why;
    }
    this.activeLoop = null;
  }

  step(ctx: ChemContext): void {
    if (!ctx.autoAllowed) {
      if (this.activeLoop !== null || Object.values(this.loops).some((l) => l.phase !== 'disabled' && l.phase !== 'locked_out'))
        this.abortAll(ctx.now, 'Automatización no permitida');
      return;
    }
    if (this.activeLoop) this.stepActive(ctx, this.activeLoop);
    for (const id of ctx.config.control.order) {
      if (id === this.activeLoop) continue;
      this.evaluate(ctx, id);
    }
  }

  // ------------------------------------------------------------------ lazo activo
  private stepActive(ctx: ChemContext, id: LoopId): void {
    const L = this.loops[id];
    const lc = ctx.config.control.loops[id];
    const now = ctx.now;
    const reading = ctx.sensors[id].reading;

    if (L.phase === 'dosing') {
      for (let i = 0; i < L.sequence.length; i++) {
        const st = L.sequence[i];
        if (st.done) continue;
        if (st.startAt === null) {
          const prevEnd = i === 0 ? null : L.sequence[i - 1].endAt;
          const gapOk = i === 0 || (prevEnd !== null && now - prevEnd >= ctx.config.control.sequenceGapS * 1000);
          if (!gapOk) break;
          const v = ctx.startPump(st.pump, st.ml, 'auto', `Corrección ${LOOP_LABEL[id]}`);
          if (!v.ok) {
            this.decide(ctx, id, 'blocked', [`Secuencia interrumpida en ${ctx.config.liquids[st.pump].name}`, ...v.reasons], true);
            L.sequence = [];
            this.setPhase(id, 'mixing', now); // lo ya dosificado debe mezclarse igualmente
            L.mixUntil = now + lc.mixS * 1000;
            return;
          }
          st.startAt = now;
          break;
        }
        if (!ctx.isPumpRunning(st.pump)) {
          st.done = true;
          st.endAt = now;
          continue;
        }
        break;
      }
      if (L.sequence.length > 0 && L.sequence.every((s) => s.done)) {
        this.setPhase(id, 'mixing', now);
        L.mixUntil = now + lc.mixS * 1000;
        this.decide(ctx, id, 'wait', [`Dosificación completada; mezcla durante ${lc.mixS} s antes de medir`], true);
      }
      return;
    }

    if (L.phase === 'mixing') {
      if (L.mixUntil !== null && now >= L.mixUntil) {
        this.setPhase(id, 'stabilizing', now);
        this.decide(ctx, id, 'wait', [`Mezcla terminada; esperando estabilización (mín. ${lc.stabilizeS} s, σ ≤ ${lc.stabilityTolerance})`], true);
      }
      return;
    }

    if (L.phase === 'stabilizing') {
      const elapsed = (now - L.phaseSince) / 1000;
      if (!isUsable(reading)) {
        this.decide(ctx, id, 'blocked', [`Sensor no válido durante la estabilización (${reading.status}); se cancela la evaluación`], true);
        this.finishActive(id, now);
        return;
      }
      const cfgS = ctx.config.sensors[id];
      const { sd, n } = windowStddev(ctx.sensors[id], cfgS.stabilityWindowS, now);
      if (elapsed >= lc.stabilizeS && n >= 5 && sd <= lc.stabilityTolerance) {
        const after = reading.value as number;
        const change = L.valueBefore !== null ? after - L.valueBefore : 0;
        const exp = L.expectedChange ?? 0;
        const progressed = exp === 0 || Math.sign(change) === Math.sign(exp) && Math.abs(change) >= 0.2 * Math.abs(exp);
        L.noProgressCount = progressed ? 0 : L.noProgressCount + 1;
        this.decide(
          ctx,
          id,
          'measure',
          [
            `Nueva medición estable: ${after.toFixed(3)} (antes ${L.valueBefore?.toFixed(3) ?? '—'})`,
            `Cambio observado ${change.toFixed(3)} vs esperado ${exp.toFixed(3)} según la estimación del controlador`,
            progressed ? 'Respuesta coherente' : `Respuesta insuficiente (${L.noProgressCount}/${lc.noProgressLimit})`,
          ],
          true,
        );
        if (L.noProgressCount >= lc.noProgressLimit) {
          this.setPhase(id, 'locked_out', now);
          this.activeLoop = null;
          ctx.alarms.raise(now, {
            key: `LOOP_LOCKOUT_${id}`,
            code: 'LOOP_LOCKOUT',
            severity: 'critical',
            source: `Lazo ${LOOP_LABEL[id]}`,
            message: `Lazo ${LOOP_LABEL[id]} bloqueado: las correcciones no producen efecto`,
            cause: `${L.noProgressCount} correcciones consecutivas sin respuesta (sensor, bomba, recipiente o modelo incorrectos)`,
            actionTaken: 'Dosificación automática del lazo bloqueada hasta revisión y rearme manual',
          });
          return;
        }
        this.finishActive(id, now);
        return;
      }
      if (elapsed >= lc.stabilizeMaxS) {
        ctx.alarms.raise(now, {
          key: `LOOP_UNSTABLE_${id}`,
          code: 'MEASUREMENT_UNSTABLE',
          severity: 'warning',
          source: `Lazo ${LOOP_LABEL[id]}`,
          message: `Medición de ${LOOP_LABEL[id]} inestable tras la dosificación`,
          cause: `σ = ${sd.toFixed(3)} > ${lc.stabilityTolerance} durante ${lc.stabilizeMaxS} s`,
          actionTaken: 'No se decide nueva corrección hasta confirmar de nuevo la desviación',
        });
        this.decide(ctx, id, 'wait', ['Estabilización no alcanzada; se reinicia la confirmación'], true);
        this.finishActive(id, now);
      }
    }
  }

  private finishActive(id: LoopId, now: number): void {
    const L = this.loops[id];
    L.sequence = [];
    L.confirmSince = null;
    L.mixUntil = null;
    this.setPhase(id, 'idle', now);
    if (this.activeLoop === id) this.activeLoop = null;
  }

  // ------------------------------------------------------------------ evaluación
  private evaluate(ctx: ChemContext, id: LoopId): void {
    const L = this.loops[id];
    const now = ctx.now;
    if (L.phase === 'locked_out') return;
    const p = ctx.profile;
    const band = p.reservoir[id];
    const lc = ctx.config.control.loops[id];
    const label = LOOP_LABEL[id];

    const disable = (why: string) => {
      this.setPhase(id, 'disabled', now);
      L.confirmSince = null;
      this.decide(ctx, id, 'idle', [why]);
    };
    if (!p.validated) return disable('Perfil activo no validado: sin control automático');
    if (!p.automation[id]) return disable(`Control automático de ${label} desactivado en el perfil`);
    if (band.target === null || band.deadband === null) return disable(`Objetivo o banda muerta de ${label} sin configurar`);

    const r = ctx.sensors[id].reading;
    if (!isUsable(r)) {
      this.setPhase(id, 'blocked', now);
      L.confirmSince = null;
      this.decide(ctx, id, 'blocked', [`Sensor de ${label} no apto para control: ${r.status} — ${r.message}`]);
      return;
    }
    const value = r.value as number;
    const err = band.target - value;
    if (Math.abs(err) <= band.deadband) {
      this.setPhase(id, 'idle', now);
      L.confirmSince = null;
      ctx.alarms.clear(now, `HIGH_NO_ACTION_${id}`);
      this.decide(ctx, id, 'idle', [`${label} dentro de la banda muerta (${band.target} ± ${band.deadband})`]);
      return;
    }

    if ((id === 'ec' || id === 'orp') && err < 0) {
      this.setPhase(id, 'blocked', now);
      L.confirmSince = null;
      ctx.alarms.raise(now, {
        key: `HIGH_NO_ACTION_${id}`,
        code: id === 'ec' ? 'EC_ABOVE_TARGET' : 'ORP_ABOVE_TARGET',
        severity: 'warning',
        source: `Lazo ${label}`,
        message: `${label} por encima del objetivo sin acción automática disponible`,
        cause: `${label} = ${value.toFixed(id === 'ec' ? 3 : 0)} > ${band.target} + ${band.deadband}`,
        actionTaken: id === 'ec' ? 'Ninguna: requiere dilución/recambio manual' : 'Ninguna: no se dosifica oxidante; revisar manualmente',
      });
      this.decide(ctx, id, 'blocked', [`${label} alto: no existe actuador para reducirlo automáticamente`]);
      return;
    }

    if (this.activeLoop !== null) {
      this.setPhase(id, 'waiting', now);
      this.decide(ctx, id, 'wait', [`Desviación detectada; esperando a que termine la corrección de ${LOOP_LABEL[this.activeLoop]}`]);
      return;
    }

    if (L.confirmSince === null) {
      L.confirmSince = now;
      this.setPhase(id, 'confirming', now);
      this.decide(ctx, id, 'wait', [`Desviación ${err.toFixed(3)} fuera de banda; confirmando durante ${lc.confirmS} s (anti-ruido)`]);
      return;
    }
    if (now - L.confirmSince < lc.confirmS * 1000) {
      this.setPhase(id, 'confirming', now);
      return;
    }

    L.correctionTimes = L.correctionTimes.filter((t) => t > now - HOUR);
    if (L.correctionTimes.length >= lc.maxCorrectionsPerHour) {
      this.setPhase(id, 'blocked', now);
      this.decide(ctx, id, 'blocked', [`Límite de ${lc.maxCorrectionsPerHour} correcciones/hora alcanzado`]);
      return;
    }

    const plan = this.planDose(ctx, id, err);
    if ('error' in plan) {
      this.setPhase(id, 'blocked', now);
      this.decide(ctx, id, 'blocked', [plan.error]);
      return;
    }
    // Verificación previa de todos los pasos con la capa de seguridad.
    const blockers: string[] = [];
    for (const st of plan.steps) {
      const v = evaluatePumpStart(ctx.safety, st.pump, st.ml, 'auto');
      if (!v.ok) blockers.push(`${ctx.config.liquids[st.pump].name}: ${v.reasons.join('; ')}`);
    }
    if (blockers.length) {
      this.setPhase(id, 'blocked', now);
      this.decide(ctx, id, 'blocked', ['Corrección necesaria pero no permitida por la capa de seguridad', ...blockers]);
      return;
    }

    L.sequence = plan.steps.map((s) => ({ pump: s.pump, ml: s.ml, startAt: null, endAt: null, done: false }));
    L.valueBefore = value;
    L.expectedChange = plan.expected;
    L.correctionTimes.push(now);
    this.activeLoop = id;
    this.setPhase(id, 'dosing', now);
    this.decide(
      ctx,
      id,
      'dose',
      [
        `${label} = ${value.toFixed(3)}, objetivo ${band.target} ± ${band.deadband} (error ${err.toFixed(3)}) confirmado durante ${lc.confirmS} s`,
        `Plan: ${plan.steps.map((s) => `${ctx.config.liquids[s.pump].name} ${s.ml.toFixed(2)} mL`).join(' → ')}`,
        `Cambio esperado ${plan.expected.toFixed(3)} (estimación del controlador, ${(lc.correctionFraction * 100).toFixed(0)} % del error)`,
        'Modelo de respuesta: aproximación configurable, no validada',
      ],
      true,
    );
    this.stepActive(ctx, id);
  }

  private planDose(
    ctx: ChemContext,
    id: LoopId,
    err: number,
  ): { steps: { pump: PumpId; ml: number }[]; expected: number } | { error: string } {
    const c = ctx.config.control;
    const lc = c.loops[id];
    const V = c.reservoirVolumeL;
    if (V === null || V <= 0) return { error: 'Volumen nominal del depósito sin configurar' };
    let est: number | null;
    let pump: PumpId;
    if (id === 'ph') {
      pump = err > 0 ? 'phUp' : 'phDown';
      est = err > 0 ? c.estimates.phUp : c.estimates.phDown;
    } else if (id === 'ec') {
      pump = 'solA';
      est = c.estimates.ecPerMlA;
    } else {
      pump = 'oxidant';
      est = c.estimates.oxidant;
    }
    if (est === null || !(est > 0)) return { error: `Modelo de respuesta del controlador sin configurar para ${ctx.config.liquids[pump].name}` };
    const raw = ((Math.abs(err) * lc.correctionFraction) / est) * V;
    const ml = clamp(raw, lc.minDoseMl, lc.maxDoseMl);
    const expected = Math.sign(err) * (ml * est) / V;
    if (id !== 'ec') return { steps: [{ pump, ml }], expected };

    const d = ctx.profile.dosing;
    if (d.abRatio === null) return { error: 'Relación A:B del perfil sin configurar' };
    const steps: { pump: PumpId; ml: number }[] = [];
    for (const pid of c.ecSequence) {
      let v = 0;
      if (pid === 'solA') v = ml;
      else if (pid === 'solB') v = ml * d.abRatio;
      else if (pid === 'silicon' || pid === 'bloom' || pid === 'pk') v = ml * (d.additives[pid] ?? 0);
      if (v >= 0.05) steps.push({ pump: pid, ml: v });
    }
    return { steps, expected };
  }
}
