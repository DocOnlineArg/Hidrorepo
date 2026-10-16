import { useState } from 'react';
import { useEngine } from '../context';
import { Card, Check, Chip, Field, NumInput, QUALITY_LABEL, STATUS_LABEL, Seg, SimTime, statusTone } from '../components/common';
import { Chart } from '../components/Chart';
import type { FilterKind, SensorId } from '../../core/types';
import { SENSOR_IDS } from '../../core/types';
import { CALIBRATION_POINTS } from '../../core/sensors/sensor';
import { DAY, ecFromDisplay, ecToDisplay, formatSimTime, HOUR } from '../../core/util';
import { HOURS_OPTIONS, bandFor, fmtSensor, mapFor, unitOf } from './shared';

export function SensorsView() {
  const { engine: e } = useEngine();
  const [hours, setHours] = useState('6');
  const [showTruth, setShowTruth] = useState(true);
  return (
    <>
      <div className="section-title">
        <h2>Sensores</h2>
        <div className="row">
          <Seg value={hours} onChange={setHours} options={HOURS_OPTIONS} />
          <Check checked={showTruth} onChange={setShowTruth}>
            Mostrar valor interno del modelo
          </Check>
          <Seg
            value={e.config.ecDisplayUnit}
            onChange={(u) => e.updateConfig((c) => (c.ecDisplayUnit = u), `Unidad EC: ${u}`)}
            options={[
              { value: 'mS/cm', label: 'mS/cm' },
              { value: 'µS/cm', label: 'µS/cm' },
            ]}
          />
        </div>
      </div>
      <p className="note">
        En simulación, cada lectura atraviesa el mismo pipeline que tendrá con hardware real: error de sonda → calibración → validación (rango, picos, atascado, caducidad) → filtro. La línea discontinua es el valor interno del modelo (no medible en la realidad).
      </p>
      <div className="grid wide">
        {SENSOR_IDS.map((id) => (
          <SensorCard key={id} id={id} hours={Number(hours)} showTruth={showTruth} />
        ))}
      </div>
    </>
  );
}

