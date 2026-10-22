/**
 * Abstracción de hardware. El motor nunca habla directamente con un dispositivo:
 * usa `HardwareBackend` a través de `OutputGate`, que impone las reglas de
 * habilitación. Implementaciones:
 *  - MockHardwareBackend: "hardware simulado" en proceso (sin placa).
 *  - Esp32WsBackend: ESP32 real por WebSocket (protocolo v1).
 */
import type { OutputId, PumpId, SensorId, SystemMode } from '../core/types';
import { OUTPUT_IDS } from '../core/types';
import type { ConfigCmd, DeviceConfig, SensorSample } from './protocol';

export interface SensorFrame {
  /** Instante de recepción (reloj del motor). */
  ts: number;
  sensors: Partial<Record<SensorId, SensorSample>>;
}

export interface OutputFrame {
  seq: number;
  outputs: Record<OutputId, boolean>;
  maxOnMs: Partial<Record<PumpId, number>>;
}

export interface BackendLink {
  connected: boolean;
  /** El dispositivo aceptó la autenticación desafío-respuesta. */
  authenticated: boolean;
  authError: string | null;
  deviceConfig: DeviceConfig | null;
  lastHeartbeatAt: number | null;
  firmware: string;
  deviceArmed: boolean;
  estop: boolean;
  faults: string[];
}

export interface HardwareBackend {
  readonly kind: 'mock' | 'esp32-ws';
  /** true si puede accionar equipos físicos reales. */
  readonly isPhysical: boolean;
  connect(): void;
  disconnect(): void;
  /** Avance de reloj (heartbeats, timeouts). */
  tick(now: number): void;
  link(): BackendLink;
  latestSensors(): SensorFrame | null;
  reportedOutputs(): Record<OutputId, boolean> | null;
  writeOutputs(frame: OutputFrame): void;
  requestArm(armed: boolean, token: string): void;
  /** Cambia la configuración persistente del dispositivo (requiere desarmado). */
  sendConfig(cfg: Omit<ConfigCmd, 'type' | 'seq'>): void;
  /** Resultado de la última orden de configuración. */
  lastConfigResult(): { ok: boolean; error?: string } | null;
}

export function offOutputs(): Record<OutputId, boolean> {
  const o = {} as Record<OutputId, boolean>;
  for (const id of OUTPUT_IDS) o[id] = false;
  return o;
}

export interface GateContext {
  mode: SystemMode;
  armed: boolean;
  safeState: boolean;
  estop: boolean;
}

/**
 * Compuerta de salidas: único punto por el que una orden llega al hardware.
 * - Fuera del modo 'hardware' NO se envía nada (la simulación nunca acciona equipos).
 * - En modo 'hardware' sin armado, en estado seguro, con E-STOP o sin enlace
 *   solo se envían tramas con todas las salidas apagadas.
 */
export class OutputGate {
  sentFrames = 0;
  private seq = 1;
  constructor(public backend: HardwareBackend | null) {}

  send(frame: Omit<OutputFrame, 'seq'>, ctx: GateContext): OutputFrame | null {
    const b = this.backend;
    if (!b || ctx.mode !== 'hardware') return null;
    const link = b.link();
    const blocked = !ctx.armed || ctx.safeState || ctx.estop || !link.connected || !link.authenticated || link.estop;
    const out: OutputFrame = blocked
      ? { seq: this.seq++, outputs: offOutputs(), maxOnMs: {} }
      : { seq: this.seq++, outputs: { ...frame.outputs }, maxOnMs: { ...frame.maxOnMs } };
    try {
      b.writeOutputs(out);
      this.sentFrames++;
    } catch {
      /* el fallo de escritura se detecta por el enlace */
    }
    return out;
  }

  /** Orden explícita de apagado (al salir del modo hardware o ante un fallo). */
  forceOff(): void {
    const b = this.backend;
    if (!b) return;
    try {
      b.writeOutputs({ seq: this.seq++, outputs: offOutputs(), maxOnMs: {} });
    } catch {
      /* ignore */
    }
  }
}
