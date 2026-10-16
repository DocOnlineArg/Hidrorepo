/**
 * Motor del gemelo digital: orquesta modelo físico, sensores, controladores,
 * capa de seguridad, alarmas, historial y enrutado de salidas.
 *
 * Orden de un paso (dt = 1 s simulado):
 *  1. Enlace con el controlador (real o virtual) → estado seguro si se pierde.
 *  2. Perturbaciones programadas del escenario.
 *  3. Modelo físico con las salidas aplicadas en el paso anterior.
 *  4. Muestreo de sensores (driver simulado / hardware / manual).
 *  5. Bombas (entrega, vaciado, corte por tiempo máximo) + vigilancia del oxidante.
 *  6. Controlador químico.
 *  7. Controlador ambiental (histéresis, interbloqueos, tiempos mínimos).
 *  8. Composición de salidas → simulación o OutputGate (hardware).
 *  9. Alarmas e historial.
 */
import type {
  CalibrationState,
  DoseOrigin,
  LinkStatus,
  LoopId,
  OutputId,
  ProfileConfig,
  ProfileId,
  PumpId,
  PumpRuntime,
  RelayId,
  RelayMode,
  RelayRuntime,
  SensorFault,
  SensorId,
  SensorRuntime,
  SystemConfig,
  SystemMode,
} from './types';
import { PUMP_IDS, RELAY_IDS, SENSOR_IDS } from './types';
import { applyDemoProfiles, createDefaultConfig } from './config';
import { DEFAULT_INITIAL, PlantModel, allOff, createPlantState, type InitialConditions } from './physics/plant';
import {
  CALIBRATION_POINTS,
  SimulatedSensorDriver,
  captureCalibrationPoint,
  createSensorRuntime,
  finishCalibration,
  isUsable,
  processSample,
  resetFilter,
  startCalibration,
  type RawSample,
  type SensorDriver,
} from './sensors/sensor';
import { createPumpRuntime, startPump, stepPump, stopPump, type PumpHooks } from './actuators/pumps';
import { evaluatePumpStart, oxidantRuntimeCheck, type SafetyContext, type Verdict } from './safety/safety';
import { ChemistryController } from './control/chemistry';
import { applyRelayDecision, createRelayRuntime, decideClimate } from './control/climate';
import { AlarmManager, EventLog } from './alarms';
import { History } from './history';
import type { ConfigStore, PersistedState } from './persistence';
import { migrateConfig } from './persistence';
import { diffProfiles, profileProblems, setProfilePath } from './profiles';
import { Rng, deepClone } from './util';
import type { HardwareBackend } from '../hal/backend';
import { OutputGate, offOutputs } from '../hal/backend';
import { MockHardwareBackend } from '../hal/mockHardware';

export const DEFAULT_START = Date.UTC(2026, 0, 1, 5, 30, 0);

export interface ScheduledEvent {
  at: number;
  label: string;
  apply: (e: Engine) => void;
  done: boolean;
}

export interface EngineOptions {
  config?: SystemConfig;
  store?: ConfigStore | null;
  seed?: number;
  startTime?: number;
  initial?: InitialConditions;
  hardware?: HardwareBackend | null;
}

const RELAY_LABEL: Record<RelayId, string> = {
  humidifier: 'Humidificador',
  dehumidifier: 'Deshumidificador',
  fan: 'Ventilador',
  lights: 'Luces',
};

const SENSOR_DEPENDENTS: Record<SensorId, string> = {
  ph: 'Dosificación automática de pH+/pH− y desinfectante bloqueada',
  ec: 'Dosificación automática de soluciones y aditivos bloqueada',
  orp: 'Dosificación automática de desinfectante bloqueada',
  rh: 'Humidificador y deshumidificador en apagado seguro',
  airTemp: 'Ventilador en estado de fallo configurado; protección térmica de luces sin dato',
  waterTemp: 'Solo monitorización (sin acciones dependientes)',
};

const BASE_NOISE: Record<SensorId, number> = { ph: 0.004, ec: 0.002, orp: 0.8, airTemp: 0.03, rh: 0.2, waterTemp: 0.02 };
const PROBE_ERROR: Record<SensorId, { gain: number; offset: number }> = {
  ph: { gain: 0.97, offset: 0.12 },
  ec: { gain: 1.04, offset: 0.02 },
  orp: { gain: 1, offset: -15 },
  airTemp: { gain: 1, offset: 0 },
  rh: { gain: 1, offset: 0 },
  waterTemp: { gain: 1, offset: 0 },
};

export class Engine {
  config: SystemConfig;
  t: number;
  startTime: number;
  mode: SystemMode = 'simulation';
  running = false;
  speed = 1;
  automationEnabled = true;
  plant: PlantModel;
  sensors: Record<SensorId, SensorRuntime>;
  pumps: Record<PumpId, PumpRuntime>;
  relays: Record<RelayId, RelayRuntime>;
  chem: ChemistryController;
  log = new EventLog();
  alarms: AlarmManager;
  history: History;
  link: LinkStatus;
  estop = false;
  lightsOverTemp = false;
  engineFault: string | null = null;
  commanded: Record<OutputId, boolean> = allOff();
  hardware: HardwareBackend;
  gate: OutputGate;
  scheduled: ScheduledEvent[] = [];
  scenarioId = 'blank';
  /** Contador de cambios para la UI. */
  version = 0;
  /** Hook de pruebas: se ejecuta dentro del paso protegido. */
  testHook: ((e: Engine) => void) | null = null;

  private rng: Rng;
  private seed: number;
  private drivers: Record<SensorId, SensorDriver>;
  private store: ConfigStore | null;
  private initial: InitialConditions;
  private lastInterlock = false;
  private sensorBadAt: Partial<Record<SensorId, number>> = {};

