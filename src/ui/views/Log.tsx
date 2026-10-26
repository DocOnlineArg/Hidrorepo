import { useState } from 'react';
import { exportText } from '../dialog';
import { useEngine } from '../context';
import { Card, Chip, SEVERITY_LABEL, severityTone } from '../components/common';
import type { EventCategory } from '../../core/types';
import { formatSimTime } from '../../core/util';

const CATS: EventCategory[] = ['system', 'sensor', 'pump', 'relay', 'control', 'safety', 'alarm', 'profile', 'lab', 'hardware', 'config'];
const csv = (rows: (string | number | null)[][]) => rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

export function LogView() {
  const { engine: e } = useEngine();
  const [cat, setCat] = useState<EventCategory | 'all'>('all');
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(false);
  const alarms = [...e.alarms.alarms].filter((a) => !onlyActive || a.active).reverse();
  const events = e.log.events
    .filter((ev) => (cat === 'all' || ev.category === cat) && (!q || `${ev.source} ${ev.message}`.toLowerCase().includes(q.toLowerCase())))
    .slice(-400)
    .reverse();
  return (
    <>
      <div className="section-title">
        <h2>Alarmas y eventos</h2>
        <div className="row">
          <button
            className="btn small"
            onClick={() =>
              exportText(
                'alarmas.csv',
                csv([
                  ['id', 'codigo', 'severidad', 'origen', 'mensaje', 'causa', 'accion', 'activada', 'normalizada', 'reconocida'],
                  ...e.alarms.alarms.map((a) => [a.id, a.code, a.severity, a.source, a.message, a.cause, a.actionTaken, formatSimTime(a.raisedAt), a.clearedAt ? formatSimTime(a.clearedAt) : '', a.acknowledgedAt ? formatSimTime(a.acknowledgedAt) : '']),
                ]),
                'text/csv',
              )
            }
          >
            Exportar alarmas CSV
          </button>
          <button className="btn small" onClick={() => exportText('eventos.csv', csv([['t', 'categoria', 'origen', 'mensaje'], ...e.log.events.map((ev) => [formatSimTime(ev.t), ev.category, ev.source, ev.message])]), 'text/csv')}>
            Exportar eventos CSV
          </button>
        </div>
      </div>
      <Card title={`Alarmas (${e.alarms.active().length} activas, ${e.alarms.alarms.length} registradas)`} extra={<label className="check"><input type="checkbox" checked={onlyActive} onChange={(ev) => setOnlyActive(ev.target.checked)} />Solo activas</label>}>
        <div className="scroll table-wrap">
          <table>
            <thead>
              <tr>
                <th>Activada</th>
                <th>Severidad</th>
                <th>Origen</th>
                <th>Mensaje / causa</th>
                <th>Acción tomada</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {alarms.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{formatSimTime(a.raisedAt)}</td>
                  <td>
                    <Chip tone={severityTone(a.severity)}>{SEVERITY_LABEL[a.severity]}</Chip>
                  </td>
                  <td>{a.source}</td>
                  <td>
                    <strong>{a.message}</strong>
                    <br />
                    <small>{a.cause}</small>
                  </td>
                  <td>
                    <small>{a.actionTaken}</small>
                  </td>
                  <td>
                    {a.active ? <Chip tone="bad">activa</Chip> : <Chip tone="ok">normalizada {a.clearedAt ? formatSimTime(a.clearedAt, false) : ''}</Chip>}{' '}
                    {a.acknowledgedAt === null ? (
                      <button className="btn small" onClick={() => e.acknowledgeAlarm(a.id)}>
                        Reconocer
                      </button>
                    ) : (
                      <Chip>reconocida</Chip>
                    )}
                  </td>
                </tr>
              ))}
              {alarms.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <small>Sin alarmas</small>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      <Card
        title="Registro de eventos"
        extra={
          <>
            <select value={cat} onChange={(ev) => setCat(ev.target.value as EventCategory | 'all')}>
              <option value="all">Todas las categorías</option>
              {CATS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input type="text" placeholder="Buscar…" value={q} onChange={(ev) => setQ(ev.target.value)} />
          </>
        }
      >
        <div className="scroll table-wrap" style={{ maxHeight: 520 }}>
          <table>
            <thead>
              <tr>
                <th>Hora</th>
                <th>Categoría</th>
                <th>Origen</th>
                <th>Mensaje</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td className="mono">{formatSimTime(ev.t)}</td>
                  <td>
                    <Chip>{ev.category}</Chip>
                  </td>
                  <td>{ev.source}</td>
                  <td>{ev.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
