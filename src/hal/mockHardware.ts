/**
 * Hardware simulado: emula una ESP32 en proceso (enlace, telemetría, armado,
 * watchdog de comunicaciones y corte local por tiempo máximo), sin placa.
 * NO es físico: `isPhysical = false`.
 */
import type { OutputId, PumpId, SensorId } from '../core/types';
import { PUMP_IDS, SENSOR_IDS } from '../core/types';
import type { BackendLink, HardwareBackend, OutputFrame, SensorFrame } from './backend';
import { offOutputs } from './backend';

export class MockHardwareBackend implements HardwareBackend {
  readonly kind = 'mock' as const;
  readonly isPhysical = false;
  private connected = false;
  private now = 0;
  private lastCmdAt: number | null = null;
  private lastTelemetryAt: number | null = null;
  private outputs = offOutputs();
  private onSince: Partial<Record<PumpId, number>> = {};
  private maxOnMs: Partial<Record<PumpId, number>> = {};
  private armed = false;
  /** Fallo de enlace inyectado. */
  linkFault = false;
  estop = false;
  faults: string[] = [];
  writes: OutputFrame[] = [];

  constructor(
    private readSensors: () => Partial<Record<SensorId, number | null>>,
    private watchdogMs = 3000,
  ) {}

  connect(): void {
    this.connected = true;
  }
  disconnect(): void {
    this.connected = false;
    this.outputs = offOutputs();
    this.armed = false;
  }

  tick(now: number): void {
    this.now = now;
    if (!this.connected) return;
    // Watchdog del "firmware": sin órdenes recientes → todo apagado y desarmado.
    if (this.lastCmdAt !== null && now - this.lastCmdAt > this.watchdogMs) {
      this.outputs = offOutputs();
      this.armed = false;
    }
    // Corte local por tiempo máximo de bomba.
    for (const id of PUMP_IDS) {
      const since = this.onSince[id];
      const max = this.maxOnMs[id];
      if (this.outputs[id] && since !== undefined && max !== undefined && now - since > max) {
        this.outputs[id] = false;
        this.faults.push(`maxon:${id}`);
      }
    }
    if (this.estop) {
      this.outputs = offOutputs();
      this.armed = false;
    }
    if (!this.linkFault) this.lastTelemetryAt = now;
  }

  link(): BackendLink {
    return {
      connected: this.connected,
      lastHeartbeatAt: this.lastTelemetryAt,
      firmware: 'mock-esp32 (simulado)',
      deviceArmed: this.armed,
      estop: this.estop,
      faults: this.faults.slice(-10),
    };
  }

  latestSensors(): SensorFrame | null {
    if (!this.connected || this.lastTelemetryAt === null) return null;
    const vals = this.readSensors();
    const sensors: SensorFrame['sensors'] = {};
    for (const id of SENSOR_IDS) {
      const v = vals[id];
      sensors[id] = { raw: v ?? null, ok: v !== null && v !== undefined };
    }
    return { ts: this.lastTelemetryAt, sensors };
  }

  reportedOutputs(): Record<OutputId, boolean> | null {
    return this.connected ? { ...this.outputs } : null;
  }

  writeOutputs(frame: OutputFrame): void {
    this.writes.push(frame);
    if (this.writes.length > 100) this.writes.shift();
    if (!this.connected || this.linkFault) return; // trama perdida
    this.lastCmdAt = this.now;
    for (const [id, on] of Object.entries(frame.outputs) as [OutputId, boolean][]) {
      const allowed = on && this.armed && !this.estop;
      if (allowed && !this.outputs[id] && (PUMP_IDS as string[]).includes(id)) this.onSince[id as PumpId] = this.now;
      this.outputs[id] = allowed;
    }
    this.maxOnMs = { ...frame.maxOnMs };
  }

  requestArm(armed: boolean, token: string): void {
    if (!this.connected || this.linkFault) return;
    if (!armed) {
      this.armed = false;
      this.outputs = offOutputs();
      return;
    }
    if (token === 'ARMAR' && !this.estop) {
      this.armed = true;
      this.lastCmdAt = this.now;
    }
  }
}