  constructor(opts: EngineOptions = {}) {
    this.store = opts.store ?? null;
    const saved = this.store?.load() ?? null;
    this.config = opts.config ? deepClone(opts.config) : saved ? migrateConfig(saved.config) : createDefaultConfig();
    this.seed = opts.seed ?? 12345;
    this.rng = new Rng(this.seed);
    this.startTime = opts.startTime ?? saved?.simTime ?? DEFAULT_START;
    this.t = this.startTime;
    this.initial = opts.initial ?? DEFAULT_INITIAL;
    this.alarms = new AlarmManager(this.log);
    this.history = new History(this.config.historyIntervalS);
    this.plant = new PlantModel(createPlantState(this.initial), this.config.plant);
    this.sensors = this.createSensors();
    this.pumps = this.createPumps();
    this.relays = this.createRelays();
    this.chem = new ChemistryController(this.t);
    this.link = this.createLink();
    this.hardware = opts.hardware ?? new MockHardwareBackend(() => this.rawForMock());
    this.gate = new OutputGate(this.hardware);
    this.drivers = this.createDrivers();
    if (saved) this.restore(saved);
    this.sampleSensors();
    this.log.add(this.t, 'system', 'Motor', saved ? 'Motor iniciado: configuración restaurada desde almacenamiento' : 'Motor iniciado con configuración por defecto (sin objetivos)');
  }

  // ================================================================== construcción
  private createSensors(): Record<SensorId, SensorRuntime> {
    const s = {} as Record<SensorId, SensorRuntime>;
    for (const id of SENSOR_IDS) {
      s[id] = createSensorRuntime(this.config.sensors[id], BASE_NOISE[id]);
      s[id].probeError = { ...PROBE_ERROR[id] };
    }
    return s;
  }
  private createPumps(): Record<PumpId, PumpRuntime> {
    const p = {} as Record<PumpId, PumpRuntime>;
    for (const id of PUMP_IDS) p[id] = createPumpRuntime(this.config.pumps[id]);
    return p;
  }
  private createRelays(): Record<RelayId, RelayRuntime> {
    const r = {} as Record<RelayId, RelayRuntime>;
    for (const id of RELAY_IDS) r[id] = createRelayRuntime();
    return r;
  }
  private createLink(): LinkStatus {
    return {
      connected: true,
      lastHeartbeatAt: this.t,
      faultInjected: false,
      firmware: 'controlador virtual (simulación)',
      armed: false,
      safeState: false,
      safeReason: '',
    };
  }
  private createDrivers(): Record<SensorId, SensorDriver> {
    const d = {} as Record<SensorId, SensorDriver>;
    for (const id of SENSOR_IDS) {
      const sim = new SimulatedSensorDriver(this.sensors[id], () => this.plant.truth(id), this.rng);
      d[id] = {
        sample: (now: number): RawSample => {
          if (this.mode !== 'hardware' || this.sensors[id].manualValue !== null) return sim.sample(now);
          return this.hardwareSample(id, now);
        },
      };
    }
    return d;
  }

  private hardwareSample(id: SensorId, now: number): RawSample {
    const f = this.hardware.latestSensors();
    if (!f) return { raw: null, source: 'hardware', connected: false, engineering: false, ts: now };
    if (now - f.ts > this.config.sensors[id].staleAfterS * 1000)
      return { raw: null, source: 'hardware', connected: true, engineering: false, ts: now, stale: true };
    const s = f.sensors[id];
    return { raw: s && s.ok ? s.raw : null, source: 'hardware', connected: !!s && s.ok, engineering: false, ts: now };
  }

  /** Lecturas "crudas" que entregaría el hardware simulado (verdad + error de sonda + ruido). */
  private rawForMock(): Partial<Record<SensorId, number | null>> {
    const out: Partial<Record<SensorId, number | null>> = {};
    for (const id of SENSOR_IDS) {
      const rt = this.sensors[id];
      if (rt.fault.disconnected) {
        out[id] = null;
        continue;
      }
      out[id] =
        rt.fault.forcedRaw ??
        this.plant.truth(id) * rt.probeError.gain + rt.probeError.offset + rt.fault.offset + (rt.baseNoise + rt.fault.noise) * this.rng.gauss();
    }
    return out;
  }

  // ================================================================== utilidades
  get profile(): ProfileConfig {
    return this.config.profiles[this.config.activeProfile];
  }
  get safeState(): boolean {
    return this.link.safeState;
  }
  get decisions() {
    return this.chem.decisions;
  }

  safetyCtx(): SafetyContext {
    return {
      now: this.t,
      config: this.config,
      pumps: this.pumps,
      sensors: this.sensors,
      mode: this.mode,
      automationEnabled: this.automationEnabled,
      safeState: this.link.safeState,
      estop: this.estop,
      hardwareArmed: this.link.armed,
    };
  }

  private bump(): void {
    this.version++;
  }

  private pumpHooks(): PumpHooks {
    return {
      deliver: (id, ml) => {
        if (ml > 0) this.plant.addDose(this.config.liquids[id], ml);
      },
      onStop: (id, rt, why) => {
        this.log.add(this.t, 'pump', this.config.pumps[id].label, `Detenida: ${why} (${rt.deliveredThisRunMl.toFixed(2)} mL, origen ${rt.origin ?? '—'})`);
      },
      onEmpty: (id) => {
        const rt = this.pumps[id];
        rt.locked = true;
        rt.lockReason = 'Recipiente vacío';
        this.alarms.raise(this.t, {
          key: `PUMP_EMPTY_${id}`,
          code: 'CONTAINER_EMPTY',
          severity: 'critical',
          source: this.config.pumps[id].label,
          message: `Recipiente de ${this.config.liquids[id].name} vacío`,
          cause: `Nivel simulado ${rt.levelMl.toFixed(0)} mL ≤ umbral ${this.config.pumps[id].emptyThresholdMl} mL`,
          actionTaken: 'Bomba detenida y bloqueada; línea marcada sin cebar hasta rellenar y cebar',
        });
      },
      onMaxRun: (id) => {
        const rt = this.pumps[id];
        rt.locked = true;
        rt.lockReason = 'Tiempo máximo excedido';
        this.alarms.raise(this.t, {
          key: `PUMP_MAXRUN_${id}`,
          code: 'PUMP_MAX_RUNTIME',
          severity: 'critical',
          source: this.config.pumps[id].label,
          message: `${this.config.pumps[id].label} alcanzó su tiempo máximo de funcionamiento`,
          cause: `Funcionamiento continuo ≥ ${this.config.pumps[id].maxRunS} s`,
          actionTaken: 'Bomba detenida y bloqueada; requiere desbloqueo manual',
        });
      },
    };
  }

