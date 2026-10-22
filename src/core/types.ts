/**
 * Modelo de datos compartido del gemelo digital.
 *
 * Convenciones:
 * - Tiempo simulado en milisegundos (epoch). La hora del día se interpreta en UTC
 *   como "hora simulada" para que la simulación sea determinista e independiente
 *   de la zona horaria del navegador.
 * - EC se almacena internamente en mS/cm. La UI puede mostrar µS/cm.
 * - Los valores de configuración agronómica son `null` hasta que el usuario los
 *   introduce y valida. Nunca se inventan objetivos por defecto.
 */

export type SensorId = 'ph' | 'ec' | 'orp' | 'airTemp' | 'rh' | 'waterTemp';
export const SENSOR_IDS: SensorId[] = ['ph', 'ec', 'orp', 'airTemp', 'rh', 'waterTemp'];

export type PumpId = 'phUp' | 'phDown' | 'oxidant' | 'solA' | 'solB' | 'bloom' | 'silicon' | 'pk';
export const PUMP_IDS: PumpId[] = ['phUp', 'phDown', 'oxidant', 'solA', 'solB', 'bloom', 'silicon', 'pk'];

export type RelayId = 'humidifier' | 'dehumidifier' | 'fan' | 'lights';
export const RELAY_IDS: RelayId[] = ['humidifier', 'dehumidifier', 'fan', 'lights'];

export type OutputId = PumpId | RelayId;
export const OUTPUT_IDS: OutputId[] = [...PUMP_IDS, ...RELAY_IDS];

export type SystemMode = 'simulation' | 'manual' | 'hardware';
export type ProfileId = 'veg' | 'flower';
export type LoopId = 'ph' | 'ec' | 'orp';

/** Clase química usada por el motor de compatibilidad. */
export type ChemClass =
  | 'alkaline_corrector'
  | 'acid_corrector'
  | 'oxidant'
  | 'nutrient_concentrate'
  | 'additive';

export type Quality = 'good' | 'uncertain' | 'bad';
export type SensorStatus =
  | 'ok'
  | 'disconnected'
  | 'fault'
  | 'out_of_range'
  | 'stale'
  | 'uncalibrated'
  | 'suspect';
export type ReadingSource = 'simulated' | 'manual' | 'hardware' | 'none';

// ---------------------------------------------------------------- Sensores

export type FilterKind = 'none' | 'ema' | 'moving_average' | 'median';

export interface FilterConfig {
  kind: FilterKind;
  /** Ventana (muestras) para media móvil / mediana. */
  window: number;
  /** Coeficiente EMA (0..1]. */
  alpha: number;
}

export interface SensorConfig {
  id: SensorId;
  label: string;
  unit: string;
  /** Rango físico del instrumento: fuera de él la lectura es inválida. */
  rangeMin: number;
  rangeMax: number;
  /**
   * Salto máximo plausible de una muestra respecto al valor filtrado actual
   * (unidades del sensor). Saltos mayores se rechazan como picos.
   */
  spikeThreshold: number;
  requiresCalibration: boolean;
  calibrationValidityDays: number;
  filter: FilterConfig;
  /** Segundos sin lectura nueva antes de marcar 'stale' (modo hardware). */
  staleAfterS: number;
  /** Segundos con lectura cruda idéntica antes de considerarla atascada. */
  stuckDetectS: number;
  /** Ventana (s) usada para evaluar estabilidad antes de decidir. */
  stabilityWindowS: number;
  /** Histéresis para normalizar alarmas de límite (unidades del sensor). */
  alarmHysteresis: number;
  decimals: number;
}

/** Fallos inyectables (laboratorio). */
export interface SensorFault {
  disconnected: boolean;
  stuck: boolean;
  /** Desviación estándar de ruido adicional (unidades del sensor). */
  noise: number;
  /** Desplazamiento adicional (deriva). */
  offset: number;
  /** Fuerza una lectura cruda concreta (p. ej. fuera de rango). */
  forcedRaw: number | null;
}

