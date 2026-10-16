/** Gestor de alarmas y registro de eventos. */
import type { Alarm, EventCategory, LogEvent, Severity } from './types';

export interface AlarmInput {
  key: string;
  code: string;
  severity: Severity;
  source: string;
  message: string;
  cause: string;
  actionTaken: string;
}

export class EventLog {
  events: LogEvent[] = [];
  private nextId = 1;
  constructor(private max = 2000) {}
  add(t: number, category: EventCategory, source: string, message: string): LogEvent {
    const e: LogEvent = { id: this.nextId++, t, category, source, message };
    this.events.push(e);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    return e;
  }
}

export class AlarmManager {
  /** Todas las alarmas (activas e históricas), más recientes al final. */
  alarms: Alarm[] = [];
  private activeByKey = new Map<string, Alarm>();
  private nextId = 1;
  constructor(
    private log: EventLog,
    private max = 1000,
  ) {}

  active(): Alarm[] {
    return [...this.activeByKey.values()];
  }

  isActive(key: string): boolean {
    return this.activeByKey.has(key);
  }

  /** Activa (o refresca) una alarma. Devuelve true si es nueva. */
  raise(t: number, a: AlarmInput): boolean {
    const existing = this.activeByKey.get(a.key);
    if (existing) {
      existing.lastSeenAt = t;
      existing.message = a.message;
      return false;
    }
    const alarm: Alarm = {
      id: this.nextId++,
      ...a,
      raisedAt: t,
      lastSeenAt: t,
      clearedAt: null,
      acknowledgedAt: null,
      active: true,
    };
    this.alarms.push(alarm);
    this.activeByKey.set(a.key, alarm);
    if (this.alarms.length > this.max) {
      const idx = this.alarms.findIndex((x) => !x.active);
      if (idx >= 0) this.alarms.splice(idx, 1);
    }
    this.log.add(t, 'alarm', a.source, `[${a.severity.toUpperCase()}] ${a.message} — causa: ${a.cause} — acción: ${a.actionTaken}`);
    return true;
  }

  /** Mantiene una alarma según una condición (raise si true, clear si false). */
  set(t: number, cond: boolean, a: AlarmInput): void {
    if (cond) this.raise(t, a);
    else this.clear(t, a.key);
  }

  clear(t: number, key: string): void {
    const a = this.activeByKey.get(key);
    if (!a) return;
    this.activeByKey.delete(key);
    a.active = false;
    a.clearedAt = t;
    this.log.add(t, 'alarm', a.source, `Alarma normalizada: ${a.message}`);
  }

  clearPrefix(t: number, prefix: string): void {
    for (const key of [...this.activeByKey.keys()]) if (key.startsWith(prefix)) this.clear(t, key);
  }

  acknowledge(t: number, id: number): void {
    const a = this.alarms.find((x) => x.id === id);
    if (a && a.acknowledgedAt === null) a.acknowledgedAt = t;
  }
}
