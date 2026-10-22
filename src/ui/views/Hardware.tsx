import { useEffect, useState } from 'react';
import { useEngine } from '../context';
import { Card, Check, Chip, Field, NumInput, Reasons, TextInput } from '../components/common';
import { Esp32WsBackend } from '../../hal/esp32Ws';
import { PIN_MAP } from '../../hal/pinmap';
import { OUTPUT_IDS, PUMP_IDS } from '../../core/types';
import { formatDuration } from '../../core/util';

const CHECKLIST = [
  'Las sondas analógicas usan su circuito de acondicionamiento/aislamiento; ninguna sonda va directa a un GPIO.',
  'Las cargas de red se accionan mediante relés/SSR o relés certificados, con fusible y diferencial; ningún GPIO controla cargas directamente.',
  'Todas las salidas tienen pull-down y quedan apagadas en reset (verificado con multímetro).',
  'El E-STOP físico corta el rail de bombas y las cargas, y ha sido probado.',
  'Se probaron las salidas con cargas ficticias y recipientes con agua antes de usar productos químicos.',
  'Los recipientes contienen los productos indicados en la configuración y la matriz de compatibilidad está revisada.',
];

export function HardwareView() {
  const { engine: e } = useEngine();
  const [url, setUrl] = useState<string | null>('ws://192.168.4.1:81/');
  const [token, setToken] = useState('');
  const [checks, setChecks] = useState<boolean[]>(CHECKLIST.map(() => false));
  const [phrase, setPhrase] = useState('');
  const [result, setResult] = useState<string[] | null>(null);
  const L = e.hardware.link();
  const hbAge = L.lastHeartbeatAt !== null ? (e.t - L.lastHeartbeatAt) / 1000 : null;
  const reported = e.mode === 'hardware' ? e.hardware.reportedOutputs() : null;
  return (
    <>
      <div className="section-title">
        <h2>Hardware (ESP32)</h2>
        <Chip tone={e.mode === 'hardware' ? 'warn' : 'info'}>{e.mode === 'hardware' ? 'Modo hardware' : `Modo ${e.mode}: el hardware no recibe órdenes`}</Chip>
      </div>
      <p className="note bad">
        La simulación nunca acciona equipos: fuera del modo hardware la compuerta de salidas no envía ninguna trama. En modo hardware, las salidas permanecen desarmadas (solo tramas "todo apagado") hasta completar la lista de verificación y confirmar con la frase ARMAR. El firmware aplica sus propias protecciones (watchdog, heartbeat, tiempo máximo, E-STOP).
      </p>
      <div className="grid wide">
        <Card title="Backend de hardware">
          <div className="row">
            <button
              className={`btn ${e.hardware.kind === 'mock' ? 'on' : ''}`}
              onClick={() => e.attachMockBackend()}
              title="Hardware simulado en el navegador (sin placa)"
            >
              Hardware simulado
            </button>
            <Field label="URL WebSocket de la ESP32">
              <TextInput value={url} onCommit={setUrl} width={220} />
            </Field>
            <Field label="Token de emparejamiento">
              <input type="password" value={token} onChange={(ev) => setToken(ev.target.value)} autoComplete="off" placeholder="ver puerto serie" style={{ width: 150 }} />
            </Field>
            <button
              className={`btn ${e.hardware.kind === 'esp32-ws' ? 'on' : ''}`}
              disabled={!url || token.length < 8}
              title={token.length < 8 ? 'Introduzca el token que la ESP32 muestra por el puerto serie' : undefined}
              onClick={() => {
                if (!confirm('Seleccionar una ESP32 FÍSICA. Las salidas seguirán desarmadas hasta la habilitación explícita. ¿Continuar?')) return;
                e.attachBackend(new Esp32WsBackend(url!, token));
              }}
            >
              ESP32 real (WebSocket)
            </button>
          </div>
          <small>
            El token nunca se envía por la red: la ESP32 manda un desafío aleatorio y el dashboard responde con HMAC-SHA256. El token no se guarda en el navegador.
          </small>
          <small>El hardware simulado emula una ESP32 (enlace, telemetría, armado, watchdog y corte por tiempo máximo) acoplada al modelo físico.</small>
          <div className="row">
            {e.mode !== 'hardware' ? (
              <button className="btn primary" onClick={() => confirm('Entrar en modo hardware (salidas desarmadas)?') && e.setMode('hardware')}>
                Entrar en modo hardware
              </button>
            ) : (
              <button className="btn" onClick={() => e.setMode('simulation')}>
                Volver a simulación (apaga y desarma)
              </button>
            )}
          </div>
          <dl className="kv">
            <dt>Backend</dt>
            <dd>
              {e.hardware.kind} {e.hardware.isPhysical ? <Chip tone="warn">FÍSICO</Chip> : <Chip tone="info">simulado</Chip>}
            </dd>
            <dt>Conexión</dt>
            <dd>{e.mode === 'hardware' ? (L.connected ? <Chip tone="ok">conectado</Chip> : <Chip tone="bad">desconectado</Chip>) : '—'}</dd>
            <dt>Autenticación</dt>
            <dd>
              {e.mode !== 'hardware' ? '—' : L.authenticated ? <Chip tone="ok">autenticado</Chip> : <Chip tone="bad">{L.authError ?? 'pendiente'}</Chip>}
            </dd>
            <dt>Último heartbeat</dt>
            <dd>{e.mode === 'hardware' && hbAge !== null ? `hace ${formatDuration(hbAge)}` : '—'}</dd>
            <dt>Firmware</dt>
            <dd>{L.firmware}</dd>
            <dt>Armado (host / dispositivo)</dt>
            <dd>
              {e.link.armed ? 'sí' : 'no'} / {L.deviceArmed ? 'sí' : 'no'}
            </dd>
            <dt>E-STOP del dispositivo</dt>
            <dd>{L.estop ? <Chip tone="bad">ACTIVO</Chip> : 'no'}</dd>
            <dt>Fallos reportados</dt>
            <dd>{L.faults.length ? L.faults.join(', ') : '—'}</dd>
            <dt>Tramas enviadas</dt>
            <dd>{e.gate.sentFrames}</dd>
          </dl>
        </Card>
        <Card title="Habilitación deliberada de salidas" tone={e.link.armed ? 'warnb' : undefined}>
          {CHECKLIST.map((c, i) => (
            <Check key={i} checked={checks[i]} onChange={(v) => setChecks((x) => x.map((y, j) => (j === i ? v : y)))}>
              {c}
            </Check>
          ))}
          <Field label='Escriba "ARMAR" para confirmar'>
            <input type="text" value={phrase} onChange={(ev) => setPhrase(ev.target.value)} autoComplete="off" />
          </Field>
          <div className="row">
            <button
              className="btn danger"
              disabled={e.mode !== 'hardware' || e.link.armed}
              onClick={() => {
                const v = e.arm(phrase, checks.every(Boolean));
                setResult(v.ok ? [] : v.reasons);
                setPhrase('');
              }}
            >
              Armar salidas
            </button>
            <button className="btn" disabled={!e.link.armed} onClick={() => e.disarm()}>
              Desarmar
            </button>
          </div>
          {result && (result.length ? <Reasons reasons={result} /> : <div className="note warn">Salidas armadas. Supervise la instalación.</div>)}
        </Card>
      </div>
      <DeviceConfigCard />
      <div className="grid wide">
        <Card title="Salidas: ordenadas vs reportadas">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Salida</th>
                  <th>Ordenada (host)</th>
                  <th>Reportada (dispositivo)</th>
                </tr>
              </thead>
              <tbody>
                {OUTPUT_IDS.map((id) => (
                  <tr key={id}>
                    <td>{id}</td>
                    <td>{e.commanded[id] ? <Chip tone="ok">ON</Chip> : 'off'}</td>
                    <td>{reported ? (reported[id] ? <Chip tone="ok">ON</Chip> : 'off') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Mapa de pines propuesto (ESP32-WROOM-32E)">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>GPIO</th>
                  <th>Señal</th>
                  <th>Dir.</th>
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {PIN_MAP.map((p) => (
                  <tr key={p.gpio}>
                    <td className="mono">{p.gpio}</td>
                    <td>{p.signal}</td>
                    <td>{p.direction}</td>
                    <td>
                      <small>{p.notes}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <small>Detalle completo en docs/hardware.md y firmware/esp32/include/pins.h.</small>
        </Card>
      </div>
    </>
  );
}

function DeviceConfigCard() {
  const { engine: e } = useEngine();
  const L = e.hardware.link();
  const dc = L.deviceConfig;
  const [hb, setHb] = useState<number | null>(dc?.hbTimeoutMs ?? null);
  const [pmax, setPmax] = useState<(number | null)[]>(dc?.pumpMaxMs.map((v) => v / 1000) ?? PUMP_IDS.map(() => null));
  const [ssid, setSsid] = useState('');
  const [pass, setPass] = useState('');
  const [sent, setSent] = useState(false);
  const dcKey = JSON.stringify(dc);
  useEffect(() => {
    if (!dc) return;
    setHb(dc.hbTimeoutMs);
    setPmax(dc.pumpMaxMs.map((v) => v / 1000));
  }, [dcKey]);
  const result = sent ? e.hardware.lastConfigResult() : null;
  const usable = e.mode === 'hardware' && L.connected && L.authenticated;
  const fromHost = () => setPmax(PUMP_IDS.map((id) => e.config.pumps[id].maxRunS));
  return (
    <Card title="Configuración persistente del dispositivo (NVS)">
      <p className="note">
        Límites que el FIRMWARE aplica por su cuenta aunque el dashboard falle. Solo se pueden cambiar con las salidas desarmadas; el dispositivo valida los rangos (heartbeat 1–10 s, bomba 1–300 s). Las credenciales Wi-Fi se aplican al reiniciar la placa.
      </p>
      {!usable && <small>Disponible en modo hardware con un dispositivo conectado y autenticado.</small>}
      <div className="fields">
        <Field label="Timeout de heartbeat" unit="ms">
          <NumInput value={hb} min={1000} max={10000} allowNull onCommit={setHb} />
        </Field>
        {PUMP_IDS.map((id, i) => (
          <Field key={id} label={`Máx. ${e.config.liquids[id].name}`} unit="s">
            <NumInput value={pmax[i]} min={1} max={300} allowNull width={70} onCommit={(v) => setPmax((x) => x.map((y, j) => (j === i ? v : y)))} />
          </Field>
        ))}
      </div>
      <div className="row">
        <button className="btn small" onClick={fromHost}>
          Copiar tiempos máximos del dashboard
        </button>
        <button
          className="btn small primary"
          disabled={!usable || e.link.armed || hb === null || pmax.some((v) => v === null)}
          onClick={() => {
            e.hardware.sendConfig({ hbTimeoutMs: hb as number, pumpMaxMs: pmax.map((v) => Math.round((v as number) * 1000)) });
            setSent(true);
          }}
        >
          Enviar límites al dispositivo
        </button>
      </div>
      <div className="fields">
        <Field label="Wi-Fi SSID">
          <input type="text" value={ssid} onChange={(ev) => setSsid(ev.target.value)} autoComplete="off" />
        </Field>
        <Field label="Wi-Fi clave">
          <input type="password" value={pass} onChange={(ev) => setPass(ev.target.value)} autoComplete="off" />
        </Field>
      </div>
      <div className="row">
        <button
          className="btn small"
          disabled={!usable || e.link.armed || !ssid}
          onClick={() => {
            if (!confirm(`Guardar la red "${ssid}" en la ESP32? Se usará en el próximo reinicio; si no conecta, la placa vuelve al punto de acceso HidroTwin.`)) return;
            e.hardware.sendConfig({ wifi: { ssid, pass } });
            setPass('');
            setSent(true);
          }}
        >
          Guardar Wi-Fi en el dispositivo
        </button>
      </div>
      {result && <div className={`note ${result.ok ? '' : 'bad'}`}>{result.ok ? 'Configuración aceptada y guardada por el dispositivo.' : `Rechazada: ${result.error}`}</div>}
      {sent && !result && <small>Esperando respuesta del dispositivo…</small>}
    </Card>
  );
}