function SensorCard({ id, hours, showTruth }: { id: SensorId; hours: number; showTruth: boolean }) {
  const { engine: e } = useEngine();
  const cfg = e.config.sensors[id];
  const rt = e.sensors[id];
  const r = rt.reading;
  const band = bandFor(e, id);
  const [manual, setManual] = useState<number | null>(null);
  const cal = rt.calibration;
  const disp = (v: number) => (id === 'ec' ? ecToDisplay(v, e.config.ecDisplayUnit) : v);
  const undisp = (v: number) => (id === 'ec' ? ecFromDisplay(v, e.config.ecDisplayUnit) : v);
  const from = e.t - hours * HOUR;
  const map = mapFor(e, id);
  const calAge = cal.calibratedAt !== null ? (e.t - cal.calibratedAt) / DAY : null;

  return (
    <Card
      tone={r.status === 'ok' ? undefined : r.quality === 'bad' ? 'alert' : 'warnb'}
      title={
        <div>
          <h3>{cfg.label}</h3>
          <div className="row" style={{ marginTop: 4 }}>
            <Chip tone={statusTone(r.status)}>{STATUS_LABEL[r.status]}</Chip>
            <Chip tone={r.quality === 'good' ? 'ok' : r.quality === 'uncertain' ? 'warn' : 'bad'}>Calidad: {QUALITY_LABEL[r.quality]}</Chip>
            <Chip tone={r.source === 'manual' ? 'info' : r.source === 'hardware' ? 'accent' : ''}>
              {r.source === 'simulated' ? 'SIMULADO' : r.source === 'manual' ? 'MANUAL' : r.source === 'hardware' ? 'HARDWARE' : '—'}
            </Chip>
          </div>
        </div>
      }
      extra={
        <div className="big">
          {fmtSensor(e, id, r.value)}
          <span className="unit">{unitOf(e, id)}</span>
        </div>
      }
    >
      <dl className="kv">
        <dt>Última lectura</dt>
        <dd>
          <SimTime t={r.ts} />
        </dd>
        <dt>Mensaje</dt>
        <dd>{r.message}</dd>
        <dt>Crudo / sin filtrar</dt>
        <dd className="mono">
          {r.raw === null ? '—' : r.raw.toFixed(4)} / {r.unfiltered === null ? '—' : r.unfiltered.toFixed(4)}
        </dd>
        <dt>Objetivo (perfil {e.profile.name})</dt>
        <dd>{band.target === null ? 'sin configurar' : `${fmtSensor(e, id, band.target)} ± ${band.deadband === null ? '—' : fmtSensor(e, id, band.deadband)}`}</dd>
        <dt>Límites de alarma</dt>
        <dd>
          {band.alarmLow === null ? '—' : fmtSensor(e, id, band.alarmLow)} … {band.alarmHigh === null ? '—' : fmtSensor(e, id, band.alarmHigh)}
        </dd>
        <dt>Calibración</dt>
        <dd>
          {cfg.requiresCalibration
            ? cal.status === 'valid'
              ? `válida (hace ${calAge?.toFixed(1)} d, caduca a los ${cfg.calibrationValidityDays} d)${cal.simulatedOnly ? ' · generada por escenario' : ''}`
              : cal.status === 'in_progress'
                ? 'en curso'
                : cal.status === 'expired'
                  ? 'CADUCADA'
                  : 'sin calibrar'
            : 'no requerida (sensor digital calibrado de fábrica)'}
        </dd>
      </dl>
      <Chart
        from={from}
        to={e.t}
        unit={unitOf(e, id)}
        decimals={id === 'ec' && e.config.ecDisplayUnit === 'mS/cm' ? 2 : id === 'ph' ? 2 : 0}
        band={band.target !== null && band.deadband !== null ? { lo: disp(band.target - band.deadband), hi: disp(band.target + band.deadband) } : null}
        lines={[
          ...(band.alarmLow !== null ? [{ y: disp(band.alarmLow), label: 'Alarma baja', tone: 'warn' as const }] : []),
          ...(band.alarmHigh !== null ? [{ y: disp(band.alarmHigh), label: 'Alarma alta', tone: 'warn' as const }] : []),
        ]}
        series={[
          { label: 'Lectura filtrada', data: e.history.get(id), color: 'var(--chart-1)', map },
          ...(showTruth ? [{ label: 'Modelo (interno)', data: e.history.get(`truth.${id}`), color: 'var(--chart-2)', dashed: true, map }] : []),
        ]}
      />

      <details>
        <summary>Simular fallos</summary>
        <div className="row">
          <Check checked={rt.fault.disconnected} onChange={(v) => e.setSensorFault(id, { disconnected: v })}>
            Desconectado
          </Check>
          <Check checked={rt.fault.stuck} onChange={(v) => e.setSensorFault(id, { stuck: v })}>
            Atascado
          </Check>
          <button className="btn small" onClick={() => e.setSensorFault(id, { forcedRaw: cfg.rangeMax + Math.abs(cfg.rangeMax) * 0.1 + 1 })}>
            Lectura fuera de rango
          </button>
          <button className="btn small" onClick={() => e.setSensorFault(id, { forcedRaw: null })} disabled={rt.fault.forcedRaw === null}>
            Quitar lectura forzada
          </button>
        </div>
        <div className="fields">
          <Field label="Ruido adicional σ" unit={cfg.unit}>
            <NumInput value={rt.fault.noise} min={0} onCommit={(v) => e.setSensorFault(id, { noise: v ?? 0 })} />
          </Field>
          <Field label="Deriva / offset" unit={cfg.unit}>
            <NumInput value={rt.fault.offset} onCommit={(v) => e.setSensorFault(id, { offset: v ?? 0 })} />
          </Field>
        </div>
        <button className="btn small" onClick={() => e.clearSensorFaults(id)}>
          Eliminar todos los fallos
        </button>
      </details>

      <details>
        <summary>Lectura manual</summary>
        <p className="note">La lectura manual sustituye al driver y se marca como MANUAL en todo el sistema.</p>
        <div className="row">
          <NumInput value={manual} allowNull onCommit={setManual} ariaLabel="Valor manual" />
          <small>{unitOf(e, id)}</small>
          <button className="btn small" disabled={manual === null} onClick={() => manual !== null && e.setManualReading(id, undisp(manual))}>
            Aplicar
          </button>
          <button className="btn small" disabled={rt.manualValue === null} onClick={() => e.setManualReading(id, null)}>
            Volver al sensor
          </button>
        </div>
      </details>

      {cfg.requiresCalibration && <CalibrationPanel id={id} />}

      <details>
        <summary>Filtro y validación</summary>
        <div className="fields">
          <Field label="Filtro">
            <select value={cfg.filter.kind} onChange={(ev) => e.updateConfig((c) => (c.sensors[id].filter.kind = ev.target.value as FilterKind), `Filtro ${id}: ${ev.target.value}`)}>
              <option value="none">Ninguno</option>
              <option value="ema">EMA</option>
              <option value="moving_average">Media móvil</option>
              <option value="median">Mediana</option>
            </select>
          </Field>
          <Field label="α EMA">
            <NumInput value={cfg.filter.alpha} min={0.01} max={1} onCommit={(v) => e.updateConfig((c) => (c.sensors[id].filter.alpha = v ?? 0.2), `α ${id}`)} />
          </Field>
          <Field label="Ventana" unit="muestras">
            <NumInput value={cfg.filter.window} min={1} step={1} onCommit={(v) => e.updateConfig((c) => (c.sensors[id].filter.window = v ?? 5), `Ventana ${id}`)} />
          </Field>
          <Field label="Umbral de pico" unit={cfg.unit}>
            <NumInput value={cfg.spikeThreshold} min={0} onCommit={(v) => e.updateConfig((c) => (c.sensors[id].spikeThreshold = v ?? 1), `Umbral pico ${id}`)} />
          </Field>
          <Field label="Atascado tras" unit="s">
            <NumInput value={cfg.stuckDetectS} min={10} onCommit={(v) => e.updateConfig((c) => (c.sensors[id].stuckDetectS = v ?? 300), `Atascado ${id}`)} />
          </Field>
          <Field label="Rango instrumento" unit={cfg.unit}>
            <span className="mono">
              {cfg.rangeMin} … {cfg.rangeMax}
            </span>
          </Field>
        </div>
      </details>
    </Card>
  );
}

