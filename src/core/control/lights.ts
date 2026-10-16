/**
 * Temporizador de iluminación. El estado se deriva SOLO de la hora y del horario
 * configurado (no de contadores), por lo que un reinicio no altera el ciclo.
 */
import { formatHHMM, minuteOfDay, parseHHMM } from '../util';

export interface LightSchedule {
  onTime: string | null;
  photoperiodH: number | null;
}

export interface LightScheduleInfo {
  configured: boolean;
  on: boolean;
  onMinute: number | null;
  offMinute: number | null;
  offTime: string | null;
  lightH: number | null;
  darkH: number | null;
  minutesToNextChange: number | null;
}

export function scheduleInfo(s: LightSchedule, t: number): LightScheduleInfo {
  const onMin = parseHHMM(s.onTime);
  const ph = s.photoperiodH;
  if (onMin === null || ph === null || !(ph >= 0 && ph <= 24)) {
    return {
      configured: false,
      on: false,
      onMinute: null,
      offMinute: null,
      offTime: null,
      lightH: null,
      darkH: null,
      minutesToNextChange: null,
    };
  }
  const durMin = Math.round(ph * 60);
  const offMin = (onMin + durMin) % 1440;
  const now = minuteOfDay(t);
  const sinceOn = (now - onMin + 1440) % 1440;
  const on = durMin >= 1440 ? true : durMin <= 0 ? false : sinceOn < durMin;
  let next: number | null = null;
  if (durMin > 0 && durMin < 1440) next = on ? durMin - sinceOn : 1440 - sinceOn;
  return {
    configured: true,
    on,
    onMinute: onMin,
    offMinute: offMin,
    offTime: formatHHMM(offMin),
    lightH: ph,
    darkH: 24 - ph,
    minutesToNextChange: next,
  };
}

/** Calcula el fotoperiodo a partir de horas de encendido y apagado. */
export function photoperiodFromTimes(onTime: string, offTime: string): number | null {
  const a = parseHHMM(onTime);
  const b = parseHHMM(offTime);
  if (a === null || b === null) return null;
  const d = (b - a + 1440) % 1440;
  return d / 60;
}
