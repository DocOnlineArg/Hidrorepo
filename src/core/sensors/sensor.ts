/**
 * Canal de sensor: driver crudo → calibración → validación → filtro.
 * El mismo pipeline se usa con datos simulados, manuales o de hardware: solo
 * cambia el origen del valor crudo (`RawSample`).
 */
import type {
  CalibrationState,
  FilterConfig,
  ReadingSource,
  SensorConfig,
  SensorReading,
  SensorRuntime,
  SensorStatus,
} from '../types';
import { DAY, Rng, stddev } from '../util';

/** Muestra cruda producida por un driver (simulado, manual o hardware). */
export interface RawSample {
  raw: number | null;
  source: ReadingSource;
  /** El driver informa desconexión/fallo de bus. */
  connected: boolean;
  /** true si el valor ya está en unidades de ingeniería (lectura manual). */
  engineering: boolean;
  ts: number;
  /** Datos antiguos (sin telemetría reciente). */
  stale?: boolean;
}

/** Interfaz de un driver de sensor; implementaciones: simulada, hardware, manual. */
export interface SensorDriver {
  sample(now: number): RawSample;
}

export function createCalibration(required: boolean): CalibrationState {
  return {
    status: required ? 'none' : 'valid',
    gain: 1,
    bias: 0,
    calibratedAt: null,
    points: [],
    procedure: null,
    simulatedOnly: false,
  };
}

export function createSensorRuntime(cfg: SensorConfig, baseNoise: number): SensorRuntime {
  return {
    reading: {
      value: null,
      unfiltered: null,
      raw: null,
      status: 'disconnected',
      quality: 'bad',
      source: 'none',
      ts: null,
      message: 'Sin lecturas todavía',
    },
    calibration: createCalibration(cfg.requiresCalibration),
    fault: { disconnected: false, stuck: false, noise: 0, offset: 0, forcedRaw: null },
    manualValue: null,
    probeError: { gain: 1, offset: 0 },
    baseNoise,
    lastRawChangeAt: null,
    lastRaw: null,
    lastAccepted: null,
    spikeCount: 0,
    filterBuffer: [],
    emaState: null,
    recent: [],
  };
}

/** Driver simulado: lee la "verdad" del modelo y aplica error de sonda y fallos. */
export class SimulatedSensorDriver implements SensorDriver {
  constructor(
    private rt: SensorRuntime,
    private truth: () => number,
    private rng: Rng,
  ) {}
  sample(now: number): RawSample {
    const { fault, probeError } = this.rt;
    if (this.rt.manualValue !== null) {
      return { raw: this.rt.manualValue, source: 'manual', connected: true, engineering: true, ts: now };
    }
    if (fault.disconnected) return { raw: null, source: 'simulated', connected: false, engineering: false, ts: now };
    if (fault.forcedRaw !== null)
      return { raw: fault.forcedRaw, source: 'simulated', connected: true, engineering: false, ts: now };
    if (fault.stuck && this.rt.lastRaw !== null)
      return { raw: this.rt.lastRaw, source: 'simulated', connected: true, engineering: false, ts: now };
    const t = this.truth();
    const noise = (this.rt.baseNoise + fault.noise) * this.rng.gauss();
    const raw = t * probeError.gain + probeError.offset + fault.offset + noise;
    return { raw, source: 'simulated', connected: true, engineering: false, ts: now };
  }
}

function calibrationValid(cfg: SensorConfig, cal: CalibrationState, now: number): boolean {
  if (!cfg.requiresCalibration) return true;
  if (cal.status !== 'valid' || cal.calibratedAt === null) return false;
  return now - cal.calibratedAt <= cfg.calibrationValidityDays * DAY;
}

