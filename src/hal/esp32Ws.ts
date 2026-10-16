/**
 * Backend para una ESP32 real por WebSocket (protocolo v1).
 * El transporte es inyectable para poder probarlo sin placa ni red.
 */
import type { OutputId } from '../core/types';
import type { BackendLink, HardwareBackend, OutputFrame, SensorFrame } from './backend';
import type { HostMsg, TelemetryMsg } from './protocol';
import { encodeHost, parseDevice } from './protocol';

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
  protocolErrors: string[] = [];

  constructor(
    public url: string,
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
    if (m.type === 'hello') this.fw = `${m.fw} (${m.board}) reset: ${m.resetReason}`;
    else if (m.type === 'telemetry') {
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
    this.send({ type: 'outputs', seq: frame.seq, outputs: frame.outputs, maxOnMs: frame.maxOnMs });
  }

  requestArm(armed: boolean, token: string): void {
    this.send({ type: 'arm', seq: this.seq++, armed, token });
  }
}