  // ================================================================== bucle
  /** Avanza `seconds` segundos simulados en pasos de 1 s. */
  advance(seconds: number): void {
    const n = Math.max(0, Math.floor(seconds));
    for (let i = 0; i < n; i++) {
      this.step(1);
      if (this.engineFault) break;
    }
  }

  step(dtS = 1): void {
    if (this.engineFault) return;
    try {
      this.t += dtS * 1000;
      this.updateLink();
      this.runScheduled();
      this.testHook?.(this);
      this.plant.step(dtS, this.t, this.config.liquids);
      for (const id of SENSOR_IDS) processSample(this.config.sensors[id], this.sensors[id], this.drivers[id].sample(this.t));
      this.stepPumps(dtS);
      this.stepChemistry();
      this.stepClimate(dtS);
      this.routeOutputs();
      this.evaluateAlarms();
      if (this.history.due(this.t)) this.recordHistory();
    } catch (err) {
      this.enterEngineFault(err);
    }
    this.bump();
  }

  /** Muestreo sin avanzar el tiempo (estado inicial coherente). */
  sampleSensors(): void {
    for (const id of SENSOR_IDS) processSample(this.config.sensors[id], this.sensors[id], this.drivers[id].sample(this.t));
  }

  private enterEngineFault(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.engineFault = msg;
    this.running = false;
    // Apagado de todo el estado interno (nunca se activa una salida ante un fallo).
    for (const id of PUMP_IDS) {
      this.pumps[id].running = false;
    }
    for (const id of RELAY_IDS) this.relays[id].on = false;
    this.commanded = allOff();
    this.plant.state.applied = allOff();
    this.link.safeState = true;
    this.link.armed = false;
    this.link.safeReason = 'Fallo interno del simulador';
    if (this.mode === 'hardware') this.gate.forceOff();
    this.alarms.raise(this.t, {
      key: 'ENGINE_FAULT',
      code: 'ENGINE_FAULT',
      severity: 'critical',
      source: 'Motor',
      message: 'Fallo interno del motor de simulación',
      cause: msg,
      actionTaken: 'Simulación detenida, todas las salidas apagadas y estado seguro activado',
    });
  }

  private updateLink(): void {
    const timeout = this.config.commTimeoutS * 1000;
    let ok: boolean;
    if (this.mode === 'hardware') {
      this.hardware.tick(this.t);
      const L = this.hardware.link();
      this.link.connected = L.connected;
      this.link.lastHeartbeatAt = L.lastHeartbeatAt;
      this.link.firmware = L.firmware;
      ok = L.connected && L.lastHeartbeatAt !== null && this.t - L.lastHeartbeatAt <= timeout;
      if (L.estop && !this.estop) this.emergencyStop('E-STOP físico reportado por el dispositivo');
    } else {
      if (!this.link.faultInjected) this.link.lastHeartbeatAt = this.t;
      this.link.connected = !this.link.faultInjected;
      ok = this.link.lastHeartbeatAt !== null && this.t - this.link.lastHeartbeatAt <= timeout;
    }
    if (!ok) this.enterSafeState(this.mode === 'hardware' ? 'Pérdida de comunicación con la ESP32' : 'Pérdida de comunicación con el controlador (simulada)');
    this.alarms.set(this.t, !ok, {
      key: 'COMM_LOSS',
      code: 'COMM_LOSS',
      severity: 'critical',
      source: 'Comunicación',
      message: 'Fallo de comunicación con el controlador',
      cause: `Sin heartbeat/telemetría durante más de ${this.config.commTimeoutS} s`,
      actionTaken: 'Estado seguro: bombas detenidas, salidas apagadas, automatización suspendida; requiere restablecimiento manual',
    });
  }

  enterSafeState(reason: string): void {
    if (this.link.safeState) return;
    this.link.safeState = true;
    this.link.safeReason = reason;
    this.link.armed = false;
    const hooks = this.pumpHooks();
    for (const id of PUMP_IDS) stopPump(id, this.pumps[id], this.t, `Estado seguro: ${reason}`, hooks);
    for (const id of RELAY_IDS) {
      if (this.relays[id].on) {
        this.relays[id].on = false;
        this.relays[id].lastChangeAt = this.t;
        this.relays[id].reason = 'Estado seguro';
      }
    }
    this.chem.abortAll(this.t, 'Estado seguro');
    if (this.mode === 'hardware') {
      this.gate.forceOff();
      try {
        this.hardware.requestArm(false, '');
      } catch {
        /* ignore */
      }
    }
    this.log.add(this.t, 'safety', 'Seguridad', `ESTADO SEGURO activado: ${reason}`);
  }

  /** Sale del estado seguro solo si el enlace está sano y no hay E-STOP. */
  resetSafeState(): Verdict {
    const reasons: string[] = [];
    if (this.estop) reasons.push('E-STOP activo');
    if (this.engineFault) reasons.push('Fallo interno del motor: reinicie el escenario');
    const timeout = this.config.commTimeoutS * 1000;
    const hb = this.mode === 'hardware' ? this.hardware.link().lastHeartbeatAt : this.link.lastHeartbeatAt;
    if (this.mode === 'hardware' ? !this.hardware.link().connected : this.link.faultInjected) reasons.push('Enlace no disponible');
    if (hb === null || this.t - hb > timeout) reasons.push('Sin heartbeat reciente');
    if (reasons.length) return { ok: false, reasons };
    this.link.safeState = false;
    this.link.safeReason = '';
    this.log.add(this.t, 'safety', 'Seguridad', 'Estado seguro restablecido por el operador (salidas siguen desarmadas en modo hardware)');
    this.bump();
    return { ok: true, reasons: [] };
  }