export interface CalibrationPoint {
  reference: number;
  raw: number;
  at: number;
}

export interface CalibrationState {
  status: 'none' | 'valid' | 'expired' | 'in_progress';
  /** value = gain * raw + bias */
  gain: number;
  bias: number;
  calibratedAt: number | null;
  points: CalibrationPoint[];
  /** Puntos de referencia del procedimiento en curso. */
  procedure: number[] | null;
  /** true si la calibración se generó por un escenario de demostración. */
  simulatedOnly: boolean;
}

export interface SensorReading {
  /** Valor de ingeniería tras calibración y filtro; null si no hay dato válido. */
  value: number | null;
  /** Valor sin filtrar (tras calibración). */
  unfiltered: number | null;
  raw: number | null;
  status: SensorStatus;
  quality: Quality;
  source: ReadingSource;
  ts: number | null;
  message: string;
}

export interface SensorRuntime {
  reading: SensorReading;
  calibration: CalibrationState;
  fault: SensorFault;
  /** Lectura introducida manualmente; tiene prioridad y se marca como 'manual'. */
  manualValue: number | null;
  /** Error real de la sonda simulada (verdad oculta del simulador). */
  probeError: { gain: number; offset: number };
  /** Ruido inherente del instrumento simulado. */
  baseNoise: number;
  lastRawChangeAt: number | null;
  lastRaw: number | null;
  lastAccepted: number | null;
  spikeCount: number;
  filterBuffer: number[];
  emaState: number | null;
  /** Historial corto (t, valor filtrado) para estabilidad / confirmación. */
  recent: { t: number; v: number }[];
}

// ---------------------------------------------------------------- Líquidos y bombas

/**
 * Modelo de respuesta del depósito ante una dosis (verdad del simulador).
 * Es una APROXIMACIÓN lineal por mL dosificado por litro de depósito,
 * configurable por el usuario. No representa la química real del producto.
 */
export interface LiquidResponseModel {
  ecPerMlPerL: number;
  phPerMlPerL: number;
  orpPerMlPerL: number;
  /** El usuario marca true solo si ha identificado el modelo con mediciones. */
  validated: boolean;
  notes: string;
}

export interface LiquidConfig {
  id: PumpId;
  name: string;
  chemClass: ChemClass;
  color: string;
  model: LiquidResponseModel;
}

export interface PumpConfig {
  id: PumpId;
  label: string;
  flowMlPerMin: number;
  /** Duración de una operación de prueba manual. */
  testDurationS: number;
  minIntervalS: number;
  maxRunS: number;
  containerCapacityMl: number;
  emptyThresholdMl: number;
  primeVolumeMl: number;
  enabled: boolean;
}

export type DoseOrigin = 'auto' | 'manual_test' | 'manual_hold' | 'prime' | 'calibration';

export interface PumpRuntime {
  running: boolean;
  origin: DoseOrigin | null;
  runStartedAt: number | null;
  /** null = sin duración (mantener manual), cortado por maxRunS. */
  plannedDurationS: number | null;
  deliveredThisRunMl: number;
  reason: string;
  lastRunEndAt: number | null;
  levelMl: number;
  primed: boolean;
  locked: boolean;
  lockReason: string;
  totalDosedMl: number;
  opCount: number;
  lastOpMl: number;
  /** Volumen entregado en la última prueba de caudal (a probeta, no al depósito). */
  lastCalibrationMl: number | null;
  lastCalibrationS: number | null;
  /** Registro (t, mL) para límites diarios. */
  doseLog: { t: number; ml: number; origin: DoseOrigin }[];
}

export type CompatStatus = 'compatible' | 'incompatible' | 'unknown';

export interface CompatEntry {
  status: CompatStatus;
  note: string;
  validatedBy: string | null;
}

export interface CompatibilityConfig {
  /** Clave: "pumpA|pumpB" ordenada alfabéticamente. */
  pairs: Record<string, CompatEntry>;
  allowSimultaneousDosing: boolean;
}

