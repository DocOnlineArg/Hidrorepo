import { useMemo, useState } from 'react';
import { askConfirm } from '../dialog';
import { useEngine } from '../context';
import { Card, Check, Chip, Field, NumInput } from '../components/common';
import { Chart } from '../components/Chart';
import { SCENARIOS, getScenario, loadScenario, COMPARISON_HOURS } from '../../core/scenarios';
import { runComparison, type ComparisonResult } from '../../core/compare';
import { PUMP_IDS, RELAY_IDS, SENSOR_IDS } from '../../core/types';
import { formatSimTime, MIN } from '../../core/util';
import { fmtSensor, unitOf } from './shared';

type PerturbKind = 'extTemp' | 'extRh' | 'addWater' | 'phShift' | 'ecShift' | 'orpShift' | 'airTemp' | 'rh';
const PERTURB: { kind: PerturbKind; label: string; unit: string; def: number }[] = [
  { kind: 'extTemp', label: 'Temperatura exterior', unit: '°C', def: 32 },
  { kind: 'extRh', label: 'HR exterior', unit: '%', def: 25 },
  { kind: 'airTemp', label: 'Fijar temperatura del aire', unit: '°C', def: 30 },
  { kind: 'rh', label: 'Fijar HR del aire', unit: '%', def: 85 },
  { kind: 'addWater', label: 'Añadir agua (pH 7, sin sales)', unit: 'L', def: 20 },
  { kind: 'phShift', label: 'Desplazar pH', unit: 'pH', def: 0.8 },
  { kind: 'ecShift', label: 'Desplazar EC', unit: 'mS/cm', def: -0.4 },
  { kind: 'orpShift', label: 'Desplazar ORP', unit: 'mV', def: -80 },
];

