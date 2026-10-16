import type { Engine } from '../../core/engine';
import type { Band, SensorId } from '../../core/types';
import { ecToDisplay } from '../../core/util';

export const HOURS_OPTIONS = [
  { value: '1', label: '1 h' },
  { value: '6', label: '6 h' },
  { value: '24', label: '24 h' },
];

export function bandFor(e: Engine, id: SensorId): Band {
  const p = e.profile;
  if (id === 'airTemp') return p.climate.airTemp;
  if (id === 'rh') return p.climate.rh;
  return p.reservoir[id];
}

/** Formatea un valor de sensor en su unidad de visualización. */
export function fmtSensor(e: Engine, id: SensorId, v: number | null, withUnit = false): string {
  if (v === null) return '—';
  const c = e.config.sensors[id];
  if (id === 'ec') {
    const u = e.config.ecDisplayUnit;
    const s = ecToDisplay(v, u).toFixed(u === 'µS/cm' ? 0 : 3);
    return withUnit ? `${s} ${u}` : s;
  }
  const s = v.toFixed(c.decimals);
  return withUnit ? `${s} ${c.unit}` : s;
}

export function unitOf(e: Engine, id: SensorId): string {
  return id === 'ec' ? e.config.ecDisplayUnit : e.config.sensors[id].unit;
}

export function mapFor(e: Engine, id: SensorId): ((v: number) => number) | undefined {
  return id === 'ec' && e.config.ecDisplayUnit === 'µS/cm' ? (v) => v * 1000 : undefined;
}