export interface OxidantGuardConfig {
  /** El subsistema debe habilitarse explícitamente; por defecto bloqueado. */
  enabled: boolean;
  acknowledgedWarning: boolean;
  maxDoseMl: number;
  maxDailyMl: number;
  /** ORP por encima del cual nunca se dosifica oxidante. */
  orpHardMaxMv: number;
  /** Separación temporal mínima con cualquier otra dosificación. */
  separationS: number;
  /** Fecha de la última verificación independiente (p. ej. kit de cloro libre). */
  lastIndependentCheckAt: number | null;
  independentCheckValidityH: number;
}

// ---------------------------------------------------------------- Clima / relés

export type RelayMode = 'auto' | 'manual';

export interface RelayConfig {
  mode: RelayMode;
  manualOn: boolean;
  minOnS: number;
  minOffS: number;
}

export interface ClimateConfig {
  humidifier: RelayConfig;
  dehumidifier: RelayConfig;
  fan: RelayConfig & { onSensorFault: 'on' | 'off' };
  lights: RelayConfig;
  allowHumDehumSimultaneous: boolean;
  simultaneousJustification: string;
}

export interface RelayRuntime {
  on: boolean;
  lastChangeAt: number | null;
  onTimeTotalS: number;
  cycles: number;
  reason: string;
  /** Condición de activación evaluada en el último ciclo. */
  condition: string;
}

// ---------------------------------------------------------------- Perfiles

export interface Band {
  target: number | null;
  deadband: number | null;
  alarmLow: number | null;
  alarmHigh: number | null;
}

export interface ProfileConfig {
  id: ProfileId;
  name: string;
  validated: boolean;
  validatedAt: number | null;
  /** true cuando los valores provienen de un escenario de demostración. */
  example: boolean;
  reservoir: { ph: Band; ec: Band; orp: Band; waterTemp: Band };
  climate: {
    airTemp: Band;
    rh: Band;
    fanOnHighRh: boolean;
    /** Ventilación periódica: minutos encendido / apagado. */
    fanCycleOnMin: number | null;
    fanCycleOffMin: number | null;
    lightsOverTempCutoff: number | null;
  };
  lights: { onTime: string | null; photoperiodH: number | null };
  dosing: {
    /** mL de B por mL de A. */
    abRatio: number | null;
    /** mL de aditivo por mL de A (null u 0 = no dosificar). */
    additives: { silicon: number | null; bloom: number | null; pk: number | null };
  };
  automation: { ph: boolean; ec: boolean; orp: boolean; climate: boolean; lights: boolean };
}

// ---------------------------------------------------------------- Control

export interface LoopConfig {
  /** Tiempo que la desviación debe persistir antes de actuar. */
  confirmS: number;
  /** Tiempo de mezcla tras la dosificación. */
  mixS: number;
  /** Tiempo mínimo de estabilización antes de volver a medir. */
  stabilizeS: number;
  /** Tiempo máximo esperando estabilidad. */
  stabilizeMaxS: number;
  /** Desviación estándar máxima en la ventana para considerar estable. */
  stabilityTolerance: number;
  /** Fracción del error corregida por operación (conservador < 1). */
  correctionFraction: number;
  minDoseMl: number;
  maxDoseMl: number;
  maxCorrectionsPerHour: number;
  /** Correcciones consecutivas sin efecto antes de bloquear el lazo. */
  noProgressLimit: number;
}

export interface ControlConfig {
  loops: Record<LoopId, LoopConfig>;
  order: LoopId[];
  /**
   * Estimación del CONTROLADOR del efecto por mL/L (en magnitud).
   * Independiente del modelo del simulador: permite estudiar errores de modelo.
   * null = sin modelo configurado → el lazo no dosifica automáticamente.
   */
  estimates: {
    phUp: number | null;
    phDown: number | null;
    /** EC por mL/L de solución A (incluyendo la B asociada). */
    ecPerMlA: number | null;
    oxidant: number | null;
  };
  /** Volumen nominal del depósito usado por el controlador (L). */
  reservoirVolumeL: number | null;
  sequenceGapS: number;
  ecSequence: PumpId[];
}

