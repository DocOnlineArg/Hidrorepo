/**
 * Configuración por defecto.
 *
 * IMPORTANTE: los objetivos agronómicos (pH, EC, ORP, clima, fotoperiodo) quedan
 * en `null` y los perfiles sin validar. Los parámetros físicos de la planta y de
 * los líquidos son APROXIMACIONES del simulador (marcadas `validated: false`),
 * no datos de productos reales.
 */
import type {
  Band,
  CompatEntry,
  LiquidConfig,
  LoopConfig,
  ProfileConfig,
  ProfileId,
  PumpConfig,
  PumpId,
  SensorConfig,
  SensorId,
  SystemConfig,
} from './types';
import { PUMP_IDS } from './types';
import { pairKey } from './util';

export const SCHEMA_VERSION = 1;

const emptyBand = (): Band => ({ target: null, deadband: null, alarmLow: null, alarmHigh: null });

export function createEmptyProfile(id: ProfileId): ProfileConfig {
  return {
    id,
    name: id === 'veg' ? 'Vegetativo' : 'Floración',
    validated: false,
    validatedAt: null,
    example: false,
    reservoir: { ph: emptyBand(), ec: emptyBand(), orp: emptyBand(), waterTemp: emptyBand() },
    climate: {
      airTemp: emptyBand(),
      rh: emptyBand(),
      fanOnHighRh: false,
      fanCycleOnMin: null,
      fanCycleOffMin: null,
      lightsOverTempCutoff: null,
    },
    lights: { onTime: null, photoperiodH: null },
    dosing: { abRatio: null, additives: { silicon: null, bloom: null, pk: null } },
    automation: { ph: true, ec: true, orp: false, climate: true, lights: true },
  };
}

function sensor(
  id: SensorId,
  label: string,
  unit: string,
  rangeMin: number,
  rangeMax: number,
  spikeThreshold: number,
  requiresCalibration: boolean,
  decimals: number,
): SensorConfig {
  return {
    id,
    label,
    unit,
    rangeMin,
    rangeMax,
    spikeThreshold,
    requiresCalibration,
    calibrationValidityDays: 30,
    filter: { kind: 'ema', window: 5, alpha: 0.2 },
    staleAfterS: 30,
    stuckDetectS: 300,
    stabilityWindowS: 60,
    decimals,
  };
}

const SIM_NOTE =
  'Aproximación lineal de ejemplo para el simulador. No describe un producto real ni sirve para calcular dosis reales.';

function liquid(
  id: PumpId,
  name: string,
  chemClass: LiquidConfig['chemClass'],
  color: string,
  ec: number,
  ph: number,
  orp: number,
): LiquidConfig {
  return {
    id,
    name,
    chemClass,
    color,
    model: { ecPerMlPerL: ec, phPerMlPerL: ph, orpPerMlPerL: orp, validated: false, notes: SIM_NOTE },
  };
}

function pump(id: PumpId, label: string, overrides: Partial<PumpConfig> = {}): PumpConfig {
  return {
    id,
    label,
    flowMlPerMin: 50,
    testDurationS: 5,
    minIntervalS: 300,
    maxRunS: 60,
    containerCapacityMl: 1000,
    emptyThresholdMl: 50,
    primeVolumeMl: 5,
    enabled: true,
    ...overrides,
  };
}

const loop = (stabilityTolerance: number): LoopConfig => ({
  confirmS: 60,
  mixS: 300,
  stabilizeS: 120,
  stabilizeMaxS: 900,
  stabilityTolerance,
  correctionFraction: 0.5,
  minDoseMl: 0.5,
  maxDoseMl: 20,
  maxCorrectionsPerHour: 4,
  noProgressLimit: 3,
});

