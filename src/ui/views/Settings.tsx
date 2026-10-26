import { useRef, useState } from 'react';
import { askConfirm, exportText } from '../dialog';
import { useEngine } from '../context';
import { Card, Check, Field, NumInput, Seg } from '../components/common';
import { exportConfigJson, importConfigJson } from '../../core/persistence';
import { createDefaultConfig } from '../../core/config';
import { MODEL_NOTES } from '../../core/physics/plant';
import type { LiquidResponseModel, PlantParams } from '../../core/types';
import { PUMP_IDS, SENSOR_IDS } from '../../core/types';

const PLANT_FIELDS: [keyof PlantParams, string, string][] = [
  ['roomVolumeM3', 'Volumen de la sala', 'm³'],
  ['heatCapacityJPerK', 'Capacidad térmica efectiva', 'J/K'],
  ['envelopeUA', 'Pérdidas por envolvente (UA)', 'W/K'],
  ['lightsPowerW', 'Potencia de luces', 'W'],
  ['lightsHeatFraction', 'Fracción a calor', '0–1'],
  ['fanFlowM3h', 'Caudal del ventilador', 'm³/h'],
  ['leakACH', 'Infiltración', 'renov./h'],
  ['humidifierGPerH', 'Humidificador', 'g/h'],
  ['dehumidifierGPerH', 'Deshumidificador', 'g/h'],
  ['dehumidifierHeatW', 'Calor del deshumidificador', 'W'],
  ['transpirationLightGPerH', 'Transpiración (luz)', 'g/h'],
  ['transpirationDarkGPerH', 'Transpiración (oscuridad)', 'g/h'],
  ['waterTauMin', 'Constante térmica del agua', 'min'],
  ['evaporationLPerH', 'Evaporación del depósito', 'L/h'],
  ['mixingTauS', 'Constante de mezcla', 's'],
  ['phDriftPerH', 'Deriva de pH', 'pH/h'],
  ['ecDriftPerH', 'Deriva de EC', 'mS/cm/h'],
  ['orpBaselineMv', 'ORP de equilibrio', 'mV'],
  ['orpRelaxTauH', 'Relajación del ORP', 'h'],
  ['phBufferFactor', 'Factor tampón', '×'],
  ['extTempAmplitude', 'Oscilación diaria exterior', '°C'],
];