  private runScheduled(): void {
    for (const ev of this.scheduled) {
      if (!ev.done && this.t >= ev.at) {
        ev.done = true;
        this.log.add(this.t, 'lab', 'Escenario', `Perturbación: ${ev.label}`);
        ev.apply(this);
      }
    }
  }

  private stepPumps(dtS: number): void {
    const hooks = this.pumpHooks();
    for (const id of PUMP_IDS) stepPump(id, this.config.pumps[id], this.pumps[id], this.t, dtS, hooks);
    const why = oxidantRuntimeCheck(this.safetyCtx());
    if (why) {
      stopPump('oxidant', this.pumps.oxidant, this.t, `Subsistema oxidante: ${why}`, hooks);
      this.alarms.raise(this.t, {
        key: 'OXIDANT_GUARD_TRIP',
        code: 'OXIDANT_GUARD_TRIP',
        severity: 'critical',
        source: 'Subsistema desinfectante',
        message: 'Parada por el subsistema de seguridad del oxidante',
        cause: why,
        actionTaken: 'Bomba de desinfectante detenida',
      });
    }
  }

  private stepChemistry(): void {
    const autoAllowed = this.mode !== 'manual' && this.automationEnabled && !this.link.safeState && !this.estop;
    this.chem.step({
      now: this.t,
      config: this.config,
      profile: this.profile,
      sensors: this.sensors,
      safety: this.safetyCtx(),
      alarms: this.alarms,
      autoAllowed,
      startPump: (id, ml, origin, reason) => this.startPumpOp(id, ml, origin, reason),
      isPumpRunning: (id) => this.pumps[id].running,
    });
  }

  private stepClimate(dtS: number): void {
    const res = decideClimate({
      now: this.t,
      profile: this.profile,
      climate: this.config.climate,
      relays: this.relays,
      sensors: this.sensors,
      mode: this.mode,
      automationEnabled: this.automationEnabled,
      safeState: this.link.safeState || this.estop,
      lightsOverTemp: this.lightsOverTemp,
    });
    this.lightsOverTemp = res.lightsOverTemp;
    for (const id of RELAY_IDS) {
      const rc = this.config.climate[id];
      const rt = this.relays[id];
      if (rt.on) rt.onTimeTotalS += dtS;
      if (applyRelayDecision(rt, res.decisions[id], rc.minOnS, rc.minOffS, this.t))
        this.log.add(this.t, 'relay', RELAY_LABEL[id], `${rt.on ? 'ENCENDIDO' : 'APAGADO'}: ${rt.reason}`);
    }
    if (res.interlockConflict && !this.lastInterlock)
      this.log.add(this.t, 'safety', 'Interbloqueo', 'Orden simultánea humidificador/deshumidificador rechazada');
    this.alarms.set(this.t, res.interlockConflict, {
      key: 'INTERLOCK_HUM_DEHUM',
      code: 'INTERLOCK',
      severity: 'warning',
      source: 'Clima',
      message: 'Interbloqueo humidificador/deshumidificador activo',
      cause: 'Se solicitaron ambos equipos a la vez sin justificación configurada',
      actionTaken: 'Se mantiene solo un equipo; el otro queda apagado',
    });
    this.lastInterlock = res.interlockConflict;
    this.alarms.set(this.t, this.lightsOverTemp, {
      key: 'LIGHTS_OVERTEMP',
      code: 'LIGHTS_OVERTEMP',
      severity: 'warning',
      source: 'Luces',
      message: 'Protección térmica de iluminación activa',
      cause: `Temperatura ambiente > ${this.profile.climate.lightsOverTempCutoff} °C`,
      actionTaken: 'Luces apagadas hasta bajar 2 °C del límite',
    });
  }

  private routeOutputs(): void {
    const out = allOff();
    const maxOnMs: Partial<Record<PumpId, number>> = {};
    const blocked = this.link.safeState || this.estop;
    for (const id of PUMP_IDS) {
      const rt = this.pumps[id];
      out[id] = rt.running && !blocked;
      if (out[id] && rt.runStartedAt !== null) {
        const pc = this.config.pumps[id];
        const planned = Math.min(rt.plannedDurationS ?? pc.maxRunS, pc.maxRunS) * 1000;
        maxOnMs[id] = Math.max(0, Math.round(planned - (this.t - rt.runStartedAt) + 500));
      }
    }
    for (const id of RELAY_IDS) out[id] = this.relays[id].on && !blocked;
    this.commanded = out;

    if (this.mode === 'hardware') {
      this.gate.send(
        { outputs: out, maxOnMs },
        { mode: this.mode, armed: this.link.armed, safeState: this.link.safeState, estop: this.estop },
      );
      this.plant.state.applied = this.hardware.reportedOutputs() ?? offOutputs();
    } else {
      // Controlador virtual: si el enlace falla, su watchdog apaga las salidas.
      this.plant.state.applied = this.link.faultInjected ? allOff() : { ...out };
    }
  }