export function defaultCompatibility(): Record<string, CompatEntry> {
  const pairs: Record<string, CompatEntry> = {};
  for (let i = 0; i < PUMP_IDS.length; i++) {
    for (let j = i + 1; j < PUMP_IDS.length; j++) {
      const a = PUMP_IDS[i];
      const b = PUMP_IDS[j];
      let entry: CompatEntry = {
        status: 'unknown',
        note: 'Compatibilidad no verificada: requiere validación del usuario.',
        validatedBy: null,
      };
      if (a === 'oxidant' || b === 'oxidant') {
        entry = {
          status: 'incompatible',
          note: 'Oxidante: nunca se mezcla con concentrados ni correctores.',
          validatedBy: 'regla del sistema',
        };
      } else if (pairKey(a, b) === pairKey('phUp', 'phDown')) {
        entry = { status: 'incompatible', note: 'Ácido y base: reacción directa.', validatedBy: 'regla del sistema' };
      } else if (pairKey(a, b) === pairKey('solA', 'solB')) {
        entry = {
          status: 'incompatible',
          note: 'Concentrados A y B no deben mezclarse sin dilución (riesgo de precipitación).',
          validatedBy: 'regla del sistema',
        };
      }
      pairs[pairKey(a, b)] = entry;
    }
  }
  return pairs;
}

export function createDefaultConfig(): SystemConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    sensors: {
      ph: sensor('ph', 'pH del depósito', 'pH', 0, 14, 0.5, true, 2),
      ec: sensor('ec', 'Conductividad (EC)', 'mS/cm', 0, 20, 0.3, true, 3),
      orp: sensor('orp', 'ORP', 'mV', -1000, 1000, 60, true, 0),
      airTemp: sensor('airTemp', 'Temperatura ambiente', '°C', -40, 80, 2, false, 1),
      rh: sensor('rh', 'Humedad relativa', '%HR', 0, 100, 10, false, 1),
      waterTemp: sensor('waterTemp', 'Temperatura del agua', '°C', -10, 85, 1, false, 1),
    },
    liquids: {
      phUp: liquid('phUp', 'pH+', 'alkaline_corrector', '#7c5cff', 0.02, 2.0, -2),
      phDown: liquid('phDown', 'pH−', 'acid_corrector', '#e5484d', 0.03, -2.5, 3),
      oxidant: liquid('oxidant', 'Desinfectante (oxidante)', 'oxidant', '#0ea5e9', 0.01, 0, 40),
      solA: liquid('solA', 'Solución A', 'nutrient_concentrate', '#16a34a', 0.35, -0.1, 0),
      solB: liquid('solB', 'Solución B', 'nutrient_concentrate', '#65a30d', 0.35, -0.05, 0),
      bloom: liquid('bloom', 'Bloom', 'additive', '#d946ef', 0.1, -0.05, 0),
      silicon: liquid('silicon', 'Silicio', 'additive', '#94a3b8', 0.05, 0.3, 0),
      pk: liquid('pk', 'PK', 'additive', '#f59e0b', 0.2, -0.1, 0),
    },
    pumps: {
      phUp: pump('phUp', 'Bomba 1 · pH+'),
      phDown: pump('phDown', 'Bomba 2 · pH−'),
      oxidant: pump('oxidant', 'Bomba 3 · Desinfectante', { maxRunS: 30, minIntervalS: 1800 }),
      solA: pump('solA', 'Bomba 4 · Solución A'),
      solB: pump('solB', 'Bomba 5 · Solución B'),
      bloom: pump('bloom', 'Bomba 6 · Bloom'),
      silicon: pump('silicon', 'Bomba 7 · Silicio'),
      pk: pump('pk', 'Bomba 8 · PK'),
    },
    compatibility: { pairs: defaultCompatibility(), allowSimultaneousDosing: false },
    oxidantGuard: {
      enabled: false,
      acknowledgedWarning: false,
      maxDoseMl: 10,
      maxDailyMl: 50,
      orpHardMaxMv: 650,
      separationS: 900,
      lastIndependentCheckAt: null,
      independentCheckValidityH: 24,
    },
    climate: {
      humidifier: { mode: 'auto', manualOn: false, minOnS: 60, minOffS: 60 },
      dehumidifier: { mode: 'auto', manualOn: false, minOnS: 180, minOffS: 180 },
      fan: { mode: 'auto', manualOn: false, minOnS: 30, minOffS: 30, onSensorFault: 'on' },
      lights: { mode: 'auto', manualOn: false, minOnS: 0, minOffS: 0 },
      allowHumDehumSimultaneous: false,
      simultaneousJustification: '',
    },
    profiles: { veg: createEmptyProfile('veg'), flower: createEmptyProfile('flower') },
    activeProfile: 'veg',
    control: {
      loops: { ph: loop(0.03), ec: loop(0.02), orp: loop(10) },
      order: ['ec', 'ph', 'orp'],
      estimates: { phUp: null, phDown: null, ecPerMlA: null, oxidant: null },
      reservoirVolumeL: null,
      sequenceGapS: 60,
      ecSequence: ['silicon', 'solA', 'solB', 'bloom', 'pk'],
    },
    plant: {
      roomVolumeM3: 6,
      heatCapacityJPerK: 70000,
      envelopeUA: 15,
      lightsPowerW: 600,
      lightsHeatFraction: 0.9,
      fanFlowM3h: 300,
      leakACH: 0.5,
      humidifierGPerH: 300,
      dehumidifierGPerH: 500,
      dehumidifierHeatW: 300,
      transpirationLightGPerH: 120,
      transpirationDarkGPerH: 30,
      waterTauMin: 180,
      evaporationLPerH: 0.05,
      mixingTauS: 120,
      phDriftPerH: 0.02,
      ecDriftPerH: 0,
      orpBaselineMv: 250,
      orpRelaxTauH: 4,
      phBufferFactor: 1,
      extTempAmplitude: 0,
    },
    commTimeoutS: 5,
    historyIntervalS: 10,
    ecDisplayUnit: 'mS/cm',
  };
}

