/**
 * Comparación de escenarios: ejecuta el mismo escenario (misma semilla) con la
 * automatización activada y desactivada y resume las diferencias.
 */
import { Engine } from './engine';
import { loadScenario } from './scenarios';
import type { Series } from './history';
import type { SensorId } from './types';
import { PUMP_IDS, RELAY_IDS, SENSOR_IDS } from './types';

export interface RunSummary {
  timeInBand: Partial<Record<SensorId, number | null>>;
  doses: number;
  dosedMl: number;
  relayCycles: number;
  alarmsRaised: number;
  safeState: boolean;
}

export interface ComparisonResult {
  scenarioId: string;
  hours: number;
  on: { summary: RunSummary; series: Record<string, Series> };
  off: { summary: RunSummary; series: Record<string, Series> };
}

const KEYS = ['ph', 'ec', 'orp', 'airTemp', 'rh', 'waterTemp'];

function run(scenarioId: string, hours: number, automation: boolean): { summary: RunSummary; series: Record<string, Series> } {
  const e = new Engine({ seed: 777 });
  loadScenario(e, scenarioId);
  e.setAutomation(automation);
  e.history.intervalS = 60;
  e.advance(hours * 3600);
  const p = e.profile;
  const timeInBand: RunSummary['timeInBand'] = {};
  for (const id of SENSOR_IDS) {
    const band = id === 'airTemp' ? p.climate.airTemp : id === 'rh' ? p.climate.rh : (p.reservoir as Record<string, typeof p.climate.rh>)[id];
    if (!band || band.target === null || band.deadband === null) {
      timeInBand[id] = null;
      continue;
    }
    const s = e.history.get(`truth.${id}`);
    const n = s.v.length;
    const inBand = s.v.filter((v) => v !== null && Math.abs(v - (band.target as number)) <= (band.deadband as number)).length;
    timeInBand[id] = n ? inBand / n : null;
  }
  const series: Record<string, Series> = {};
  for (const k of KEYS) series[k] = e.history.get(`truth.${k}`);
  return {
    summary: {
      timeInBand,
      doses: PUMP_IDS.reduce((a, id) => a + e.pumps[id].opCount, 0),
      dosedMl: PUMP_IDS.reduce((a, id) => a + e.pumps[id].totalDosedMl, 0),
      relayCycles: RELAY_IDS.reduce((a, id) => a + e.relays[id].cycles, 0),
      alarmsRaised: e.alarms.alarms.length,
      safeState: e.safeState,
    },
    series,
  };
}

export function runComparison(scenarioId: string, hours: number): ComparisonResult {
  return { scenarioId, hours, on: run(scenarioId, hours, true), off: run(scenarioId, hours, false) };
}
