/** Representación gráfica de la instalación (estado en vivo). */
import type { Engine } from '../../core/engine';
import type { PumpId, SensorId } from '../../core/types';
import { PUMP_IDS } from '../../core/types';
import { ecToDisplay } from '../../core/util';
import { statusTone } from './common';

const SHORT: Record<PumpId, string> = { phUp: 'pH+', phDown: 'pH−', oxidant: 'Ox', solA: 'A', solB: 'B', bloom: 'Bl', silicon: 'Si', pk: 'PK' };
const TONE_COLOR = { ok: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', info: 'var(--info)', accent: 'var(--accent)', '': 'var(--muted)' };

export function Schematic({ engine: e, onSelect }: { engine: Engine; onSelect?: (tab: string) => void }) {
  const r = e.relays;
  const ecUnit = e.config.ecDisplayUnit;
  const fmt = (id: SensorId) => {
    const rd = e.sensors[id].reading;
    if (rd.value === null) return '—';
    const c = e.config.sensors[id];
    if (id === 'ec') return `${ecToDisplay(rd.value, ecUnit).toFixed(ecUnit === 'µS/cm' ? 0 : 2)}`;
    return rd.value.toFixed(Math.min(c.decimals, 2));
  };
  const tag = (x: number, y: number, id: SensorId, label: string, unit: string) => {
    const st = e.sensors[id].reading.status;
    const color = TONE_COLOR[statusTone(st)];
    return (
      <g transform={`translate(${x},${y})`} style={{ cursor: onSelect ? 'pointer' : undefined }} onClick={() => onSelect?.('sensors')}>
        <rect width="92" height="34" rx="6" fill="var(--surface)" stroke={color} strokeWidth="2" />
        <text x="8" y="13" fontSize="10" fill="var(--muted)">
          {label}
        </text>
        <text x="8" y="28" fontSize="13" fontWeight="700" fill="var(--text)">
          {fmt(id)} <tspan fontSize="9" fill="var(--muted)">{unit}</tspan>
        </text>
        <title>{`${label}: ${st}`}</title>
      </g>
    );
  };
  const vol = e.plant.state.volumeL;
  const fillH = Math.max(4, Math.min(100, (vol / 150) * 100));
  const anyPump = PUMP_IDS.some((id) => e.pumps[id].running);
  const lampOn = r.lights.on;

  return (
    <div className="schematic">
      <svg viewBox="0 0 820 440" role="img" aria-label="Esquema de la instalación hidropónica">
        {/* Sala */}
        <rect x="16" y="16" width="480" height="250" rx="10" fill="var(--surface-2)" stroke="var(--border)" />
        <text x="28" y="36" fontSize="12" fill="var(--muted)">
          Sala de cultivo · perfil {e.profile.name}
        </text>
        {/* Lámpara */}
        {lampOn && <polygon points="160,52 340,52 420,190 80,190" fill="#f5c542" opacity="0.13" />}
        <rect x="160" y="40" width="180" height="14" rx="4" fill={lampOn ? '#f5c542' : '#64748b'} stroke="var(--border)" />
        <text x="250" y="70" fontSize="11" textAnchor="middle" fill="var(--muted)">
          Luces {lampOn ? 'ON' : 'OFF'}
        </text>
        {/* Plantas */}
        {[150, 250, 350].map((x) => (
          <g key={x} transform={`translate(${x},210)`}>
            <rect x="-22" y="20" width="44" height="22" rx="3" fill="var(--border)" />
            <ellipse cx="0" cy="8" rx="26" ry="16" fill="var(--ok)" opacity="0.75" />
            <ellipse cx="-12" cy="-4" rx="12" ry="9" fill="var(--ok)" opacity="0.6" />
            <ellipse cx="12" cy="-6" rx="12" ry="9" fill="var(--ok)" opacity="0.6" />
          </g>
        ))}
        {/* Ventilador */}
        <g transform="translate(462,96)">
          <circle r="24" fill="var(--surface)" stroke={r.fan.on ? 'var(--accent)' : 'var(--border)'} strokeWidth="3" />
          <g>
            {[0, 120, 240].map((a) => (
              <ellipse key={a} rx="5" ry="15" fill={r.fan.on ? 'var(--accent)' : 'var(--muted)'} transform={`rotate(${a}) translate(0,-9)`} opacity="0.85" />
            ))}
            {r.fan.on && <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1s" repeatCount="indefinite" />}
          </g>
          <text y="40" fontSize="10" textAnchor="middle" fill="var(--muted)">
            Ventilador
          </text>
        </g>
        {/* Humidificador */}
        <g transform="translate(34,196)">
          {r.humidifier.on && (
            <g fill="var(--info)" opacity="0.5">
              <circle cx="18" cy="-8" r="6" />
              <circle cx="30" cy="-16" r="8" />
              <circle cx="42" cy="-6" r="5" />
            </g>
          )}
          <rect width="60" height="48" rx="6" fill="var(--surface)" stroke={r.humidifier.on ? 'var(--info)' : 'var(--border)'} strokeWidth="2.5" />
          <text x="30" y="28" fontSize="10" textAnchor="middle" fill="var(--text)">
            Humid.
          </text>
          <text x="30" y="41" fontSize="9" textAnchor="middle" fill="var(--muted)">
            {r.humidifier.on ? 'ON' : 'OFF'}
          </text>
        </g>
        {/* Deshumidificador */}
        <g transform="translate(404,196)">
          <rect width="72" height="56" rx="6" fill="var(--surface)" stroke={r.dehumidifier.on ? 'var(--warn)' : 'var(--border)'} strokeWidth="2.5" />
          <text x="36" y="28" fontSize="10" textAnchor="middle" fill="var(--text)">
            Deshumid.
          </text>
          <text x="36" y="42" fontSize="9" textAnchor="middle" fill="var(--muted)">
            {r.dehumidifier.on ? 'ON' : 'OFF'}
          </text>
        </g>
        {tag(28, 90, 'airTemp', 'Temp. aire', '°C')}
        {tag(28, 130, 'rh', 'Humedad', '%')}

        {/* Riego */}
        <path d="M250,300 L250,262" stroke="var(--water)" strokeWidth="4" />
        {/* Depósito */}
        <rect x="120" y="300" width="260" height="110" rx="8" fill="var(--surface)" stroke="var(--border)" strokeWidth="2" />
        <rect x="122" y={408 - fillH} width="256" height={fillH} rx="6" fill="var(--water)" opacity="0.35" />
        <text x="130" y="318" fontSize="11" fill="var(--muted)">
          Depósito · {vol.toFixed(1)} L (modelo)
        </text>
        {tag(130, 326, 'ph', 'pH', '')}
        {tag(228, 326, 'ec', 'EC', ecUnit)}
        {tag(130, 366, 'orp', 'ORP', 'mV')}
        {tag(228, 366, 'waterTemp', 'Temp. agua', '°C')}

        {/* Colector y bombas */}
        <path d="M380,330 L404,330 L404,286 L802,286" fill="none" stroke={anyPump ? 'var(--accent)' : 'var(--border)'} strokeWidth="3" />
        {PUMP_IDS.map((id, i) => {
          const x = 420 + i * 48;
          const rt = e.pumps[id];
          const pc = e.config.pumps[id];
          const liq = e.config.liquids[id];
          const lvl = Math.max(0, Math.min(1, rt.levelMl / pc.containerCapacityMl));
          const empty = rt.levelMl <= pc.emptyThresholdMl;
          return (
            <g key={id} style={{ cursor: onSelect ? 'pointer' : undefined }} onClick={() => onSelect?.('dosing')}>
              <title>{`${pc.label}: ${rt.levelMl.toFixed(0)} mL${rt.running ? ' · EN MARCHA' : ''}${rt.locked ? ' · BLOQUEADA' : ''}`}</title>
              <line x1={x + 16} x2={x + 16} y1="286" y2="318" stroke={rt.running ? liq.color : 'var(--border)'} strokeWidth={rt.running ? 4 : 2} />
              <circle cx={x + 16} cy="304" r="7" fill={rt.running ? liq.color : 'var(--surface)'} stroke={rt.locked ? 'var(--bad)' : liq.color} strokeWidth="2" />
              <rect x={x} y="320" width="32" height="90" rx="5" fill="var(--surface)" stroke={empty ? 'var(--bad)' : 'var(--border)'} strokeWidth={empty ? 2.5 : 1.5} />
              <rect x={x + 2} y={408 - 86 * lvl} width="28" height={86 * lvl} rx="3" fill={liq.color} opacity="0.7" />
              <text x={x + 16} y="428" fontSize="11" textAnchor="middle" fill="var(--text)" fontWeight="600">
                {SHORT[id]}
              </text>
              {rt.locked && (
                <text x={x + 16} y="345" fontSize="14" textAnchor="middle" fill="var(--bad)">
                  ⨯
                </text>
              )}
            </g>
          );
        })}
        <text x="420" y="276" fontSize="11" fill="var(--muted)">
          Bombas dosificadoras (8)
        </text>
      </svg>
    </div>
  );
}