/**
 * Valores de EJEMPLO para la demostración. Se marcan `example: true` y la UI
 * los señala como no agronómicos. Sirven solo para ver la lógica funcionar.
 */
export function applyDemoProfiles(cfg: SystemConfig, now: number): void {
  const band = (target: number, deadband: number, lo: number, hi: number): Band => ({
    target,
    deadband,
    alarmLow: lo,
    alarmHigh: hi,
  });
  const veg = createEmptyProfile('veg');
  veg.example = true;
  veg.reservoir = {
    ph: band(5.8, 0.15, 5.2, 6.6),
    ec: band(1.2, 0.1, 0.6, 2.0),
    orp: band(300, 30, 150, 550),
    waterTemp: { target: null, deadband: null, alarmLow: 16, alarmHigh: 24 },
  };
  veg.climate = {
    airTemp: band(25, 1.5, 16, 32),
    rh: band(65, 5, 40, 85),
    fanOnHighRh: true,
    fanCycleOnMin: null,
    fanCycleOffMin: null,
    lightsOverTempCutoff: 35,
  };
  veg.lights = { onTime: '06:00', photoperiodH: 18 };
  veg.dosing = { abRatio: 1, additives: { silicon: 0.2, bloom: 0, pk: 0 } };
  veg.validated = true;
  veg.validatedAt = now;

  const flower = createEmptyProfile('flower');
  flower.example = true;
  flower.reservoir = {
    ph: band(6.0, 0.15, 5.4, 6.8),
    ec: band(1.6, 0.1, 0.8, 2.4),
    orp: band(300, 30, 150, 550),
    waterTemp: { target: null, deadband: null, alarmLow: 16, alarmHigh: 24 },
  };
  flower.climate = {
    airTemp: band(24, 1.5, 16, 30),
    rh: band(50, 5, 35, 70),
    fanOnHighRh: true,
    fanCycleOnMin: null,
    fanCycleOffMin: null,
    lightsOverTempCutoff: 34,
  };
  flower.lights = { onTime: '06:00', photoperiodH: 12 };
  flower.dosing = { abRatio: 1, additives: { silicon: 0, bloom: 0.3, pk: 0.2 } };
  flower.validated = true;
  flower.validatedAt = now;

  cfg.profiles = { veg, flower };
  cfg.control.reservoirVolumeL = 100;
  // El controlador usa estimaciones iguales al modelo del simulador (caso ideal).
  cfg.control.estimates = {
    phUp: Math.abs(cfg.liquids.phUp.model.phPerMlPerL),
    phDown: Math.abs(cfg.liquids.phDown.model.phPerMlPerL),
    ecPerMlA: cfg.liquids.solA.model.ecPerMlPerL + cfg.liquids.solB.model.ecPerMlPerL,
    oxidant: cfg.liquids.oxidant.model.orpPerMlPerL,
  };
}
