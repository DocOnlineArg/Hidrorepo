import { useState } from 'react';
import { useEngine } from '../context';
import { Card, Check, Chip, Field, NumInput, Seg, TextInput } from '../components/common';
import { Chart } from '../components/Chart';
import type { RelayId } from '../../core/types';
import { RELAY_IDS } from '../../core/types';
import { scheduleInfo, photoperiodFromTimes } from '../../core/control/lights';
import { HOUR, formatDuration, formatSimTime, minuteOfDay } from '../../core/util';
import { HOURS_OPTIONS } from './shared';

const LABEL: Record<RelayId, string> = { humidifier: 'Humidificador', dehumidifier: 'Deshumidificador', fan: 'Ventilador', lights: 'Luces' };

export function ClimateView() {
  const { engine: e } = useEngine();
  const [hours, setHours] = useState('6');
  const from = e.t - Number(hours) * HOUR;
  const p = e.profile;
  const band = (b: typeof p.climate.rh) => (b.target !== null && b.deadband !== null ? { lo: b.target - b.deadband, hi: b.target + b.deadband } : null);
  const c = e.config.climate;
  return (
    <>
      <div className="section-title">
        <h2>Clima e iluminación</h2>
        <Seg value={hours} onChange={setHours} options={HOURS_OPTIONS} />
      </div>
      <div className="grid wide">
        <Card title="Temperatura">
          <Chart
            from={from}
            to={e.t}
            unit="°C"
            band={band(p.climate.airTemp)}
            series={[
              { label: 'Aire (lectura)', data: e.history.get('airTemp'), color: 'var(--chart-1)' },
              { label: 'Agua (lectura)', data: e.history.get('waterTemp'), color: 'var(--chart-2)' },
              { label: 'Exterior (modelo)', data: e.history.get('extTemp'), color: 'var(--chart-3)', dashed: true },
            ]}
          />
        </Card>
        <Card title="Humedad relativa">
          <Chart from={from} to={e.t} unit="%HR" band={band(p.climate.rh)} series={[{ label: 'HR (lectura)', data: e.history.get('rh'), color: 'var(--chart-1)' }]} />
        </Card>
        <Card title="Estado de actuadores">
          <Chart
            from={from}
            to={e.t}
            yMin={0}
            yMax={4.2}
            decimals={0}
            height={130}
            series={RELAY_IDS.map((id, i) => ({
              label: LABEL[id],
              data: e.history.get(`relay.${id}`),
              color: ['var(--info)', 'var(--warn)', 'var(--accent)', '#e0b400'][i],
              step: true,
              map: (v: number) => v * 0.8 + i * 1.05,
            }))}
          />
          <small>Cada franja representa un actuador (alto = encendido).</small>
        </Card>
      </div>
      <div className="grid">
        {RELAY_IDS.map((id) => (
          <RelayCard key={id} id={id} />
        ))}
      </div>
      <div className="grid wide">
        <LightsTimer />
        <Card title="Interbloqueos y protecciones">
          <Check
            checked={c.allowHumDehumSimultaneous}
            onChange={(v) => {
              if (v && c.simultaneousJustification.trim().length < 5) return alert('Escriba primero una justificación (mín. 5 caracteres).');
              e.updateConfig((x) => (x.climate.allowHumDehumSimultaneous = v), `Simultaneidad humidificador/deshumidificador ${v ? 'PERMITIDA' : 'prohibida'}`);
            }}
          >
            Permitir humidificador y deshumidificador simultáneos
          </Check>
          <Field label="Justificación (obligatoria para permitirlo)">
            <TextInput value={c.simultaneousJustification || null} placeholder="p. ej. prueba de equipos" onCommit={(v) => e.updateConfig((x) => (x.climate.simultaneousJustification = v ?? ''), 'Justificación de simultaneidad')} />
          </Field>
          <Field label="Ventilador ante fallo del sensor de temperatura">
            <select value={c.fan.onSensorFault} onChange={(ev) => e.updateConfig((x) => (x.climate.fan.onSensorFault = ev.target.value as 'on' | 'off'), `Ventilador ante fallo: ${ev.target.value}`)}>
              <option value="on">Encender (evacuar calor)</option>
              <option value="off">Apagar</option>
            </select>
          </Field>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.82rem' }}>
            <li>Sensor de HR inválido → humidificador y deshumidificador apagados.</li>
            <li>Sensor de temperatura inválido → ventilador en el estado configurado.</li>
            <li>Temperatura &gt; corte del perfil ({p.climate.lightsOverTempCutoff ?? '—'} °C) → luces apagadas hasta bajar 2 °C.</li>
            <li>Tiempos mínimos ON/OFF evitan ciclos cortos (excepto en órdenes de seguridad).</li>
            <li>Estado seguro / E-STOP → todos los actuadores apagados.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}

function RelayCard({ id }: { id: RelayId }) {
  const { engine: e } = useEngine();
  const rt = e.relays[id];
  const rc = e.config.climate[id];
  const mode = rc.mode === 'auto' ? 'auto' : rc.manualOn ? 'on' : 'off';
  const events = e.log.events.filter((ev) => ev.source === LABEL[id]).slice(-4).reverse();
  return (
    <Card title={LABEL[id]} extra={<Chip tone={rt.on ? 'ok' : ''}>{rt.on ? 'ENCENDIDO' : 'APAGADO'}</Chip>}>
      <Seg
        value={mode}
        onChange={(m) => e.setRelay(id, m === 'auto' ? 'auto' : 'manual', m === 'on')}
        options={[
          { value: 'auto', label: 'Automático' },
          { value: 'on', label: 'Manual ON' },
          { value: 'off', label: 'Manual OFF' },
        ]}
      />
      <dl className="kv">
        <dt>Motivo</dt>
        <dd>{rt.reason}</dd>
        <dt>Condición</dt>
        <dd>{rt.condition}</dd>
        <dt>Tiempo encendido</dt>
        <dd>{formatDuration(rt.onTimeTotalS)}</dd>
        <dt>Arranques</dt>
        <dd>{rt.cycles}</dd>
        <dt>Último cambio</dt>
        <dd>{rt.lastChangeAt ? formatSimTime(rt.lastChangeAt) : '—'}</dd>
      </dl>
      {id !== 'lights' && (
        <div className="fields">
          <Field label="Mín. ON" unit="s">
            <NumInput value={rc.minOnS} min={0} onCommit={(v) => v !== null && e.updateConfig((c) => (c.climate[id].minOnS = v), `${LABEL[id]}: mín. ON ${v} s`)} width={70} />
          </Field>
          <Field label="Mín. OFF" unit="s">
            <NumInput value={rc.minOffS} min={0} onCommit={(v) => v !== null && e.updateConfig((c) => (c.climate[id].minOffS = v), `${LABEL[id]}: mín. OFF ${v} s`)} width={70} />
          </Field>
        </div>
      )}
      <ul className="event-list">
        {events.map((ev) => (
          <li key={ev.id}>
            <time>{formatSimTime(ev.t, false)}</time>
            <small>{ev.message}</small>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function LightsTimer() {
  const { engine: e } = useEngine();
  const p = e.profile;
  const info = scheduleInfo(p.lights, e.t);
  const now = minuteOfDay(e.t);
  const segs: { left: number; width: number }[] = [];
  if (info.configured && info.onMinute !== null && info.lightH !== null) {
    const start = info.onMinute;
    const dur = info.lightH * 60;
    if (start + dur <= 1440) segs.push({ left: start, width: dur });
    else {
      segs.push({ left: start, width: 1440 - start });
      segs.push({ left: 0, width: start + dur - 1440 });
    }
  }
  const setLights = (onTime: string | null, ph: number | null) => {
    e.updateProfile(p.id, 'lights.onTime', onTime);
    e.updateProfile(p.id, 'lights.photoperiodH', ph);
  };
  return (
    <Card title={`Temporizador de iluminación · perfil ${p.name}`} extra={<Chip tone={info.on ? 'ok' : ''}>{info.configured ? (info.on ? 'Luz' : 'Oscuridad') : 'Sin configurar'}</Chip>}>
      <div className="daybar" aria-label="Ciclo diario">
        {segs.map((s, i) => (
          <div key={i} className="lit" style={{ left: `${(s.left / 1440) * 100}%`, width: `${(s.width / 1440) * 100}%` }} />
        ))}
        <div className="now" style={{ left: `${(now / 1440) * 100}%` }} />
      </div>
      <div className="daybar-scale">
        {['00', '06', '12', '18', '24'].map((h) => (
          <span key={h}>{h}:00</span>
        ))}
      </div>
      <div className="fields">
        <Field label="Encendido (HH:MM)">
          <TextInput value={p.lights.onTime} placeholder="06:00" pattern={/^\d{1,2}:\d{2}$/} width={80} onCommit={(v) => setLights(v, p.lights.photoperiodH)} />
        </Field>
        <Field label="Fotoperiodo" unit="h">
          <NumInput value={p.lights.photoperiodH} min={0} max={24} allowNull onCommit={(v) => setLights(p.lights.onTime, v)} width={70} />
        </Field>
        <Field label="Apagado (HH:MM)">
          <TextInput
            value={info.offTime}
            placeholder="00:00"
            pattern={/^\d{1,2}:\d{2}$/}
            width={80}
            onCommit={(v) => {
              if (!v || !p.lights.onTime) return;
              setLights(p.lights.onTime, photoperiodFromTimes(p.lights.onTime, v));
            }}
          />
        </Field>
      </div>
      <div className="row">
        <button className="btn small" onClick={() => setLights(p.lights.onTime ?? '06:00', 18)}>
          Ciclo fijo 18/6
        </button>
        <button className="btn small" onClick={() => setLights(p.lights.onTime ?? '06:00', 12)}>
          Ciclo fijo 12/12
        </button>
      </div>
      <dl className="kv">
        <dt>Horas de luz / oscuridad</dt>
        <dd>{info.configured ? `${info.lightH} h / ${info.darkH} h` : '—'}</dd>
        <dt>Próximo cambio</dt>
        <dd>{info.minutesToNextChange !== null ? `en ${formatDuration(info.minutesToNextChange * 60)}` : '—'}</dd>
      </dl>
      <p className="note">
        El ciclo es fijo (sin cambios automáticos del fotoperiodo) y el estado se calcula a partir de la hora y del horario guardado, por lo que se conserva tras reiniciar la aplicación o el controlador. Modificar el horario invalida el perfil hasta volver a validarlo.
      </p>
    </Card>
  );
}