  private evaluateAlarms(): void {
    const t = this.t;
    const p = this.profile;
    for (const id of SENSOR_IDS) {
      const r = this.sensors[id].reading;
      const label = this.config.sensors[id].label;
      if (r.status !== 'ok') this.sensorBadAt[id] = t;
      // Se normaliza solo tras 10 s seguidos en estado correcto (evita oscilación).
      const bad = r.status !== 'ok' || (this.alarms.isActive(`SENSOR_${id}`) && t - (this.sensorBadAt[id] ?? 0) < 10_000);
      const sev = r.status === 'uncalibrated' ? 'info' : r.status === 'suspect' ? 'warning' : 'critical';
      this.alarms.set(t, bad, {
        key: `SENSOR_${id}`,
        code: `SENSOR_${r.status.toUpperCase()}`,
        severity: sev,
        source: label,
        message: `${label}: ${r.status}`,
        cause: r.message,
        actionTaken: SENSOR_DEPENDENTS[id],
      });
      const band =
        id === 'airTemp' ? p.climate.airTemp : id === 'rh' ? p.climate.rh : (p.reservoir as Record<string, typeof p.climate.rh>)[id];
      const v = isUsable(r) ? (r.value as number) : null;
      const lo = band?.alarmLow ?? null;
      const hi = band?.alarmHigh ?? null;
      const hy = this.config.sensors[id].alarmHysteresis;
      const dec = this.config.sensors[id].decimals;
      // Histéresis: se activa al cruzar el límite y se normaliza solo al volver `hy` dentro.
      const lowKey = `LIMIT_${id}_LOW`;
      const highKey = `LIMIT_${id}_HIGH`;
      const lowOn = v !== null && lo !== null && (v < lo || (this.alarms.isActive(lowKey) && v < lo + hy));
      const highOn = v !== null && hi !== null && (v > hi || (this.alarms.isActive(highKey) && v > hi - hy));
      this.alarms.set(t, lowOn, {
        key: lowKey,
        code: 'LIMIT_LOW',
        severity: 'warning',
        source: label,
        message: `${label} por debajo del límite configurado`,
        cause: `${v?.toFixed(dec)} < ${lo}`,
        actionTaken: 'Registro y aviso; el control actúa solo si hay acción permitida',
      });
      this.alarms.set(t, highOn, {
        key: highKey,
        code: 'LIMIT_HIGH',
        severity: 'warning',
        source: label,
        message: `${label} por encima del límite configurado`,
        cause: `${v?.toFixed(dec)} > ${hi}`,
        actionTaken: 'Registro y aviso; el control actúa solo si hay acción permitida',
      });
    }
    for (const id of PUMP_IDS) {
      const rt = this.pumps[id];
      const pc = this.config.pumps[id];
      const low = rt.levelMl > pc.emptyThresholdMl && rt.levelMl < pc.containerCapacityMl * 0.2;
      this.alarms.set(t, low, {
        key: `PUMP_LOW_${id}`,
        code: 'CONTAINER_LOW',
        severity: 'warning',
        source: pc.label,
        message: `Nivel bajo en recipiente de ${this.config.liquids[id].name}`,
        cause: `${rt.levelMl.toFixed(0)} mL < 20 % de ${pc.containerCapacityMl} mL`,
        actionTaken: 'Aviso para reposición',
      });
    }
  }

  private recordHistory(): void {
    const v: Record<string, number | null> = {};
    for (const id of SENSOR_IDS) {
      v[id] = this.sensors[id].reading.value;
      v[`truth.${id}`] = this.plant.truth(id);
    }
    for (const id of RELAY_IDS) v[`relay.${id}`] = this.relays[id].on ? 1 : 0;
    for (const id of PUMP_IDS) {
      v[`level.${id}`] = this.pumps[id].levelMl;
      v[`pump.${id}`] = this.pumps[id].running ? 1 : 0;
    }
    v['volumeL'] = this.plant.state.volumeL;
    v['extTemp'] = this.plant.state.extTemp;
    this.history.record(this.t, v);
  }

  // ================================================================== bombas
  startPumpOp(id: PumpId, ml: number, origin: DoseOrigin, reason: string): Verdict {
    const v = evaluatePumpStart(this.safetyCtx(), id, ml, origin);
    if (!v.ok) {
      if (origin !== 'auto') this.log.add(this.t, 'safety', this.config.pumps[id].label, `Orden rechazada (${origin}): ${v.reasons.join('; ')}`);
      return v;
    }
    const pc = this.config.pumps[id];
    const planned = origin === 'manual_hold' ? null : (ml / pc.flowMlPerMin) * 60;
    startPump(this.pumps[id], this.t, planned, origin, reason);
    this.log.add(
      this.t,
      'pump',
      pc.label,
      `Arranque (${origin}) ${planned === null ? 'mantenido' : `${ml.toFixed(2)} mL / ${planned.toFixed(1)} s`}: ${reason}`,
    );
    this.bump();
    return v;
  }

  testPump(id: PumpId): Verdict {
    const pc = this.config.pumps[id];
    return this.startPumpOp(id, (pc.flowMlPerMin * pc.testDurationS) / 60, 'manual_test', 'Prueba individual');
  }

  holdPump(id: PumpId): Verdict {
    return this.startPumpOp(id, (this.config.pumps[id].flowMlPerMin * this.config.pumps[id].maxRunS) / 60, 'manual_hold', 'Accionamiento manual mantenido');
  }

  primePump(id: PumpId): Verdict {
    return this.startPumpOp(id, this.config.pumps[id].primeVolumeMl, 'prime', 'Cebado de línea');
  }

  stopPumpManual(id: PumpId): void {
    stopPump(id, this.pumps[id], this.t, 'Parada manual', this.pumpHooks());
    this.bump();
  }

  refillPump(id: PumpId, ml?: number): void {
    const rt = this.pumps[id];
    const pc = this.config.pumps[id];
    rt.levelMl = Math.min(pc.containerCapacityMl, ml ?? pc.containerCapacityMl);
    if (rt.lockReason === 'Recipiente vacío') {
      rt.locked = false;
      rt.lockReason = '';
    }
    this.alarms.clear(this.t, `PUMP_EMPTY_${id}`);
    this.log.add(this.t, 'pump', pc.label, `Recipiente rellenado a ${rt.levelMl.toFixed(0)} mL${rt.primed ? '' : ' (requiere cebado)'}`);
    this.persist();
    this.bump();
  }

