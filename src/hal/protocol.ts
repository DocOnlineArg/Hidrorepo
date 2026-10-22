/**
 * Protocolo JSON ESP32 ⇄ dashboard (WebSocket, un mensaje JSON por trama).
 * Versión 2 (añade autenticación y configuración remota). Documentado en docs/protocolo.md. El firmware implementa el mismo
 * contrato en firmware/esp32/src/main.cpp.
 */
import type { OutputId, PumpId, SensorId } from '../core/types';
import { OUTPUT_IDS, SENSOR_IDS } from '../core/types';

export const PROTOCOL_VERSION = 2;

export interface SensorSample {
  raw: number | null;
  ok: boolean;
}

/** Configuración persistente del dispositivo (NVS). */
export interface DeviceConfig {
  hbTimeoutMs: number;
  /** Máximo duro ON por bomba (ms), en el orden de PUMP_IDS. */
  pumpMaxMs: number[];
}

export interface HelloMsg {
  type: 'hello';
  proto: number;
  fw: string;
  board: string;
  resetReason: string;
  /** Desafío para la autenticación HMAC (hex). */
  nonce: string;
  config: DeviceConfig | null;
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
/** Respuesta al desafío: mac = hex(HMAC-SHA256(token, nonce)). */
export interface AuthCmd {
  type: 'auth';
  seq: number;
  mac: string;
}
/** Cambio de configuración persistente; el dispositivo exige estar desarmado. */
export interface ConfigCmd {
  type: 'config';
  seq: number;
  hbTimeoutMs?: number;
  pumpMaxMs?: number[];
  wifi?: { ssid: string; pass: string };
}
export type HostMsg = HeartbeatCmd | OutputsCmd | ArmCmd | AuthCmd | ConfigCmd;

/** Límites que el firmware también valida. */
export const DEVICE_LIMITS = { hbTimeoutMs: [1000, 10000], pumpMaxMs: [1000, 300000] } as const;

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
      if (o.proto !== PROTOCOL_VERSION) return { error: `Versión de protocolo no soportada (${o.proto}); se requiere ${PROTOCOL_VERSION}` };
      if (typeof o.nonce !== 'string' || !/^[0-9a-f]{16,64}$/.test(o.nonce)) return { error: 'hello sin desafío válido' };
      let config: DeviceConfig | null = null;
      if (isObj(o.config) && typeof o.config.hbTimeoutMs === 'number' && Array.isArray(o.config.pumpMaxMs))
        config = { hbTimeoutMs: o.config.hbTimeoutMs, pumpMaxMs: o.config.pumpMaxMs.map(Number) };
      return {
        type: 'hello',
        proto: o.proto,
        fw: o.fw,
        board: String(o.board ?? ''),
        resetReason: String(o.resetReason ?? ''),
        nonce: o.nonce,
        config,
      };
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
