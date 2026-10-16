/**
 * Protocolo JSON ESP32 ⇄ dashboard (WebSocket, un mensaje JSON por trama).
 * Versión 1. Documentado en docs/protocolo.md. El firmware implementa el mismo
 * contrato en firmware/esp32/src/main.cpp.
 */
import type { OutputId, PumpId, SensorId } from '../core/types';
import { OUTPUT_IDS, SENSOR_IDS } from '../core/types';

export const PROTOCOL_VERSION = 1;

export interface SensorSample {
  raw: number | null;
  ok: boolean;
}

export interface HelloMsg {
  type: 'hello';
  proto: number;
  fw: string;
  board: string;
  resetReason: string;
}

export interface TelemetryMsg {
  type: 'telemetry';
  seq: number;
  uptimeMs: number;
  sensors: Partial<Record<SensorId, SensorSample>>;
  outputs: Partial<Record<OutputId, boolean>>;
  armed: boolean;
  estop: boolean;
  faults: string[];
}

export interface AckMsg {
  type: 'ack';
  seq: number;
  ok: boolean;
  error?: string;
}

export type DeviceMsg = HelloMsg | TelemetryMsg | AckMsg;

export interface HeartbeatCmd {
  type: 'heartbeat';
  seq: number;
}
export interface OutputsCmd {
  type: 'outputs';
  seq: number;
  outputs: Record<OutputId, boolean>;
  /** Tiempo máximo ON que el firmware aplicará localmente a cada bomba. */
  maxOnMs: Partial<Record<PumpId, number>>;
}
export interface ArmCmd {
  type: 'arm';
  seq: number;
  armed: boolean;
  /** Frase de confirmación; el firmware exige 'ARMAR' para habilitar salidas. */
  token: string;
}
export type HostMsg = HeartbeatCmd | OutputsCmd | ArmCmd;

export function encodeHost(msg: HostMsg): string {
  return JSON.stringify(msg);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Valida estrictamente un mensaje del dispositivo. Nunca lanza. */
export function parseDevice(text: string): DeviceMsg | { error: string } {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return { error: 'JSON inválido' };
  }
  if (!isObj(o) || typeof o.type !== 'string') return { error: 'Mensaje sin tipo' };
  switch (o.type) {
    case 'hello':
      if (typeof o.proto !== 'number' || typeof o.fw !== 'string') return { error: 'hello incompleto' };
      if (o.proto !== PROTOCOL_VERSION) return { error: `Versión de protocolo no soportada (${o.proto})` };
      return { type: 'hello', proto: o.proto, fw: o.fw, board: String(o.board ?? ''), resetReason: String(o.resetReason ?? '') };
    case 'telemetry': {
      if (typeof o.seq !== 'number' || !isObj(o.sensors) || !isObj(o.outputs)) return { error: 'telemetry incompleta' };
      const sensors: Partial<Record<SensorId, SensorSample>> = {};
      for (const id of SENSOR_IDS) {
        const s = o.sensors[id];
        if (!isObj(s)) continue;
        const raw = typeof s.raw === 'number' && Number.isFinite(s.raw) ? s.raw : null;
        sensors[id] = { raw, ok: s.ok === true && raw !== null };
      }
      const outputs: Partial<Record<OutputId, boolean>> = {};
      for (const id of OUTPUT_IDS) if (typeof o.outputs[id] === 'boolean') outputs[id] = o.outputs[id] as boolean;
      return {
        type: 'telemetry',
        seq: o.seq,
        uptimeMs: typeof o.uptimeMs === 'number' ? o.uptimeMs : 0,
        sensors,
        outputs,
        armed: o.armed === true,
        estop: o.estop === true,
        faults: Array.isArray(o.faults) ? o.faults.map(String) : [],
      };
    }
    case 'ack':
      if (typeof o.seq !== 'number') return { error: 'ack incompleto' };
      return { type: 'ack', seq: o.seq, ok: o.ok === true, error: typeof o.error === 'string' ? o.error : undefined };
    default:
      return { error: `Tipo desconocido: ${o.type}` };
  }
}