// ---------------------------------------------------------------- Planta

export interface PlantParams {
  roomVolumeM3: number;
  heatCapacityJPerK: number;
  envelopeUA: number;
  lightsPowerW: number;
  lightsHeatFraction: number;
  fanFlowM3h: number;
  leakACH: number;
  humidifierGPerH: number;
  dehumidifierGPerH: number;
  dehumidifierHeatW: number;
  transpirationLightGPerH: number;
  transpirationDarkGPerH: number;
  waterTauMin: number;
  evaporationLPerH: number;
  mixingTauS: number;
  phDriftPerH: number;
  ecDriftPerH: number;
  orpBaselineMv: number;
  orpRelaxTauH: number;
  phBufferFactor: number;
  extTempAmplitude: number;
}

export interface PlantState {
  airTemp: number;
  absHumidity: number;
  waterTemp: number;
  volumeL: number;
  ph: number;
  /** "Masa" de conductividad: EC·V (mS/cm·L). */
  ecMass: number;
  orp: number;
  pending: { ecMass: number; ph: number; orp: number; volumeL: number };
  extTemp: number;
  extRh: number;
  /** Salidas efectivamente aplicadas al modelo físico. */
  applied: Record<OutputId, boolean>;
}

// ---------------------------------------------------------------- Alarmas, eventos

export type Severity = 'info' | 'warning' | 'critical';

export interface Alarm {
  id: number;
  key: string;
  code: string;
  severity: Severity;
  source: string;
  message: string;
  cause: string;
  actionTaken: string;
  raisedAt: number;
  lastSeenAt: number;
  clearedAt: number | null;
  acknowledgedAt: number | null;
  active: boolean;
}

export type EventCategory =
  | 'system'
  | 'sensor'
  | 'pump'
  | 'relay'
  | 'control'
  | 'safety'
  | 'alarm'
  | 'profile'
  | 'lab'
  | 'hardware'
  | 'config';

export interface LogEvent {
  id: number;
  t: number;
  category: EventCategory;
  source: string;
  message: string;
}

export interface Decision {
  id: number;
  t: number;
  loop: LoopId;
  action: 'dose' | 'wait' | 'blocked' | 'idle' | 'measure' | 'alarm';
  value: number | null;
  target: number | null;
  justification: string[];
}

export type LoopPhase =
  | 'disabled'
  | 'idle'
  | 'confirming'
  | 'waiting'
  | 'dosing'
  | 'mixing'
  | 'stabilizing'
  | 'blocked'
  | 'locked_out';

export interface LoopRuntime {
  phase: LoopPhase;
  phaseSince: number;
  confirmSince: number | null;
  sequence: { pump: PumpId; ml: number; startAt: number | null; endAt: number | null; done: boolean }[];
  mixUntil: number | null;
  valueBefore: number | null;
  expectedChange: number | null;
  correctionTimes: number[];
  noProgressCount: number;
  lastReason: string;
}

// ---------------------------------------------------------------- Comunicación

export interface LinkStatus {
  connected: boolean;
  lastHeartbeatAt: number | null;
  /** Fallo de enlace inyectado (laboratorio). */
  faultInjected: boolean;
  firmware: string;
  armed: boolean;
  safeState: boolean;
  safeReason: string;
}

// ---------------------------------------------------------------- Configuración raíz

export interface SystemConfig {
  schemaVersion: number;
  sensors: Record<SensorId, SensorConfig>;
  liquids: Record<PumpId, LiquidConfig>;
  pumps: Record<PumpId, PumpConfig>;
  compatibility: CompatibilityConfig;
  oxidantGuard: OxidantGuardConfig;
  climate: ClimateConfig;
  profiles: Record<ProfileId, ProfileConfig>;
  activeProfile: ProfileId;
  control: ControlConfig;
  plant: PlantParams;
  commTimeoutS: number;
  historyIntervalS: number;
  ecDisplayUnit: 'mS/cm' | 'µS/cm';
}