  setPumpLevel(id: PumpId, ml: number): void {
    this.pumps[id].levelMl = Math.max(0, Math.min(this.config.pumps[id].containerCapacityMl, ml));
    this.log.add(this.t, 'lab', this.config.pumps[id].label, `Nivel simulado fijado a ${ml.toFixed(0)} mL`);
    this.bump();
  }

  lockPump(id: PumpId, reason = 'Bloqueo manual del operador'): void {
    const rt = this.pumps[id];
    stopPump(id, rt, this.t, 'Bloqueo de seguridad', this.pumpHooks());
    rt.locked = true;
    rt.lockReason = reason;
    this.log.add(this.t, 'safety', this.config.pumps[id].label, `Bloqueada: ${reason}`);
    this.persist();
    this.bump();
  }

  unlockPump(id: PumpId): Verdict {
    const rt = this.pumps[id];
    const pc = this.config.pumps[id];
    if (rt.levelMl <= pc.emptyThresholdMl) return { ok: false, reasons: ['Recipiente vacío: rellenar antes de desbloquear'] };
    rt.locked = false;
    rt.lockReason = '';
    this.alarms.clear(this.t, `PUMP_MAXRUN_${id}`);
    this.log.add(this.t, 'safety', pc.label, 'Desbloqueada por el operador');
    this.persist();
    this.bump();
    return { ok: true, reasons: [] };
  }

  // ================================================================== clima
  setRelay(id: RelayId, mode: RelayMode, manualOn?: boolean): void {
    const rc = this.config.climate[id];
    rc.mode = mode;
    if (manualOn !== undefined) rc.manualOn = manualOn;
    this.log.add(this.t, 'relay', RELAY_LABEL[id], `Modo ${mode}${mode === 'manual' ? ` (${rc.manualOn ? 'ON' : 'OFF'})` : ''}`);
    this.persist();
    this.bump();
  }

  // ================================================================== sensores
  setSensorFault(id: SensorId, patch: Partial<SensorFault>): void {
    Object.assign(this.sensors[id].fault, patch);
    this.log.add(this.t, 'lab', this.config.sensors[id].label, `Fallo inyectado: ${JSON.stringify(patch)}`);
    this.bump();
  }

  clearSensorFaults(id: SensorId): void {
    this.sensors[id].fault = { disconnected: false, stuck: false, noise: 0, offset: 0, forcedRaw: null };
    this.log.add(this.t, 'lab', this.config.sensors[id].label, 'Fallos eliminados');
    this.bump();
  }

  setManualReading(id: SensorId, value: number | null): void {
    this.sensors[id].manualValue = value;
    resetFilter(this.sensors[id]);
    this.log.add(
      this.t,
      'sensor',
      this.config.sensors[id].label,
      value === null ? 'Lectura manual retirada' : `Lectura MANUAL introducida: ${value} ${this.config.sensors[id].unit}`,
    );
    this.bump();
  }

  beginCalibration(id: SensorId, refs?: number[]): void {
    startCalibration(this.sensors[id], refs ?? CALIBRATION_POINTS[id] ?? []);
    this.log.add(this.t, 'sensor', this.config.sensors[id].label, 'Calibración iniciada (simulada)');
    this.bump();
  }

  /** Simula sumergir la sonda en una solución de referencia y captura el valor crudo. */
  captureCalibration(id: SensorId, reference: number): Verdict {
    const rt = this.sensors[id];
    if (rt.calibration.status !== 'in_progress') return { ok: false, reasons: ['No hay calibración en curso'] };
    if (rt.fault.disconnected) return { ok: false, reasons: ['Sensor desconectado'] };
    const raw =
      this.mode === 'hardware'
        ? (this.sensors[id].reading.raw ?? NaN)
        : reference * rt.probeError.gain + rt.probeError.offset + rt.fault.offset + rt.baseNoise * this.rng.gauss();
    if (!Number.isFinite(raw)) return { ok: false, reasons: ['Sin lectura cruda'] };
    captureCalibrationPoint(rt, reference, raw, this.t);
    this.log.add(this.t, 'sensor', this.config.sensors[id].label, `Punto de calibración ${reference} → crudo ${raw.toFixed(4)}`);
    this.bump();
    return { ok: true, reasons: [] };
  }

  completeCalibration(id: SensorId): Verdict {
    const res = finishCalibration(this.sensors[id], this.t);
    this.log.add(this.t, 'sensor', this.config.sensors[id].label, res.message);
    this.persist();
    this.bump();
    return { ok: res.ok, reasons: [res.message] };
  }

  cancelCalibration(id: SensorId): void {
    const c = this.sensors[id].calibration;
    c.status = c.calibratedAt ? 'valid' : 'none';
    c.procedure = null;
    c.points = [];
    this.bump();
  }

  /** Calibración automática de demostración (marcada como simulada). */
  demoCalibrateAll(): void {
    for (const id of ['ph', 'ec', 'orp'] as SensorId[]) {
      const refs = CALIBRATION_POINTS[id] ?? [];
      this.beginCalibration(id, refs);
      for (const r of refs) this.captureCalibration(id, r);
      this.completeCalibration(id);
      this.sensors[id].calibration.simulatedOnly = true;
    }
  }

  invalidateCalibration(id: SensorId): void {
    this.sensors[id].calibration = { ...this.sensors[id].calibration, status: 'none', calibratedAt: null };
    this.log.add(this.t, 'lab', this.config.sensors[id].label, 'Calibración invalidada');
    this.bump();
  }