export function applyFilter(rt: SensorRuntime, f: FilterConfig, v: number): number {
  switch (f.kind) {
    case 'none':
      return v;
    case 'ema': {
      const a = Math.min(1, Math.max(0.01, f.alpha));
      rt.emaState = rt.emaState === null ? v : rt.emaState + a * (v - rt.emaState);
      return rt.emaState;
    }
    case 'moving_average':
    case 'median': {
      rt.filterBuffer.push(v);
      const w = Math.max(1, Math.round(f.window));
      while (rt.filterBuffer.length > w) rt.filterBuffer.shift();
      if (f.kind === 'moving_average') return rt.filterBuffer.reduce((a, b) => a + b, 0) / rt.filterBuffer.length;
      const sorted = [...rt.filterBuffer].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
  }
}

export function resetFilter(rt: SensorRuntime): void {
  rt.filterBuffer = [];
  rt.emaState = null;
  rt.recent = [];
  rt.lastAccepted = null;
  rt.spikeCount = 0;
}

/**
 * Procesa una muestra cruda y actualiza `rt.reading`.
 */
export function processSample(cfg: SensorConfig, rt: SensorRuntime, s: RawSample): SensorReading {
  const now = s.ts;
  const prev = rt.reading;
  const set = (
    status: SensorStatus,
    value: number | null,
    unfiltered: number | null,
    message: string,
  ): SensorReading => {
    const quality = status === 'ok' ? 'good' : status === 'uncalibrated' || status === 'suspect' ? 'uncertain' : 'bad';
    rt.reading = { value, unfiltered, raw: s.raw, status, quality, source: s.source, ts: now, message };
    return rt.reading;
  };

  if (s.stale) {
    resetFilter(rt);
    return set('stale', null, null, 'Sin telemetría reciente del dispositivo');
  }
  if (!s.connected || s.raw === null) {
    resetFilter(rt);
    return set('disconnected', null, null, 'Sin respuesta del sensor (desconectado o fallo de bus)');
  }
  if (!Number.isFinite(s.raw)) {
    resetFilter(rt);
    return set('fault', null, null, 'Lectura no numérica');
  }

  // Detección de lectura atascada (un instrumento real siempre presenta algo de ruido).
  if (rt.lastRaw === null || s.raw !== rt.lastRaw) rt.lastRawChangeAt = now;
  rt.lastRaw = s.raw;

  // Calibración (las lecturas manuales ya vienen en unidades de ingeniería).
  const calOk = s.engineering || calibrationValid(cfg, rt.calibration, now);
  if (cfg.requiresCalibration && rt.calibration.status === 'valid' && !calibrationValid(cfg, rt.calibration, now)) {
    rt.calibration.status = 'expired';
  }
  const useCal = !s.engineering && cfg.requiresCalibration && rt.calibration.status === 'valid';
  const v = useCal ? rt.calibration.gain * s.raw + rt.calibration.bias : s.raw;

  if (v < cfg.rangeMin || v > cfg.rangeMax) {
    resetFilter(rt);
    return set('out_of_range', null, v, `Lectura fuera del rango del instrumento (${cfg.rangeMin}…${cfg.rangeMax})`);
  }

  // Rechazo de picos: salto respecto al último valor filtrado aceptado.
  const ref = rt.recent.length ? rt.recent[rt.recent.length - 1].v : rt.lastAccepted;
  if (ref !== null) {
    const jump = Math.abs(v - ref);
    if (jump > cfg.spikeThreshold) {
      rt.spikeCount++;
      if (rt.spikeCount < 5) {
        return set('suspect', prev.value, v, `Pico rechazado (salto ${jump.toFixed(3)} ${cfg.unit} > ${cfg.spikeThreshold})`);
      }
      // Cambio sostenido (5 muestras seguidas): se acepta como nuevo nivel.
      resetFilter(rt);
    } else {
      rt.spikeCount = 0;
    }
  }
  rt.lastAccepted = v;

  const filtered = applyFilter(rt, cfg.filter, v);
  rt.recent.push({ t: now, v: filtered });
  const keepMs = Math.max(cfg.stabilityWindowS, 600) * 1000;
  while (rt.recent.length && rt.recent[0].t < now - keepMs) rt.recent.shift();

  if (s.source !== 'manual' && rt.lastRawChangeAt !== null && now - rt.lastRawChangeAt > cfg.stuckDetectS * 1000) {
    return set('suspect', filtered, v, 'Lectura idéntica durante demasiado tiempo: posible sensor atascado');
  }
  if (!calOk) {
    const why = rt.calibration.status === 'expired' ? 'Calibración caducada' : 'Sin calibración válida';
    return set('uncalibrated', filtered, v, `${why}: valor sin corregir, no apto para control`);
  }
  return set('ok', filtered, v, s.source === 'manual' ? 'Lectura introducida manualmente' : 'Lectura válida');
}

/** Lectura apta para control automático. */
export function isUsable(r: SensorReading): boolean {
  return r.status === 'ok' && r.quality === 'good' && r.value !== null;
}

/** Desviación estándar de la ventana de estabilidad. */
export function windowStddev(rt: SensorRuntime, windowS: number, now: number): { sd: number; n: number } {
  const vals = rt.recent.filter((p) => p.t >= now - windowS * 1000).map((p) => p.v);
  return { sd: stddev(vals), n: vals.length };
}

// ------------------------------------------------------------ Calibración simulada

/** Puntos estándar por sensor (referencias típicas de soluciones de calibración). */
export const CALIBRATION_POINTS: Partial<Record<string, number[]>> = {
  ph: [7.0, 4.0],
  ec: [1.413],
  orp: [225],
};

export function startCalibration(rt: SensorRuntime, refs: number[]): void {
  rt.calibration.status = 'in_progress';
  rt.calibration.procedure = [...refs];
  rt.calibration.points = [];
}

/**
 * Registra un punto: el usuario "sumerge" la sonda simulada en la solución de
 * referencia; el crudo se obtiene aplicando el error real de la sonda + ruido.
 */
export function captureCalibrationPoint(rt: SensorRuntime, reference: number, raw: number, now: number): void {
  rt.calibration.points.push({ reference, raw, at: now });
}

export function finishCalibration(rt: SensorRuntime, now: number): { ok: boolean; message: string } {
  const pts = rt.calibration.points;
  if (pts.length === 0) return { ok: false, message: 'No hay puntos capturados' };
  let gain = 1;
  let bias = 0;
  if (pts.length >= 2) {
    const [a, b] = pts;
    if (Math.abs(b.raw - a.raw) < 1e-6) return { ok: false, message: 'Puntos idénticos: calibración inválida' };
    gain = (b.reference - a.reference) / (b.raw - a.raw);
    bias = a.reference - gain * a.raw;
    if (gain < 0.8 || gain > 1.2) {
      rt.calibration.status = 'none';
      return { ok: false, message: `Pendiente fuera de tolerancia (${(gain * 100).toFixed(0)} %): sonda defectuosa` };
    }
  } else {
    bias = pts[0].reference - pts[0].raw;
  }
  rt.calibration = {
    ...rt.calibration,
    status: 'valid',
    gain,
    bias,
    calibratedAt: now,
    procedure: null,
    simulatedOnly: false,
  };
  resetFilter(rt);
  return { ok: true, message: `Calibración válida (ganancia ${gain.toFixed(4)}, offset ${bias.toFixed(4)})` };
}
