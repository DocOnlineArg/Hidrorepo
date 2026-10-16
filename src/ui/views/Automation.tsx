import { useState } from 'react';
import { useEngine } from '../context';
import { Card, Chip, Field, NumInput } from '../components/common';
import type { LoopConfig, LoopId } from '../../core/types';
import { RELAY_IDS } from '../../core/types';
import { LOOP_LABEL } from '../../core/control/chemistry';
import { formatDuration, formatSimTime, HOUR } from '../../core/util';

const PHASE_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | ''> = {
  idle: 'ok',
  confirming: 'info',
  waiting: 'info',
  dosing: 'accent' as 'info',
  mixing: 'info',
  stabilizing: 'info',
  blocked: 'warn',
  locked_out: 'bad',
  disabled: '',
};
const RELAY_LABEL = { humidifier: 'Humidificador', dehumidifier: 'Deshumidificador', fan: 'Ventilador', lights: 'Luces' };

export function AutomationView() {
  const { engine: e } = useEngine();
  const [filter, setFilter] = useState<LoopId | 'all'>('all');
  const decisions = e.decisions.filter((d) => filter === 'all' || d.loop === filter).slice(-80).reverse();
  const c = e.config.control;
  return (
    <>
      <div className="section-title">
        <h2>Automatización</h2>
        <Chip tone={e.automationEnabled && e.mode !== 'manual' ? 'ok' : 'warn'}>
          {e.mode === 'manual' ? 'Modo manual: automatización suspendida' : e.automationEnabled ? 'Automatización activa' : 'Automatización desactivada'}
        </Chip>
      </div>
      <Card title="Lazos de control químico">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Lazo</th>
                <th>Fase</th>
                <th>En fase desde</th>
                <th>Temporizador</th>
                <th className="num">Correcciones/h</th>
                <th className="num">Sin respuesta</th>
                <th>Último motivo</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {c.order.map((id) => {
                const L = e.chem.loops[id];
                const lc = c.loops[id];
                let timer = '—';
                if (L.phase === 'confirming' && L.confirmSince !== null) timer = `confirmación ${formatDuration(lc.confirmS - (e.t - L.confirmSince) / 1000)}`;
                if (L.phase === 'mixing' && L.mixUntil !== null) timer = `mezcla ${formatDuration((L.mixUntil - e.t) / 1000)}`;
                if (L.phase === 'stabilizing') timer = `estabilización ${formatDuration((e.t - L.phaseSince) / 1000)} (mín. ${lc.stabilizeS} s)`;
                if (L.phase === 'dosing') timer = L.sequence.map((s) => `${e.config.liquids[s.pump].name} ${s.ml.toFixed(1)} mL${s.done ? ' ✓' : s.startAt ? ' ▶' : ''}`).join(' → ');
                const last = e.decisions.filter((d) => d.loop === id).slice(-1)[0];
                return (
                  <tr key={id}>
                    <td>
                      <strong>{LOOP_LABEL[id]}</strong>
                    </td>
                    <td>
                      <Chip tone={PHASE_TONE[L.phase]}>{L.phase}</Chip>
                    </td>
                    <td className="mono">{formatSimTime(L.phaseSince, false)}</td>
                    <td>{timer}</td>
                    <td className="num">
                      {L.correctionTimes.filter((t) => t > e.t - HOUR).length} / {lc.maxCorrectionsPerHour}
                    </td>
                    <td className="num">
                      {L.noProgressCount} / {lc.noProgressLimit}
                    </td>
                    <td style={{ maxWidth: 360 }}>
                      <small>{last?.justification[0] ?? '—'}</small>
                    </td>
                    <td>
                      {L.phase === 'locked_out' && (
                        <button className="btn small" onClick={() => e.resetLoop(id)}>
                          Rearmar
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="note">
          Secuencia por lazo: desviación fuera de banda muerta → confirmación (anti-ruido) → verificación de seguridad de todos los pasos → dosificación (pasos separados {c.sequenceGapS} s) → mezcla → estabilización (σ bajo tolerancia) → nueva medición → decisión. Solo un lazo corrige a la vez. Orden de prioridad: {c.order.map((o) => LOOP_LABEL[o]).join(' → ')}.
        </p>
      </Card>

      <div className="grid wide">
        <Card title="Reglas activas (perfil actual)">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Regla</th>
                  <th>Condición de activación / histéresis</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {(['ph', 'ec', 'orp'] as LoopId[]).map((id) => {
                  const b = e.profile.reservoir[id];
                  const lc = c.loops[id];
                  return (
                    <tr key={id}>
                      <td>Corrección {LOOP_LABEL[id]}</td>
                      <td>
                        {b.target === null || b.deadband === null
                          ? 'objetivo sin configurar'
                          : `|${LOOP_LABEL[id]} − ${b.target}| > ${b.deadband} durante ${lc.confirmS} s → dosis = clamp(|e|·${lc.correctionFraction}/estimación·V, ${lc.minDoseMl}…${lc.maxDoseMl} mL)${id !== 'ph' ? ' (solo en sentido ascendente)' : ''}`}
                      </td>
                      <td>{e.profile.validated && e.profile.automation[id] ? <Chip tone="ok">activa</Chip> : <Chip>inactiva</Chip>}</td>
                    </tr>
                  );
                })}
                {RELAY_IDS.map((id) => (
                  <tr key={id}>
                    <td>{RELAY_LABEL[id]}</td>
                    <td>{e.relays[id].condition}</td>
                    <td>{e.config.climate[id].mode === 'manual' ? <Chip tone="info">manual</Chip> : e.profile.validated ? <Chip tone="ok">auto</Chip> : <Chip>inactiva</Chip>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Interbloqueos y temporizadores">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.82rem' }}>
            <li>Dosificación simultánea: {e.config.compatibility.allowSimultaneousDosing ? 'permitida solo para pares compatibles' : 'prohibida (una bomba a la vez)'}.</li>
            <li>Oxidante: subsistema {e.config.oxidantGuard.enabled ? 'habilitado' : 'bloqueado'}; separación {e.config.oxidantGuard.separationS} s con cualquier otro producto.</li>
            <li>Bombas: intervalo mínimo entre operaciones y corte duro por tiempo máximo (también en firmware).</li>
            <li>Dosificación automática exige sensores relevantes válidos y calibrados, bomba cebada, recipiente con nivel y perfil validado.</li>
            <li>Humidificador/deshumidificador: {e.config.climate.allowHumDehumSimultaneous ? `simultaneidad permitida (${e.config.climate.simultaneousJustification})` : 'nunca simultáneos'}.</li>
            <li>Comunicación: sin heartbeat durante {e.config.commTimeoutS} s → estado seguro.</li>
            <li>Lazo sin respuesta tras {c.loops.ph.noProgressLimit} correcciones → bloqueo con alarma crítica.</li>
          </ul>
        </Card>
      </div>

      <Card
        title="Registro de decisiones automáticas"
        extra={
          <select value={filter} onChange={(ev) => setFilter(ev.target.value as LoopId | 'all')}>
            <option value="all">Todos los lazos</option>
            <option value="ph">pH</option>
            <option value="ec">EC</option>
            <option value="orp">ORP</option>
          </select>
        }
      >
        <div className="scroll table-wrap">
          <table>
            <thead>
              <tr>
                <th>Hora</th>
                <th>Lazo</th>
                <th>Acción</th>
                <th className="num">Valor</th>
                <th className="num">Objetivo</th>
                <th>Justificación</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{formatSimTime(d.t)}</td>
                  <td>{LOOP_LABEL[d.loop]}</td>
                  <td>
                    <Chip tone={d.action === 'dose' ? 'ok' : d.action === 'blocked' ? 'warn' : d.action === 'measure' ? 'info' : ''}>{d.action}</Chip>
                  </td>
                  <td className="num">{d.value?.toFixed(3) ?? '—'}</td>
                  <td className="num">{d.target ?? '—'}</td>
                  <td>
                    {d.justification.map((j, i) => (
                      <div key={i}>
                        <small>{j}</small>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
              {decisions.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <small>Sin decisiones registradas</small>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Parámetros del controlador">
        <p className="note warn">
          Las estimaciones de efecto por mL/L son el modelo del CONTROLADOR (independiente del modelo del simulador). Sin estimación configurada, el lazo no dosifica. Deben identificarse con mediciones reales antes de operar equipos.
        </p>
        <div className="fields">
          <Field label="Volumen nominal depósito" unit="L">
            <NumInput value={c.reservoirVolumeL} allowNull min={1} onCommit={(v) => e.updateConfig((x) => (x.control.reservoirVolumeL = v), `Volumen nominal ${v} L`)} />
          </Field>
          <Field label="pH+ (ΔpH por mL/L)">
            <NumInput value={c.estimates.phUp} allowNull min={0} onCommit={(v) => e.updateConfig((x) => (x.control.estimates.phUp = v), `Estimación pH+ ${v}`)} />
          </Field>
          <Field label="pH− (|ΔpH| por mL/L)">
            <NumInput value={c.estimates.phDown} allowNull min={0} onCommit={(v) => e.updateConfig((x) => (x.control.estimates.phDown = v), `Estimación pH− ${v}`)} />
          </Field>
          <Field label="A+B (ΔEC mS/cm por mL A/L)">
            <NumInput value={c.estimates.ecPerMlA} allowNull min={0} onCommit={(v) => e.updateConfig((x) => (x.control.estimates.ecPerMlA = v), `Estimación EC ${v}`)} />
          </Field>
          <Field label="Oxidante (ΔORP mV por mL/L)">
            <NumInput value={c.estimates.oxidant} allowNull min={0} onCommit={(v) => e.updateConfig((x) => (x.control.estimates.oxidant = v), `Estimación ORP ${v}`)} />
          </Field>
          <Field label="Separación entre pasos" unit="s">
            <NumInput value={c.sequenceGapS} min={0} onCommit={(v) => v !== null && e.updateConfig((x) => (x.control.sequenceGapS = v), `Separación pasos ${v} s`)} />
          </Field>
        </div>
        <small>Secuencia de EC: {c.ecSequence.map((p) => e.config.liquids[p].name).join(' → ')} (aditivos según relaciones del perfil).</small>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Parámetro</th>
                {(['ph', 'ec', 'orp'] as LoopId[]).map((l) => (
                  <th key={l}>{LOOP_LABEL[l]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['confirmS', 'Confirmación (s)'],
                  ['mixS', 'Mezcla (s)'],
                  ['stabilizeS', 'Estabilización mín. (s)'],
                  ['stabilizeMaxS', 'Estabilización máx. (s)'],
                  ['stabilityTolerance', 'Tolerancia σ'],
                  ['correctionFraction', 'Fracción corregida'],
                  ['minDoseMl', 'Dosis mín. (mL)'],
                  ['maxDoseMl', 'Dosis máx. (mL)'],
                  ['maxCorrectionsPerHour', 'Correcciones/h máx.'],
                  ['noProgressLimit', 'Límite sin respuesta'],
                ] as [keyof LoopConfig, string][]
              ).map(([k, label]) => (
                <tr key={k}>
                  <td>{label}</td>
                  {(['ph', 'ec', 'orp'] as LoopId[]).map((l) => (
                    <td key={l}>
                      <NumInput value={c.loops[l][k]} min={0} width={80} onCommit={(v) => v !== null && e.updateConfig((x) => (x.control.loops[l][k] = v), `Lazo ${l}: ${k} = ${v}`)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