  // ================================================================== modos
  setMode(mode: SystemMode): void {
    if (mode === this.mode) return;
    const prev = this.mode;
    if (prev === 'hardware') {
      this.gate.forceOff();
      try {
        this.hardware.requestArm(false, '');
      } catch {
        /* ignore */
      }
      this.link.armed = false;
      this.link.firmware = 'controlador virtual (simulación)';
      this.link.lastHeartbeatAt = this.t;
      this.link.connected = !this.link.faultInjected;
    }
    this.mode = mode;
    if (mode === 'hardware') {
      this.link.armed = false;
      this.speed = 1;
      this.hardware.connect();
      this.hardware.tick(this.t);
    }
    if (mode === 'manual') this.chem.abortAll(this.t, 'Modo manual');
    for (const id of SENSOR_IDS) resetFilter(this.sensors[id]);
    this.log.add(this.t, 'system', 'Modo', `Modo ${prev} → ${mode}`);
    this.persist();
    this.bump();
  }

  setAutomation(on: boolean): void {
    this.automationEnabled = on;
    this.log.add(this.t, 'control', 'Automatización', on ? 'Activada' : 'Desactivada');
    this.persist();
    this.bump();
  }

  attachBackend(b: HardwareBackend): void {
    if (this.mode === 'hardware') this.setMode('simulation');
    this.hardware.disconnect();
    this.hardware = b;
    this.gate = new OutputGate(b);
    this.log.add(this.t, 'hardware', 'HAL', `Backend seleccionado: ${b.kind}${b.isPhysical ? ' (FÍSICO)' : ' (simulado)'}`);
    this.bump();
  }

  /** Selecciona el hardware simulado acoplado al modelo físico (sin placa). */
  attachMockBackend(): void {
    this.attachBackend(new MockHardwareBackend(() => this.rawForMock()));
  }

  /** Habilitación deliberada de salidas físicas. */
  arm(phrase: string, checklistComplete: boolean): Verdict {
    const reasons: string[] = [];
    if (this.mode !== 'hardware') reasons.push('Solo disponible en modo hardware');
    if (!checklistComplete) reasons.push('Lista de verificación de seguridad incompleta');
    if (phrase !== 'ARMAR') reasons.push('Frase de confirmación incorrecta (escriba ARMAR)');
    if (this.link.safeState) reasons.push('Estado seguro activo: restablecer primero');
    if (this.estop) reasons.push('E-STOP activo');
    const L = this.hardware.link();
    if (!L.connected) reasons.push('Dispositivo no conectado');
    if (reasons.length) {
      this.log.add(this.t, 'hardware', 'Armado', `Rechazado: ${reasons.join('; ')}`);
      this.bump();
      return { ok: false, reasons };
    }
    this.hardware.requestArm(true, 'ARMAR');
    this.link.armed = true;
    this.log.add(this.t, 'hardware', 'Armado', `Salidas HABILITADAS por el operador (backend ${this.hardware.kind})`);
    this.bump();
    return { ok: true, reasons: [] };
  }

  disarm(): void {
    this.link.armed = false;
    this.gate.forceOff();
    try {
      this.hardware.requestArm(false, '');
    } catch {
      /* ignore */
    }
    this.log.add(this.t, 'hardware', 'Armado', 'Salidas deshabilitadas');
    this.bump();
  }

  emergencyStop(reason = 'Paro de emergencia accionado por el operador'): void {
    this.estop = true;
    this.enterSafeState(reason);
    this.alarms.raise(this.t, {
      key: 'ESTOP',
      code: 'ESTOP',
      severity: 'critical',
      source: 'Seguridad',
      message: 'Paro de emergencia',
      cause: reason,
      actionTaken: 'Todas las salidas apagadas y desarmadas',
    });
    this.bump();
  }

  resetEstop(): void {
    this.estop = false;
    this.alarms.clear(this.t, 'ESTOP');
    this.log.add(this.t, 'safety', 'Seguridad', 'E-STOP rearmado (estado seguro sigue activo hasta restablecer)');
    this.bump();
  }

  setLinkFault(on: boolean): void {
    this.link.faultInjected = on;
    if (this.hardware instanceof MockHardwareBackend) this.hardware.linkFault = on;
    this.log.add(this.t, 'lab', 'Comunicación', on ? 'Fallo de comunicación inyectado' : 'Fallo de comunicación retirado');
    this.bump();
  }

  // ================================================================== perfiles / config
  updateProfile(id: ProfileId, path: string, value: unknown): void {
    const p = this.config.profiles[id];
    setProfilePath(p, path, value);
    if (p.validated) {
      p.validated = false;
      p.validatedAt = null;
      this.log.add(this.t, 'profile', p.name, 'Perfil modificado: requiere nueva validación');
    }
    this.persist();
    this.bump();
  }

  validateProfile(id: ProfileId): Verdict {
    const p = this.config.profiles[id];
    const problems = profileProblems(p);
    if (problems.length) return { ok: false, reasons: problems };
    p.validated = true;
    p.validatedAt = this.t;
    p.example = false;
    this.log.add(this.t, 'profile', p.name, 'Perfil validado por el usuario');
    this.persist();
    this.bump();
    return { ok: true, reasons: [] };
  }

  invalidateProfile(id: ProfileId): void {
    const p = this.config.profiles[id];
    p.validated = false;
    p.validatedAt = null;
    this.persist();
    this.bump();
  }

  /** Cambia el perfil activo sin borrar historial; registra los parámetros que cambian. */
  setActiveProfile(id: ProfileId): { label: string; a: unknown; b: unknown }[] {
    const from = this.profile;
    const to = this.config.profiles[id];
    if (from.id === id) return [];
    const diff = diffProfiles(from, to);
    this.config.activeProfile = id;
    for (const l of ['ph', 'ec', 'orp'] as LoopId[]) if (this.chem.loops[l].phase !== 'locked_out') this.chem.resetLoop(l, this.t);
    this.log.add(this.t, 'profile', 'Perfiles', `Perfil activo: ${from.name} → ${to.name} (${diff.length} parámetros cambian)`);
    for (const d of diff) this.log.add(this.t, 'profile', 'Perfiles', `  ${d.label}: ${String(d.a)} → ${String(d.b)}`);
    this.persist();
    this.bump();
    return diff;
  }

