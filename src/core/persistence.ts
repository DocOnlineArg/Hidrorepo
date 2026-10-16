/**
 * Persistencia de configuración y estado mínimo de recuperación.
 * `ConfigStore` es la interfaz; hay implementaciones en memoria (pruebas) y
 * localStorage (navegador). En la ESP32 el equivalente es NVS (Preferences).
 */
import type { CalibrationState, PumpId, SensorId, SystemConfig, SystemMode } from './types';
import { SCHEMA_VERSION, createDefaultConfig } from './config';

export interface PersistedPump {
  levelMl: number;
  primed: boolean;
  totalDosedMl: number;
  opCount: number;
  locked: boolean;
  lockReason: string;
}

export interface PersistedState {
  schemaVersion: number;
  savedAt: number;
  config: SystemConfig;
  calibrations: Partial<Record<SensorId, CalibrationState>>;
  pumps: Partial<Record<PumpId, PersistedPump>>;
  simTime: number;
  mode: SystemMode;
  automationEnabled: boolean;
}

export interface ConfigStore {
  load(): PersistedState | null;
  save(state: PersistedState): void;
  clear(): void;
}

export class MemoryStore implements ConfigStore {
  private data: string | null = null;
  load(): PersistedState | null {
    return this.data ? (JSON.parse(this.data) as PersistedState) : null;
  }
  save(state: PersistedState): void {
    this.data = JSON.stringify(state);
  }
  clear(): void {
    this.data = null;
  }
}

export class LocalStorageStore implements ConfigStore {
  constructor(private key = 'hydro-sim/v1') {}
  load(): PersistedState | null {
    try {
      const raw = globalThis.localStorage?.getItem(this.key);
      return raw ? (JSON.parse(raw) as PersistedState) : null;
    } catch {
      return null;
    }
  }
  save(state: PersistedState): void {
    try {
      globalThis.localStorage?.setItem(this.key, JSON.stringify(state));
    } catch {
      /* almacenamiento no disponible: la app sigue funcionando sin persistir */
    }
  }
  clear(): void {
    try {
      globalThis.localStorage?.removeItem(this.key);
    } catch {
      /* ignore */
    }
  }
}

/** Fusiona una configuración importada con los valores por defecto (campos nuevos). */
export function migrateConfig(input: unknown): SystemConfig {
  const def = createDefaultConfig();
  if (!input || typeof input !== 'object') throw new Error('Configuración inválida');
  const merge = (base: unknown, over: unknown): unknown => {
    if (Array.isArray(base) || Array.isArray(over)) return over ?? base;
    if (base && typeof base === 'object' && over && typeof over === 'object') {
      const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
      for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = merge(out[k], v);
      return out;
    }
    return over === undefined ? base : over;
  };
  const cfg = merge(def, input) as SystemConfig;
  cfg.schemaVersion = SCHEMA_VERSION;
  return cfg;
}

export function exportConfigJson(cfg: SystemConfig): string {
  return JSON.stringify({ kind: 'hydro-sim-config', exportedAt: new Date().toISOString(), config: cfg }, null, 2);
}

export function importConfigJson(text: string): SystemConfig {
  const obj = JSON.parse(text) as { kind?: string; config?: unknown };
  if (obj.kind !== 'hydro-sim-config' || !obj.config) throw new Error('El archivo no es una configuración exportada por el simulador');
  return migrateConfig(obj.config);
}
