import { useState } from 'react';
import { askText, showMessage } from '../dialog';
import { useEngine } from '../context';
import { Card, Check, Chip, Field, Flash, Level, NumInput, Reasons, useFlash } from '../components/common';
import type { CompatStatus, PumpId } from '../../core/types';
import { PUMP_IDS } from '../../core/types';
import { evaluatePumpStart, dosedInWindow, compatStatus } from '../../core/safety/safety';
import { DAY, formatDuration, formatSimTime, pairKey } from '../../core/util';

export function DosingView() {
  const { engine: e } = useEngine();
  const pumpEvents = e.log.events.filter((ev) => ev.category === 'pump' || (ev.category === 'safety' && ev.source.startsWith('Bomba'))).slice(-60).reverse();
  return (
    <>
      <div className="section-title">
        <h2>Dosificación</h2>
        <Check checked={e.config.compatibility.allowSimultaneousDosing} onChange={(v) => e.updateConfig((c) => (c.compatibility.allowSimultaneousDosing = v), `Dosificación simultánea ${v ? 'permitida (solo pares compatibles)' : 'deshabilitada'}`)}>
          Permitir dosificación simultánea (solo pares validados como compatibles)
        </Check>
      </div>
      <p className="note warn">
        Los efectos de cada líquido sobre el depósito son modelos lineales aproximados y configurables, no datos de productos reales. Ninguna dosis automática se calcula con valores universales.
      </p>
      <div className="grid">
        {PUMP_IDS.map((id) => (
          <PumpCard key={id} id={id} />
        ))}
      </div>
      <div className="grid wide">
        <OxidantPanel />
        <CompatMatrix />
      </div>
      <div className="grid wide">
        <Card title="Bloqueos activos para dosificación automática">
          <div className="table-wrap">
            <table>
              <tbody>
                {PUMP_IDS.map((id) => {
                  const v = evaluatePumpStart(e.safetyCtx(), id, 1, 'auto');
                  return (
                    <tr key={id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{e.config.liquids[id].name}</td>
                      <td>{v.ok ? <Chip tone="ok">Permitida</Chip> : <Reasons reasons={v.reasons} />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Historial de operaciones">
          <div className="scroll">
            <ul className="event-list">
              {pumpEvents.map((ev) => (
                <li key={ev.id}>
                  <time>{formatSimTime(ev.t)}</time>
                  <span>
                    <small>{ev.source}:</small> {ev.message}
                  </span>
                </li>
              ))}
              {pumpEvents.length === 0 && <small>Sin operaciones todavía</small>}
            </ul>
          </div>
        </Card>
      </div>
    </>
  );
}

function PumpCard({ id }: { id: PumpId }) {
  const { engine: e } = useEngine();
  const [msg, setMsg] = useFlash();
  const pc = e.config.pumps[id];
  const rt = e.pumps[id];
  const liq = e.config.liquids[id];
  const empty = rt.levelMl <= pc.emptyThresholdMl;
  const testMl = (pc.flowMlPerMin * pc.testDurationS) / 60;
  const set = (k: keyof typeof pc, v: number | null, label: string) => v !== null && e.updateConfig((c) => ((c.pumps[id] as unknown as Record<string, number>)[k] = v), `${pc.label}: ${label} = ${v}`);
  const elapsed = rt.running && rt.runStartedAt !== null ? (e.t - rt.runStartedAt) / 1000 : 0;
  const sinceLast = rt.lastRunEndAt !== null ? (e.t - rt.lastRunEndAt) / 1000 : null;
  const events = e.log.events.filter((ev) => ev.source === pc.label).slice(-3).reverse();

  return (
    <Card
      tone={rt.locked || empty ? 'alert' : undefined}
      title={
        <div className="row">
          <span className="dot" style={{ color: liq.color, width: 12, height: 12 }} />
          <div>
            <h3>{pc.label}</h3>
            <small>
              {liq.name} · {liq.chemClass}
            </small>
          </div>
        </div>
      }
      extra={
        <>
          {rt.running && <Chip tone="ok">EN MARCHA {elapsed.toFixed(0)} s</Chip>}
          {rt.locked && <Chip tone="bad">BLOQUEADA</Chip>}
          {empty && <Chip tone="bad">VACÍO</Chip>}
          <Chip tone={rt.primed ? 'ok' : 'warn'}>{rt.primed ? 'Cebada' : 'Sin cebar'}</Chip>
        </>
      }
    >
      <div>
        <div className="row between">
          <small>Recipiente (nivel simulado)</small>
          <small className="mono">
            {rt.levelMl.toFixed(0)} / {pc.containerCapacityMl} mL
          </small>
        </div>
        <Level value={rt.levelMl} max={pc.containerCapacityMl} color={empty ? 'var(--bad)' : liq.color} />
      </div>
      {rt.locked && <div className="note bad">Bloqueo: {rt.lockReason}</div>}
      <div className="fields">
        <Field label="Caudal" unit="mL/min">
          <NumInput value={pc.flowMlPerMin} min={0.1} onCommit={(v) => set('flowMlPerMin', v, 'caudal')} width={70} />
        </Field>
        <Field label="Duración prueba" unit="s">
          <NumInput value={pc.testDurationS} min={0.5} onCommit={(v) => set('testDurationS', v, 'duración prueba')} width={70} />
        </Field>
        <Field label="Volumen/operación" unit="mL">
          <span className="mono">{testMl.toFixed(2)}</span>
        </Field>
        <Field label="Intervalo mínimo" unit="s">
          <NumInput value={pc.minIntervalS} min={0} onCommit={(v) => set('minIntervalS', v, 'intervalo mínimo')} width={70} />
        </Field>
        <Field label="Tiempo máximo" unit="s">
          <NumInput value={pc.maxRunS} min={1} onCommit={(v) => set('maxRunS', v, 'tiempo máximo')} width={70} />
        </Field>
        <Field label="Capacidad" unit="mL">
          <NumInput value={pc.containerCapacityMl} min={10} onCommit={(v) => set('containerCapacityMl', v, 'capacidad')} width={70} />
        </Field>
        <Field label="Umbral vacío" unit="mL">
          <NumInput value={pc.emptyThresholdMl} min={0} onCommit={(v) => set('emptyThresholdMl', v, 'umbral vacío')} width={70} />
        </Field>
        <Field label="Volumen de cebado" unit="mL">
          <NumInput value={pc.primeVolumeMl} min={0.1} onCommit={(v) => set('primeVolumeMl', v, 'cebado')} width={70} />
        </Field>
      </div>
      <dl className="kv">
        <dt>Acumulado</dt>
        <dd>
          {rt.totalDosedMl.toFixed(1)} mL en {rt.opCount} operaciones (24 h: {dosedInWindow(rt, e.t, DAY).toFixed(1)} mL)
        </dd>
        <dt>Última operación</dt>
        <dd>{rt.lastOpMl ? `${rt.lastOpMl.toFixed(2)} mL, hace ${sinceLast !== null ? formatDuration(sinceLast) : '—'}` : '—'}</dd>
      </dl>
      <div className="row">
        <button className="btn small primary" disabled={rt.running} onClick={() => setMsg(e.testPump(id))}>
          Probar ({testMl.toFixed(1)} mL)
        </button>
        <button className="btn small" disabled={rt.running} onClick={() => setMsg(e.primePump(id))}>
          Cebar
        </button>
        <button className="btn small" disabled={rt.running || id === 'oxidant'} onClick={() => setMsg(e.holdPump(id))} title="Accionamiento manual mantenido (cortado por el tiempo máximo)">
          Mantener
        </button>
        <button className="btn small" disabled={!rt.running} onClick={() => e.stopPumpManual(id)}>
          Detener
        </button>
        <button className="btn small" onClick={() => e.refillPump(id)}>
          Rellenar
        </button>
        {rt.locked ? (
          <button className="btn small" onClick={() => setMsg(e.unlockPump(id))}>
            Desbloquear
          </button>
        ) : (
          <button className="btn small danger" onClick={() => e.lockPump(id)}>
            Bloquear
          </button>
        )}
      </div>
      <Flash msg={msg} />
      <FlowCalibration id={id} />
      {events.length > 0 && (
        <ul className="event-list">
          {events.map((ev) => (
            <li key={ev.id}>
              <time>{formatSimTime(ev.t, false)}</time>
              <small>{ev.message}</small>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function OxidantPanel() {
  const { engine: e } = useEngine();
  const g = e.config.oxidantGuard;
  const checkAge = g.lastIndependentCheckAt !== null ? (e.t - g.lastIndependentCheckAt) / 3600_000 : null;
  const checkValid = checkAge !== null && checkAge <= g.independentCheckValidityH;
  const upd = (fn: (c: typeof g) => void, d: string) => e.updateConfig((c) => fn(c.oxidantGuard), `Subsistema oxidante: ${d}`);
  return (
    <Card title="Subsistema de seguridad del desinfectante" tone={g.enabled ? 'warnb' : undefined} extra={<Chip tone={g.enabled ? 'warn' : 'bad'}>{g.enabled ? 'Habilitado' : 'Bloqueado'}</Chip>}>
      <div className="note bad">
        El ORP no determina por sí solo una concentración química segura (depende del pH, temperatura, materia orgánica y del oxidante). Se exige una verificación independiente vigente (p. ej. medición de cloro libre / peróxido con kit) para cualquier dosis automática, límites por operación y diarios, separación temporal con cualquier otro producto y nunca dosificación simultánea.
      </div>
      <Check checked={g.acknowledgedWarning} onChange={(v) => upd((x) => { x.acknowledgedWarning = v; if (!v) x.enabled = false; }, v ? 'advertencias aceptadas' : 'advertencias retiradas')}>
        He leído las advertencias y conozco la química del oxidante que usaré
      </Check>
      <Check checked={g.enabled} disabled={!g.acknowledgedWarning} onChange={(v) => upd((x) => (x.enabled = v), v ? 'habilitado' : 'deshabilitado')}>
        Habilitar la bomba de desinfectante
      </Check>
      <div className="fields">
        <Field label="Máx. por operación" unit="mL">
          <NumInput value={g.maxDoseMl} min={0} onCommit={(v) => v !== null && upd((x) => (x.maxDoseMl = v), `máx. por operación ${v}`)} width={70} />
        </Field>
        <Field label="Máx. diario" unit="mL">
          <NumInput value={g.maxDailyMl} min={0} onCommit={(v) => v !== null && upd((x) => (x.maxDailyMl = v), `máx. diario ${v}`)} width={70} />
        </Field>
        <Field label="ORP límite absoluto" unit="mV">
          <NumInput value={g.orpHardMaxMv} onCommit={(v) => v !== null && upd((x) => (x.orpHardMaxMv = v), `ORP límite ${v}`)} width={70} />
        </Field>
        <Field label="Separación con otros" unit="s">
          <NumInput value={g.separationS} min={0} onCommit={(v) => v !== null && upd((x) => (x.separationS = v), `separación ${v}`)} width={70} />
        </Field>
        <Field label="Validez verificación" unit="h">
          <NumInput value={g.independentCheckValidityH} min={1} onCommit={(v) => v !== null && upd((x) => (x.independentCheckValidityH = v), `validez ${v} h`)} width={70} />
        </Field>
      </div>
      <div className="row">
        <Chip tone={checkValid ? 'ok' : 'bad'}>Verificación independiente: {checkAge === null ? 'nunca' : `hace ${checkAge.toFixed(1)} h${checkValid ? '' : ' (caducada)'}`}</Chip>
        <button className="btn small" onClick={() => upd((x) => (x.lastIndependentCheckAt = e.t), 'verificación independiente registrada')}>
          Registrar verificación independiente ahora
        </button>
      </div>
      <small>Dosificado en 24 h: {dosedInWindow(e.pumps.oxidant, e.t, DAY).toFixed(1)} / {g.maxDailyMl} mL</small>
    </Card>
  );
}

const COMPAT_TONE: Record<CompatStatus, string> = { compatible: 'var(--ok-soft)', incompatible: 'var(--bad-soft)', unknown: 'var(--warn-soft)' };
const COMPAT_TEXT: Record<CompatStatus, string> = { compatible: '✓', incompatible: '✕', unknown: '?' };

function CompatMatrix() {
  const { engine: e } = useEngine();
  const cycle = async (a: PumpId, b: PumpId) => {
    if (a === 'oxidant' || b === 'oxidant') return showMessage('Las combinaciones con oxidante son incompatibles por regla del sistema y no se pueden modificar.');
    const key = pairKey(a, b);
    const cur = e.config.compatibility.pairs[key];
    if (cur?.validatedBy === 'regla del sistema') return showMessage(`Regla del sistema: ${cur.note}`);
    const next: CompatStatus = cur?.status === 'unknown' ? 'compatible' : cur?.status === 'compatible' ? 'incompatible' : 'unknown';
    if (next === 'compatible') {
      const who = await askText(`Marcar ${e.config.liquids[a].name} + ${e.config.liquids[b].name} como COMPATIBLES.\nSolo hágalo con documentación del fabricante. Indique la fuente / responsable:`);
      if (!who) return;
      e.updateConfig((c) => (c.compatibility.pairs[key] = { status: 'compatible', note: 'Validado por el usuario', validatedBy: who }), `Compatibilidad ${key}: compatible (validado por ${who})`);
    } else {
      e.updateConfig((c) => (c.compatibility.pairs[key] = { status: next, note: next === 'unknown' ? 'Requiere validación' : 'Marcado incompatible por el usuario', validatedBy: next === 'unknown' ? null : 'usuario' }), `Compatibilidad ${key}: ${next}`);
    }
  };
  return (
    <Card title="Matriz de compatibilidad química">
      <p className="note">
        Se aplica cuando se permite dosificación simultánea. "?" = desconocida → bloqueada hasta validación. Pulse una celda para cambiarla. El oxidante y las reglas del sistema son fijas.
      </p>
      <div className="table-wrap">
        <table style={{ width: 'auto' }}>
          <thead>
            <tr>
              <th />
              {PUMP_IDS.map((b) => (
                <th key={b} title={e.config.liquids[b].name}>
                  {e.config.liquids[b].name.slice(0, 6)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PUMP_IDS.map((a) => (
              <tr key={a}>
                <th>{e.config.liquids[a].name.slice(0, 10)}</th>
                {PUMP_IDS.map((b) => {
                  if (a === b) return <td key={b} />;
                  const st = compatStatus(e.config, a, b);
                  const entry = e.config.compatibility.pairs[pairKey(a, b)];
                  return (
                    <td key={b} style={{ background: COMPAT_TONE[st], textAlign: 'center', cursor: 'pointer' }} title={`${entry?.note ?? ''}${entry?.validatedBy ? ` (${entry.validatedBy})` : ''}`} onClick={() => cycle(a, b)}>
                      {COMPAT_TEXT[st]}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function FlowCalibration({ id }: { id: PumpId }) {
  const { engine: e } = useEngine();
  const pc = e.config.pumps[id];
  const rt = e.pumps[id];
  const [secs, setSecs] = useState<number | null>(Math.min(60, pc.maxRunS));
  const [measured, setMeasured] = useState<number | null>(null);
  const [msg, setMsg] = useFlash();
  const testing = rt.running && rt.origin === 'calibration';
  const sim = e.mode !== 'hardware';
  return (
    <details>
      <summary>Calibrar caudal</summary>
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: '0.82rem' }}>
        <li>Coloque la salida de la manguera en una probeta graduada (el líquido no va al depósito).</li>
        <li>
          Ejecute la bomba durante{' '}
          <NumInput value={secs} min={1} max={pc.maxRunS} width={60} onCommit={setSecs} /> s{' '}
          <button className="btn small" disabled={rt.running || secs === null} onClick={() => setMsg(e.runFlowTest(id, secs as number))}>
            {testing ? 'Midiendo…' : 'Iniciar prueba'}
          </button>
        </li>
        <li>
          Lea el volumen en la probeta:{' '}
          <NumInput value={measured} min={0} allowNull width={70} onCommit={setMeasured} /> mL
          {sim && rt.lastCalibrationMl !== null && (
            <>
              {' '}
              <button className="btn small" onClick={() => setMeasured(+(rt.lastCalibrationMl as number).toFixed(1))} title="En simulación, la probeta virtual marca el volumen realmente entregado">
                Leer probeta simulada ({rt.lastCalibrationMl.toFixed(1)} mL)
              </button>
            </>
          )}
        </li>
        <li>
          <button
            className="btn small primary"
            disabled={measured === null || rt.lastCalibrationS === null}
            onClick={() => {
              setMsg(e.applyFlowCalibration(id, measured as number, rt.lastCalibrationS as number));
              setMeasured(null);
            }}
          >
            Aplicar caudal
          </button>{' '}
          {measured !== null && rt.lastCalibrationS ? <small>→ {(measured / (rt.lastCalibrationS / 60)).toFixed(2)} mL/min (actual {pc.flowMlPerMin})</small> : null}
        </li>
      </ol>
      <Flash msg={msg} okText="Hecho" />
    </details>
  );
}