export function LabView() {
  const { engine: e } = useEngine();
  const [sc, setSc] = useState(e.scenarioId);
  const [vals, setVals] = useState<Record<string, number | null>>(Object.fromEntries(PERTURB.map((p) => [p.kind, p.def])));
  const scenario = getScenario(sc);
  return (
    <>
      <div className="section-title">
        <h2>Laboratorio de simulación</h2>
        <small>Escenario actual: {getScenario(e.scenarioId).name}</small>
      </div>
      <div className="grid wide">
        <Card title="Escenarios">
          <select value={sc} onChange={(ev) => setSc(ev.target.value)}>
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <p className="note">{scenario.description}</p>
          {scenario.demo && <p className="note warn">Usa la configuración de demostración (valores de ejemplo no agronómicos).</p>}
          <div className="row">
            <button
              className="btn primary"
              onClick={async () => {
                if (!(await askConfirm('Cargar el escenario reemplaza la configuración y el estado actuales. Exporte antes la configuración si desea conservarla.', { okText: 'Cargar escenario' }))) return;
                loadScenario(e, sc);
                e.running = true;
              }}
            >
              Cargar y ejecutar
            </button>
            <button className="btn" onClick={() => loadScenario(e, e.scenarioId)}>
              Reiniciar escenario actual
            </button>
            <button className="btn" onClick={() => e.resetRuntime()}>
              Reiniciar estado (conservar configuración)
            </button>
          </div>
          {e.scheduled.length > 0 && (
            <ul className="event-list">
              {e.scheduled.map((s, i) => (
                <li key={i}>
                  <time>{formatSimTime(s.at, false)}</time>
                  <span>
                    {s.label} {s.done ? <Chip tone="ok">aplicada</Chip> : <Chip>pendiente</Chip>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Perturbaciones externas">
          <div className="table-wrap">
            <table>
              <tbody>
                {PERTURB.map((p) => (
                  <tr key={p.kind}>
                    <td>{p.label}</td>
                    <td>
                      <NumInput value={vals[p.kind]} allowNull onCommit={(v) => setVals((x) => ({ ...x, [p.kind]: v }))} width={80} /> <small>{p.unit}</small>
                    </td>
                    <td>
                      <button className="btn small" disabled={vals[p.kind] === null} onClick={() => e.perturb(p.kind, vals[p.kind] as number)}>
                        Aplicar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <small>
            Exterior actual (modelo): {e.plant.state.extTemp.toFixed(1)} °C · {e.plant.state.extRh.toFixed(0)} %HR · depósito {e.plant.state.volumeL.toFixed(1)} L
          </small>
        </Card>
      </div>

      <Card title="Inyección de fallos">
        <div className="grid wide">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sensor</th>
                  <th>Desc.</th>
                  <th>Atasc.</th>
                  <th>Ruido σ</th>
                  <th>Fuera de rango</th>
                  <th>Calibración</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {SENSOR_IDS.map((id) => {
                  const f = e.sensors[id].fault;
                  const cfg = e.config.sensors[id];
                  return (
                    <tr key={id}>
                      <td>{cfg.label}</td>
                      <td>
                        <input type="checkbox" aria-label={`Desconectar ${cfg.label}`} checked={f.disconnected} onChange={(ev) => e.setSensorFault(id, { disconnected: ev.target.checked })} />
                      </td>
                      <td>
                        <input type="checkbox" aria-label={`Atascar ${cfg.label}`} checked={f.stuck} onChange={(ev) => e.setSensorFault(id, { stuck: ev.target.checked })} />
                      </td>
                      <td>
                        <NumInput value={f.noise} min={0} width={64} onCommit={(v) => e.setSensorFault(id, { noise: v ?? 0 })} />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Fuera de rango ${cfg.label}`}
                          checked={f.forcedRaw !== null}
                          onChange={(ev) => e.setSensorFault(id, { forcedRaw: ev.target.checked ? cfg.rangeMax + Math.abs(cfg.rangeMax) * 0.1 + 1 : null })}
                        />
                      </td>
                      <td>
                        {cfg.requiresCalibration ? (
                          <button className="btn small" onClick={() => e.invalidateCalibration(id)}>
                            Invalidar
                          </button>
                        ) : (
                          <small>n/a</small>
                        )}
                      </td>
                      <td>
                        <button className="btn small" onClick={() => e.clearSensorFaults(id)}>
                          Limpiar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Bomba</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {PUMP_IDS.map((id) => {
                  const rt = e.pumps[id];
                  return (
                    <tr key={id}>
                      <td>{e.config.liquids[id].name}</td>
                      <td>
                        {rt.locked ? <Chip tone="bad">bloqueada</Chip> : <Chip tone="ok">libre</Chip>} <small>{rt.levelMl.toFixed(0)} mL</small>
                      </td>
                      <td className="row">
                        {rt.locked ? (
                          <button className="btn small" onClick={() => e.unlockPump(id)}>
                            Desbloquear
                          </button>
                        ) : (
                          <button className="btn small" onClick={() => e.lockPump(id, 'Bloqueo inyectado (laboratorio)')}>
                            Bloquear
                          </button>
                        )}
                        <button className="btn small" onClick={() => e.setPumpLevel(id, e.config.pumps[id].emptyThresholdMl + 5)}>
                          Casi vacío
                        </button>
                        <button className="btn small" onClick={() => e.refillPump(id)}>
                          Rellenar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <div className="row">
          <Check checked={e.link.faultInjected} onChange={(v) => e.setLinkFault(v)}>
            Fallo de comunicación con el controlador
          </Check>
          <button
            className="btn small danger"
            onClick={() => {
              e.testHook = () => {
                e.testHook = null;
                throw new Error('Excepción inyectada desde el laboratorio');
              };
            }}
          >
            Inyectar fallo interno del motor
          </button>
        </div>
      </Card>

      <Comparison />
      <Replay />
    </>
  );
}

function Comparison() {
  const { engine: e } = useEngine();
  const [sc, setSc] = useState('ph_drift');
  const [hours, setHours] = useState(6);
  const [res, setRes] = useState<ComparisonResult | null>(null);
  const [busy, setBusy] = useState(false);
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)} %`);
  return (
    <Card title="Comparación: automatización activada vs desactivada">
      <div className="row">
        <select value={sc} onChange={(ev) => setSc(ev.target.value)}>
          {SCENARIOS.filter((s) => s.demo).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select value={hours} onChange={(ev) => setHours(Number(ev.target.value))}>
          {COMPARISON_HOURS.map((h) => (
            <option key={h} value={h}>
              {h} h simuladas
            </option>
          ))}
        </select>
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setTimeout(() => {
              setRes(runComparison(sc, hours));
              setBusy(false);
            }, 30);
          }}
        >
          {busy ? 'Calculando…' : 'Ejecutar comparación'}
        </button>
      </div>
      <small>Se ejecutan dos simulaciones independientes con la misma semilla; no afecta a la simulación en curso. Tiempo en banda calculado sobre el valor interno del modelo.</small>
      {res && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Métrica</th>
                  <th className="num">Con automatización</th>
                  <th className="num">Sin automatización</th>
                </tr>
              </thead>
              <tbody>
                {(['ph', 'ec', 'airTemp', 'rh'] as const).map((id) => (
                  <tr key={id}>
                    <td>Tiempo en banda · {e.config.sensors[id].label}</td>
                    <td className="num">{pct(res.on.summary.timeInBand[id])}</td>
                    <td className="num">{pct(res.off.summary.timeInBand[id])}</td>
                  </tr>
                ))}
                <tr>
                  <td>Dosificaciones (operaciones / mL)</td>
                  <td className="num">
                    {res.on.summary.doses} / {res.on.summary.dosedMl.toFixed(1)}
                  </td>
                  <td className="num">
                    {res.off.summary.doses} / {res.off.summary.dosedMl.toFixed(1)}
                  </td>
                </tr>
                <tr>
                  <td>Arranques de actuadores</td>
                  <td className="num">{res.on.summary.relayCycles}</td>
                  <td className="num">{res.off.summary.relayCycles}</td>
                </tr>
                <tr>
                  <td>Alarmas registradas</td>
                  <td className="num">{res.on.summary.alarmsRaised}</td>
                  <td className="num">{res.off.summary.alarmsRaised}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="grid wide">
            {(['ph', 'ec', 'airTemp', 'rh'] as const).map((id) => {
              const s = res.on.series[id];
              const from = s.t[0] ?? 0;
              const to = s.t[s.t.length - 1] ?? 1;
              return (
                <div key={id}>
                  <h4>{e.config.sensors[id].label}</h4>
                  <Chart
                    from={from}
                    to={to}
                    unit={e.config.sensors[id].unit}
                    decimals={id === 'ph' || id === 'ec' ? 2 : 1}
                    series={[
                      { label: 'Con automatización', data: res.on.series[id], color: 'var(--chart-1)' },
                      { label: 'Sin automatización', data: res.off.series[id], color: 'var(--chart-3)', dashed: true },
                    ]}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

function Replay() {
  const { engine: e } = useEngine();
  const range = e.history.range();
  const [pos, setPos] = useState(1);
  const t = range ? range.from + (range.to - range.from) * pos : e.t;
  const events = useMemo(() => e.log.events.filter((ev) => Math.abs(ev.t - t) <= 10 * MIN), [e.log.events, t, e.version]);
  if (!range) return <Card title="Reproducción de eventos"><small>Todavía no hay historial.</small></Card>;
  return (
    <Card title="Reproducción de eventos">
      <div className="row">
        <input type="range" min={0} max={1} step={0.001} value={pos} onChange={(ev) => setPos(Number(ev.target.value))} style={{ flex: 1, minWidth: 200 }} aria-label="Instante" />
        <span className="clock">{formatSimTime(t)}</span>
        <button className="btn small" onClick={() => setPos(1)}>
          Ahora
        </button>
      </div>
      <div className="grid">
        <div className="table-wrap">
          <table>
            <tbody>
              {SENSOR_IDS.map((id) => (
                <tr key={id}>
                  <td>{e.config.sensors[id].label}</td>
                  <td className="num">
                    {fmtSensor(e, id, e.history.valueAt(id, t))} <small>{unitOf(e, id)}</small>
                  </td>
                </tr>
              ))}
              {RELAY_IDS.map((id) => (
                <tr key={id}>
                  <td>{id}</td>
                  <td className="num">{e.history.valueAt(`relay.${id}`, t) ? 'ON' : 'OFF'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="scroll">
          <h4>Eventos ±10 min</h4>
          <ul className="event-list">
            {events.map((ev) => (
              <li key={ev.id}>
                <time>{formatSimTime(ev.t, false)}</time>
                <span>
                  <small>{ev.source}:</small> {ev.message}
                </span>
              </li>
            ))}
            {events.length === 0 && <small>Sin eventos en la ventana</small>}
          </ul>
        </div>
      </div>
      <Field label="Bombas en ese instante">
        <span>{PUMP_IDS.filter((id) => e.history.valueAt(`pump.${id}`, t)).map((id) => e.config.liquids[id].name).join(', ') || 'ninguna'}</span>
      </Field>
    </Card>
  );
}