export function SettingsView() {
  const { engine: e } = useEngine();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState('');
  const c = e.config;
  return (
    <>
      <div className="section-title">
        <h2>Configuración</h2>
      </div>
      <div className="grid wide">
        <Card title="Persistencia y exportación">
          <p className="note">La configuración, calibraciones, niveles de recipientes y la hora simulada se guardan automáticamente en este navegador (localStorage). Al reiniciar nunca se vuelve al modo hardware ni con salidas armadas.</p>
          <div className="row">
            <button className="btn primary" onClick={() => exportText(`hidrotwin-config-${new Date().toISOString().slice(0, 10)}.json`, exportConfigJson(c))}>
              Exportar parámetros (JSON)
            </button>
            <button className="btn" onClick={() => fileRef.current?.click()}>
              Importar…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              hidden
              onChange={async (ev) => {
                const f = ev.target.files?.[0];
                if (!f) return;
                try {
                  const cfg = importConfigJson(await f.text());
                  e.replaceConfig(cfg);
                  setMsg('Configuración importada.');
                } catch (err) {
                  setMsg(`Error: ${(err as Error).message}`);
                }
                ev.target.value = '';
              }}
            />
            <button
              className="btn danger"
              onClick={async () => {
                if (!(await askConfirm('Restablecer toda la configuración a los valores por defecto (sin objetivos).', { okText: 'Restablecer', danger: true }))) return;
                e.replaceConfig(createDefaultConfig());
                e.scenarioId = 'blank';
                e.resetRuntime(undefined, false);
                setMsg('Configuración restablecida.');
              }}
            >
              Restablecer valores por defecto
            </button>
          </div>
          {msg && <div className="note">{msg}</div>}
          <div className="fields">
            <Field label="Unidad de EC">
              <Seg value={c.ecDisplayUnit} onChange={(u) => e.updateConfig((x) => (x.ecDisplayUnit = u), `Unidad EC ${u}`)} options={[{ value: 'mS/cm', label: 'mS/cm' }, { value: 'µS/cm', label: 'µS/cm' }]} />
            </Field>
            <Field label="Timeout de comunicación" unit="s">
              <NumInput value={c.commTimeoutS} min={1} onCommit={(v) => v !== null && e.updateConfig((x) => (x.commTimeoutS = v), `Timeout comunicación ${v} s`)} />
            </Field>
            <Field label="Muestreo del historial" unit="s">
              <NumInput value={c.historyIntervalS} min={1} onCommit={(v) => v !== null && e.updateConfig((x) => (x.historyIntervalS = v), `Historial cada ${v} s`)} />
            </Field>
          </div>
        </Card>
        <Card title="Qué está validado y qué es aproximado">
          <h4>Ecuaciones validadas</h4>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.82rem' }}>
            {MODEL_NOTES.validated.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <h4>Modelos aproximados (no predictivos)</h4>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.82rem' }}>
            {MODEL_NOTES.approximate.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="note warn">Ninguna salida de la simulación debe interpretarse como predicción exacta del comportamiento real.</p>
        </Card>
      </div>

      <Card title="Modelo de respuesta de los líquidos (simulador)">
        <p className="note warn">Aproximación lineal por mL dosificado por litro de depósito. Marque "validado" solo si identificó los coeficientes con mediciones propias. Estos valores son la "verdad" del simulador; el controlador usa sus propias estimaciones (pestaña Automatización).</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Líquido</th>
                <th>Clase</th>
                <th>ΔEC (mS/cm) por mL/L</th>
                <th>ΔpH por mL/L</th>
                <th>ΔORP (mV) por mL/L</th>
                <th>Validado</th>
              </tr>
            </thead>
            <tbody>
              {PUMP_IDS.map((id) => {
                const l = c.liquids[id];
                const set = (k: keyof LiquidResponseModel, v: number | boolean | null) => v !== null && e.updateConfig((x) => ((x.liquids[id].model as unknown as Record<string, unknown>)[k] = v), `Modelo ${l.name}: ${k} = ${v}`);
                return (
                  <tr key={id}>
                    <td>{l.name}</td>
                    <td>
                      <small>{l.chemClass}</small>
                    </td>
                    <td>
                      <NumInput value={l.model.ecPerMlPerL} onCommit={(v) => set('ecPerMlPerL', v)} width={80} />
                    </td>
                    <td>
                      <NumInput value={l.model.phPerMlPerL} onCommit={(v) => set('phPerMlPerL', v)} width={80} />
                    </td>
                    <td>
                      <NumInput value={l.model.orpPerMlPerL} onCommit={(v) => set('orpPerMlPerL', v)} width={80} />
                    </td>
                    <td>
                      <Check checked={l.model.validated} onChange={(v) => set('validated', v)}>
                        {l.model.validated ? 'sí' : 'no'}
                      </Check>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid wide">
        <Card title="Parámetros del modelo físico (aproximado)">
          <div className="fields">
            {PLANT_FIELDS.map(([k, label, unit]) => (
              <Field key={k} label={label} unit={unit}>
                <NumInput value={c.plant[k]} onCommit={(v) => v !== null && e.updateConfig((x) => (x.plant[k] = v), `Modelo físico: ${label} = ${v}`)} width={80} />
              </Field>
            ))}
          </div>
        </Card>
        <Card title="Sensores: rango y calibración">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sensor</th>
                  <th>Rango</th>
                  <th>Calibración</th>
                  <th>Validez (días)</th>
                  <th>Datos antiguos tras (s)</th>
                </tr>
              </thead>
              <tbody>
                {SENSOR_IDS.map((id) => {
                  const s = c.sensors[id];
                  return (
                    <tr key={id}>
                      <td>{s.label}</td>
                      <td className="mono">
                        {s.rangeMin}…{s.rangeMax} {s.unit}
                      </td>
                      <td>{s.requiresCalibration ? 'requerida' : 'no'}</td>
                      <td>
                        <NumInput value={s.calibrationValidityDays} min={1} width={70} disabled={!s.requiresCalibration} onCommit={(v) => v !== null && e.updateConfig((x) => (x.sensors[id].calibrationValidityDays = v), `${s.label}: validez ${v} d`)} />
                      </td>
                      <td>
                        <NumInput value={s.staleAfterS} min={1} width={70} onCommit={(v) => v !== null && e.updateConfig((x) => (x.sensors[id].staleAfterS = v), `${s.label}: datos antiguos ${v} s`)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