function CalibrationPanel({ id }: { id: SensorId }) {
  const { engine: e } = useEngine();
  const rt = e.sensors[id];
  const cal = rt.calibration;
  const refs = cal.procedure ?? CALIBRATION_POINTS[id] ?? [];
  const [msg, setMsg] = useState('');
  const unit = id === 'ec' ? 'mS/cm' : e.config.sensors[id].unit;
  return (
    <details open={cal.status === 'in_progress'}>
      <summary>Calibración (simulada)</summary>
      <p className="note">
        Procedimiento simulado: la sonda virtual tiene un error de ganancia/offset oculto. Al "sumergirla" en cada solución de referencia se captura su lectura cruda y se calcula la corrección. Con hardware real la referencia debe ser una solución patrón certificada.
      </p>
      {cal.status !== 'in_progress' ? (
        <div className="row">
          <button className="btn small primary" onClick={() => e.beginCalibration(id)}>
            Iniciar calibración ({refs.join(' / ')} {unit})
          </button>
          <button className="btn small" onClick={() => e.invalidateCalibration(id)} disabled={cal.status !== 'valid'}>
            Invalidar calibración
          </button>
        </div>
      ) : (
        <div className="col">
          {refs.map((ref, i) => {
            const done = cal.points.some((p) => p.reference === ref);
            const pt = cal.points.find((p) => p.reference === ref);
            return (
              <div className="row" key={ref}>
                <span>
                  {i + 1}. Solución {ref} {unit}
                </span>
                <button className="btn small" disabled={done} onClick={() => {
                  const v = e.captureCalibration(id, ref);
                  setMsg(v.ok ? '' : v.reasons.join('; '));
                }}>
                  {done ? `Capturado (crudo ${pt?.raw.toFixed(3)})` : 'Sumergir y capturar'}
                </button>
              </div>
            );
          })}
          <div className="row">
            <button className="btn small primary" disabled={cal.points.length < refs.length} onClick={() => setMsg(e.completeCalibration(id).reasons.join('; '))}>
              Calcular y guardar
            </button>
            <button className="btn small" onClick={() => e.cancelCalibration(id)}>
              Cancelar
            </button>
          </div>
        </div>
      )}
      {msg && <div className="note">{msg}</div>}
      {cal.calibratedAt !== null && (
        <small>
          Última: {formatSimTime(cal.calibratedAt)} · ganancia {cal.gain.toFixed(4)} · offset {cal.bias.toFixed(4)}
        </small>
      )}
    </details>
  );
}