  /** Modifica la configuración global y persiste. */
  updateConfig(mutator: (c: SystemConfig) => void, description: string): void {
    mutator(this.config);
    this.plant.params = this.config.plant;
    this.history.intervalS = this.config.historyIntervalS;
    this.log.add(this.t, 'config', 'Configuración', description);
    this.persist();
    this.bump();
  }

  replaceConfig(cfg: SystemConfig): void {
    this.config = deepClone(cfg);
    this.plant.params = this.config.plant;
    this.log.add(this.t, 'config', 'Configuración', 'Configuración importada');
    this.persist();
    this.bump();
  }

  acknowledgeAlarm(id: number): void {
    this.alarms.acknowledge(this.t, id);
    this.bump();
  }

  resetLoop(id: LoopId): void {
    this.chem.resetLoop(id, this.t);
    this.alarms.clear(this.t, `LOOP_LOCKOUT_${id}`);
    this.log.add(this.t, 'control', `Lazo ${id}`, 'Lazo rearmado por el operador');
    this.bump();
  }

  // ================================================================== laboratorio
  perturb(kind: 'extTemp' | 'extRh' | 'addWater' | 'phShift' | 'ecShift' | 'orpShift' | 'airTemp' | 'rh', value: number): void {
    const s = this.plant.state;
    switch (kind) {
      case 'extTemp':
        s.extTemp = value;
        break;
      case 'extRh':
        s.extRh = value;
        break;
      case 'addWater':
        this.plant.addWater(value, 7.0, 0); // agua sin sales, pH 7 (mezcla aproximada)
        break;
      case 'phShift':
        s.ph = Math.min(14, Math.max(0, s.ph + value));
        break;
      case 'ecShift':
        s.ecMass = Math.max(0, s.ecMass + value * s.volumeL);
        break;
      case 'orpShift':
        s.orp += value;
        break;
      case 'airTemp':
        s.airTemp = value;
        break;
      case 'rh': {
        const sat = 216.7 * (6.112 * Math.exp((17.62 * s.airTemp) / (243.12 + s.airTemp))) / (273.15 + s.airTemp);
        s.absHumidity = (Math.min(100, Math.max(0, value)) / 100) * sat;
        break;
      }
    }
    this.log.add(this.t, 'lab', 'Perturbación', `${kind} = ${value}`);
    this.bump();
  }

  schedule(afterS: number, label: string, apply: (e: Engine) => void): void {
    this.scheduled.push({ at: this.t + afterS * 1000, label, apply, done: false });
  }

  /** Reinicia el estado dinámico (planta, actuadores, historial) conservando la configuración. */
  resetRuntime(initial: InitialConditions = this.initial, keepCalibration = true): void {
    const cal: Record<string, CalibrationState> = {};
    for (const id of SENSOR_IDS) cal[id] = this.sensors[id].calibration;
    if (this.mode === 'hardware') this.setMode('simulation');
    this.t = this.startTime;
    this.rng = new Rng(this.seed);
    this.initial = initial;
    this.plant = new PlantModel(createPlantState(initial), this.config.plant);
    this.sensors = this.createSensors();
    if (keepCalibration) for (const id of SENSOR_IDS) this.sensors[id].calibration = cal[id];
    this.pumps = this.createPumps();
    this.relays = this.createRelays();
    this.chem = new ChemistryController(this.t);
    this.link = this.createLink();
    this.drivers = this.createDrivers();
    this.history.clear();
    this.log = new EventLog();
    this.alarms = new AlarmManager(this.log);
    this.scheduled = [];
    this.estop = false;
    this.engineFault = null;
    this.lightsOverTemp = false;
    this.commanded = allOff();
    this.running = false;
    this.sampleSensors();
    this.bump();
  }

  /** Configuración de demostración (valores de ejemplo explícitos). */
  applyDemoSetup(): void {
    applyDemoProfiles(this.config, this.t);
    this.demoCalibrateAll();
    for (const id of PUMP_IDS) this.pumps[id].primed = true;
    this.log.add(this.t, 'config', 'Escenario', 'Configuración de DEMOSTRACIÓN cargada: valores de ejemplo, no recomendaciones agronómicas');
    this.bump();
  }

  // ================================================================== persistencia
  snapshotForStore(): PersistedState {
    const calibrations: PersistedState['calibrations'] = {};
    for (const id of SENSOR_IDS) calibrations[id] = this.sensors[id].calibration;
    const pumps: PersistedState['pumps'] = {};
    for (const id of PUMP_IDS) {
      const r = this.pumps[id];
      pumps[id] = { levelMl: r.levelMl, primed: r.primed, totalDosedMl: r.totalDosedMl, opCount: r.opCount, locked: r.locked, lockReason: r.lockReason };
    }
    return {
      schemaVersion: this.config.schemaVersion,
      savedAt: Date.now(),
      config: this.config,
      calibrations,
      pumps,
      simTime: this.t,
      mode: this.mode,
      automationEnabled: this.automationEnabled,
    };
  }

  persist(): void {
    this.store?.save(this.snapshotForStore());
  }

  private restore(s: PersistedState): void {
    for (const id of SENSOR_IDS) {
      const c = s.calibrations[id];
      if (c) this.sensors[id].calibration = { ...c, procedure: null, status: c.status === 'in_progress' ? (c.calibratedAt ? 'valid' : 'none') : c.status };
    }
    for (const id of PUMP_IDS) {
      const p = s.pumps[id];
      if (p) Object.assign(this.pumps[id], p);
    }
    this.automationEnabled = s.automationEnabled;
    // Recuperación segura: nunca se reanuda en modo hardware ni con salidas armadas.
    this.mode = s.mode === 'manual' ? 'manual' : 'simulation';
  }
}
