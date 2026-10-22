/**
 * Backend para una ESP32 real por WebSocket (protocolo v1).
 * El transporte es inyectable para poder probarlo sin placa ni red.
 */
import type { OutputId } from '../core/types';
import type { BackendLink, HardwareBackend, OutputFrame, SensorFrame } from './backend';
import type { ConfigCmd, DeviceConfig, HostMsg, TelemetryMsg } from './protocol';
import { encodeHost, parseDevice } from './protocol';
import { authResponse } from './hmac';

export interface Transport {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
}

export type TransportFactory = (url: string) => Transport;

/** Adaptador para el WebSocket del navegador. */
export const browserWebSocket: TransportFactory = (url) => {
  const ws = new WebSocket(url);
  const t: Transport = {
    send: (d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    },
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.onopen = () => t.onopen?.();
  ws.onmessage = (ev) => t.onmessage?.(String(ev.data));
  ws.onclose = () => t.onclose?.();
  ws.onerror = () => t.onclose?.();
  return t;
};

export class Esp32WsBackend implements HardwareBackend {
  readonly kind = 'esp32-ws' as const;
  readonly isPhysical = true;
  private transport: Transport | null = null;
  private open = false;
  private now = 0;
  private seq = 1;
  private lastHbSentAt = -Infinity;
  private telemetry: TelemetryMsg | null = null;
  private telemetryAt: number | null = null;
  private fw = '';
  private authenticated = false;
  private authError: string | null = null;
  private authSeq: number | null = null;
  private configSeq: number | null = null;
  private configResult: { ok: boolean; error?: string } | null = null;
  private deviceConfig: DeviceConfig | null = null;
  protocolErrors: string[] = [];

  /**
   * @param token token de emparejamiento que la ESP32 muestra por el puerto serie en su
   *              primer arranque. Nunca se transmite: solo HMAC(token, desafío).
   */
  constructor(
    public url: string,
    private token: string,
    private factory: TransportFactory = browserWebSocket,
  ) {}

  connect(): void {
    this.disconnect();
    const t = this.factory(this.url);
    this.transport = t;
    t.onopen = () => {
      this.open = true;
    };
    t.onclose = () => {
      this.open = false;
      this.authenticated = false;
    };
    t.onmessage = (data) => this.handle(data);
  }

  disconnect(): void {
    if (this.transport) {
      this.transport.onclose = null;
      this.transport.close();
    }
    this.transport = null;
    this.open = false;
    this.authenticated = false;
    this.telemetry = null;
    this.telemetryAt = null;
  }

  private send(msg: HostMsg): void {
    if (this.open && this.transport) this.transport.send(encodeHost(msg));
  }

  private handle(data: string): void {
    const m = parseDevice(data);
    if (!('type' in m)) {
      this.protocolErrors.push(m.error);
      if (this.protocolErrors.length > 50) this.protocolErrors.shift();
      return;
    }
    if (m.type === 'hello') {
      this.fw = `${m.fw} (${m.board}) reset: ${m.resetReason}`;
      this.deviceConfig = m.config;
      this.authenticated = false;
      this.authError = null;
      this.authSeq = this.seq++;
      this.send({ type: 'auth', seq: this.authSeq, mac: authResponse(this.token, m.nonce) });
    } else if (m.type === 'ack') {
      if (m.seq === this.authSeq) {
        this.authenticated = m.ok;
        this.authError = m.ok ? null : (m.error ?? 'Autenticación rechazada (token incorrecto)');
        this.authSeq = null;
      } else if (m.seq === this.configSeq) {
        this.configResult = { ok: m.ok, error: m.error };
        this.configSeq = null;
      }
    } else if (m.type === 'telemetry') {
      this.telemetry = m;
      this.telemetryAt = this.now;
    }
  }

  tick(now: number): void {
    this.now = now;
    if (now - this.lastHbSentAt >= 1000) {
      this.send({ type: 'heartbeat', seq: this.seq++ });
      this.lastHbSentAt = now;
    }
  }

  link(): BackendLink {
    return {
      connected: this.open,
      authenticated: this.authenticated,
      authError: this.authError,
      deviceConfig: this.deviceConfig,
      lastHeartbeatAt: this.telemetryAt,
      firmware: this.fw || '—',
      deviceArmed: this.telemetry?.armed ?? false,
      estop: this.telemetry?.estop ?? false,
      faults: this.telemetry?.faults ?? [],
    };
  }

  latestSensors(): SensorFrame | null {
    if (!this.telemetry || this.telemetryAt === null) return null;
    return { ts: this.telemetryAt, sensors: this.telemetry.sensors };
  }

  reportedOutputs(): Record<OutputId, boolean> | null {
    if (!this.telemetry) return null;
    return this.telemetry.outputs as Record<OutputId, boolean>;
  }

  writeOutputs(frame: OutputFrame): void {
    if (!this.authenticated) return;
    this.send({ type: 'outputs', seq: frame.seq, outputs: frame.outputs, maxOnMs: frame.maxOnMs });
  }

  requestArm(armed: boolean, token: string): void {
    if (!this.authenticated) return;
    this.send({ type: 'arm', seq: this.seq++, armed, token });
  }

  sendConfig(cfg: Omit<ConfigCmd, 'type' | 'seq'>): void {
    if (!this.authenticated) {
      this.configResult = { ok: false, error: 'No autenticado' };
      return;
    }
    this.configSeq = this.seq++;
    this.configResult = null;
    this.send({ type: 'config', seq: this.configSeq, ...cfg });
    if (cfg.hbTimeoutMs !== undefined || cfg.pumpMaxMs) {
      // Se refleja en cuanto llegue el ack; el próximo hello trae la configuración real.
    }
  }

  lastConfigResult() {
    return this.configResult;
  }
}
