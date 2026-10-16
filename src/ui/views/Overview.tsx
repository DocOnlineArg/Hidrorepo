import { useEngine } from '../context';
import { Card, Chip, STATUS_LABEL, severityTone, statusTone, SEVERITY_LABEL } from '../components/common';
import { Schematic } from '../components/Schematic';
import { PUMP_IDS, RELAY_IDS, SENSOR_IDS } from '../../core/types';
import { formatSimTime } from '../../core/util';
import { bandFor, fmtSensor, unitOf } from './shared';
import { LOOP_LABEL } from '../../core/control/chemistry';

const RELAY_LABEL = { humidifier: 'Humidificador', dehumidifier: 'Deshumidificador', fan: 'Ventilador', lights: 'Luces' };

export function OverviewView({ onSelect }: { onSelect: (t: string) => void }) {
  const { engine: e } = useEngine();
  const alarms = e.alarms.active().sort((a, b) => (a.severity === b.severity ? b.raisedAt - a.raisedAt : a.severity === 'critical' ? -1 : 1));
  const events = e.log.events.slice(-12).reverse();
  return (
    <>
      <div className="section-title">
        <h2>Vista general</h2>
        <small>Escenario: {e.scenarioId} · modo {e.mode}</small>
      </div>
      {e.scenarioId === 'blank' && !e.profile.validated && (
        <div className="note warn">
          Instalación sin configurar: las sondas de pH/EC/ORP no están calibradas y el perfil no tiene objetivos. La automatización no actuará hasta que configure y valide un perfil y calibre las sondas.
          Para ver la lógica en marcha cargue el escenario <button className="btn small" onClick={() => onSelect('lab')}>Demostración</button> en el Laboratorio.
        </div>
      )}
      <div className="grid hero">
        <Card title="Instalación">
          <Schematic engine={e} onSelect={onSelect} />
        </Card>
        <div className="col">
          <Card title="Sensores" extra={<button className="btn small" onClick={() => onSelect('sensors')}>Detalle</button>}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th className="num">Valor</th>
                    <th className="num">Objetivo</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {SENSOR_IDS.map((id) => {
                    const r = e.sensors[id].reading;
                    const b = bandFor(e, id);
                    return (
                      <tr key={id}>
                        <td>{e.config.sensors[id].label}</td>
                        <td className="num">
                          {fmtSensor(e, id, r.value)} <small>{unitOf(e, id)}</small>
                        </td>
                        <td className="num">{b.target === null ? <small>sin configurar</small> : `${fmtSensor(e, id, b.target)} ± ${b.deadband === null ? '—' : fmtSensor(e, id, b.deadband)}`}</td>
                        <td>
                          <Chip tone={statusTone(r.status)}>{STATUS_LABEL[r.status]}</Chip> {r.source === 'manual' && <Chip tone="info">MANUAL</Chip>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Actuadores">
            <div className="row">
              {RELAY_IDS.map((id) => (
                <Chip key={id} tone={e.relays[id].on ? 'ok' : ''}>
                  <span className="dot" /> {RELAY_LABEL[id]} {e.relays[id].on ? 'ON' : 'OFF'}
                  {e.config.climate[id].mode === 'manual' ? ' (man.)' : ''}
                </Chip>
              ))}
            </div>
            <div className="row">
              {PUMP_IDS.map((id) => {
                const rt = e.pumps[id];
                const tone = rt.running ? 'ok' : rt.locked ? 'bad' : !rt.primed ? 'warn' : '';
                return (
                  <Chip key={id} tone={tone} title={rt.locked ? rt.lockReason : undefined}>
                    {e.config.liquids[id].name}
                    {rt.running ? ' ▶' : rt.locked ? ' ⛔' : !rt.primed ? ' (sin cebar)' : ''}
                  </Chip>
                );
              })}
            </div>
            <div className="row">
              {(['ec', 'ph', 'orp'] as const).map((l) => (
                <Chip key={l} tone={e.chem.loops[l].phase === 'locked_out' || e.chem.loops[l].phase === 'blocked' ? 'warn' : e.chem.loops[l].phase === 'idle' ? 'ok' : 'info'}>
                  Lazo {LOOP_LABEL[l]}: {e.chem.loops[l].phase}
                </Chip>
              ))}
            </div>
          </Card>
        </div>
      </div>
      <div className="grid wide">
        <Card title={`Alarmas activas (${alarms.length})`} tone={alarms.some((a) => a.severity === 'critical') ? 'alert' : undefined}>
          {alarms.length === 0 ? (
            <small>Sin alarmas activas</small>
          ) : (
            <ul className="event-list">
              {alarms.slice(0, 10).map((a) => (
                <li key={a.id}>
                  <Chip tone={severityTone(a.severity)}>{SEVERITY_LABEL[a.severity]}</Chip>
                  <span>
                    <strong>{a.message}</strong>
                    <br />
                    <small>
                      {formatSimTime(a.raisedAt)} · {a.cause} · Acción: {a.actionTaken}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Eventos recientes" extra={<button className="btn small" onClick={() => onSelect('log')}>Registro</button>}>
          <ul className="event-list">
            {events.map((ev) => (
              <li key={ev.id}>
                <time>{formatSimTime(ev.t, false)}</time>
                <span>
                  <small>{ev.source}:</small> {ev.message}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
