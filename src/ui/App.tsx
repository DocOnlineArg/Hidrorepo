import { useState } from 'react';
import { useEngine, SPEEDS } from './context';
import type { SystemMode } from '../core/types';
import { formatSimTime } from '../core/util';
import { Chip, Seg } from './components/common';
import { OverviewView } from './views/Overview';
import { SensorsView } from './views/Sensors';
import { DosingView } from './views/Dosing';
import { ClimateView } from './views/Climate';
import { AutomationView } from './views/Automation';
import { ProfilesView } from './views/Profiles';
import { LabView } from './views/Lab';
import { HardwareView } from './views/Hardware';
import { LogView } from './views/Log';
import { SettingsView } from './views/Settings';

const TABS = [
  { id: 'overview', label: 'Vista general' },
  { id: 'sensors', label: 'Sensores' },
  { id: 'dosing', label: 'Dosificación' },
  { id: 'climate', label: 'Clima' },
  { id: 'automation', label: 'Automatización' },
  { id: 'profiles', label: 'Perfiles' },
  { id: 'lab', label: 'Laboratorio' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'log', label: 'Alarmas y eventos' },
  { id: 'settings', label: 'Configuración' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

function readTab(): TabId {
  try {
    const t = localStorage.getItem('hydro-sim/tab');
    if (t && TABS.some((x) => x.id === t)) return t as TabId;
  } catch {
    /* ignore */
  }
  return 'overview';
}

export function App() {
  const { engine: e } = useEngine();
  const [tab, setTabState] = useState<TabId>(readTab);
  const setTab = (t: string) => {
    setTabState(t as TabId);
    try {
      localStorage.setItem('hydro-sim/tab', t);
    } catch {
      /* ignore */
    }
  };
  const active = e.alarms.active();
  const critical = active.filter((a) => a.severity === 'critical').length;
  const hw = e.mode === 'hardware';
  const exampleProfile = e.profile.example;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M12 2s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12z" />
            <path d="M9 15a3 3 0 0 0 3 3" />
          </svg>
          HidroTwin
          <small style={{ fontWeight: 400 }}>ESP32 · gemelo digital</small>
        </div>
        <div className="group">
          <Seg<SystemMode>
            value={e.mode}
            onChange={(m) => {
              if (m === 'hardware' && !confirm('Modo hardware: los sensores se leerán del backend seleccionado (hardware simulado por defecto). Las salidas permanecen DESARMADAS hasta la habilitación explícita. ¿Continuar?')) return;
              e.setMode(m);
            }}
            options={[
              { value: 'simulation', label: 'Simulación' },
              { value: 'manual', label: 'Manual' },
              { value: 'hardware', label: 'Hardware' },
            ]}
          />
          <button className={`btn ${e.automationEnabled && e.mode !== 'manual' ? 'on' : ''}`} disabled={e.mode === 'manual'} onClick={() => e.setAutomation(!e.automationEnabled)} title="Activa/desactiva la automatización (control químico y climático)">
            Automatización {e.automationEnabled && e.mode !== 'manual' ? 'ON' : 'OFF'}
          </button>
          <Chip tone={e.profile.validated ? 'accent' : 'warn'}>
            Perfil: {e.profile.name}
            {e.profile.validated ? '' : ' (sin validar)'}
          </Chip>
        </div>
        <div className="spacer" />
        <div className="group">
          <span className="clock" title="Hora simulada">
            {formatSimTime(e.t)}
          </span>
          <button className="btn primary" onClick={() => { e.running = !e.running; e.version++; }} disabled={!!e.engineFault} aria-label={e.running ? 'Pausar' : 'Reanudar'}>
            {e.running ? '❚❚ Pausa' : '▶ Ejecutar'}
          </button>
          <select aria-label="Velocidad" value={e.speed} disabled={hw} onChange={(ev) => { e.speed = Number(ev.target.value); e.version++; }}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
          {[
            ['+1 s', 1],
            ['+1 min', 60],
            ['+10 min', 600],
            ['+1 h', 3600],
          ].map(([l, s]) => (
            <button key={l} className="btn small" disabled={hw || !!e.engineFault} onClick={() => e.advance(s as number)}>
              {l}
            </button>
          ))}
          <button className="btn" onClick={() => setTab('log')} title="Alarmas activas">
            Alarmas <Chip tone={critical ? 'bad' : active.length ? 'warn' : 'ok'}>{active.length}</Chip>
          </button>
          <button className="estop" onClick={() => e.emergencyStop()} title="Paro de emergencia: apaga y desarma todo">
            E-STOP
          </button>
        </div>
      </header>

      {e.mode !== 'hardware' ? (
        <div className="banner sim">
          <span>
            <strong>{e.mode === 'manual' ? 'MODO MANUAL (simulado)' : 'SIMULACIÓN'}</strong> · Los valores provienen de un modelo aproximado, no son mediciones reales. Ninguna salida física se acciona en este modo.
          </span>
        </div>
      ) : (
        <div className="banner hw">
          <strong>MODO HARDWARE</strong> Backend: {e.hardware.kind}
          {e.hardware.isPhysical ? ' (FÍSICO)' : ' (hardware simulado)'} · Salidas {e.link.armed ? 'ARMADAS' : 'DESARMADAS'}
          <button className="btn small" onClick={() => setTab('hardware')}>
            Gestionar
          </button>
        </div>
      )}
      {exampleProfile && (
        <div className="banner example">
          <span>
            El perfil activo contiene <strong>valores de EJEMPLO</strong> de demostración: no son recomendaciones agronómicas. Edítelos y valídelos antes de cualquier uso real.
          </span>
        </div>
      )}
      {(e.safeState || e.estop || e.engineFault) && (
        <div className="banner bad" role="alert">
          {e.estop ? 'PARO DE EMERGENCIA ACTIVO' : e.engineFault ? `FALLO DEL MOTOR: ${e.engineFault}` : `ESTADO SEGURO: ${e.link.safeReason}`}
          {e.estop && (
            <button className="btn small" onClick={() => e.resetEstop()}>
              Rearmar E-STOP
            </button>
          )}
          {!e.estop && !e.engineFault && (
            <button
              className="btn small"
              onClick={() => {
                const v = e.resetSafeState();
                if (!v.ok) alert('No se puede restablecer:\n' + v.reasons.join('\n'));
              }}
            >
              Restablecer estado seguro
            </button>
          )}
          {e.engineFault && (
            <button className="btn small" onClick={() => setTab('lab')}>
              Reiniciar escenario
            </button>
          )}
        </div>
      )}

      <div className="body">
        <nav className="tabs" aria-label="Secciones">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
              {t.label}
              {t.id === 'log' && active.length > 0 && <Chip tone={critical ? 'bad' : 'warn'}>{active.length}</Chip>}
            </button>
          ))}
        </nav>
        <main>
          {tab === 'overview' && <OverviewView onSelect={setTab} />}
          {tab === 'sensors' && <SensorsView />}
          {tab === 'dosing' && <DosingView />}
          {tab === 'climate' && <ClimateView />}
          {tab === 'automation' && <AutomationView />}
          {tab === 'profiles' && <ProfilesView />}
          {tab === 'lab' && <LabView />}
          {tab === 'hardware' && <HardwareView />}
          {tab === 'log' && <LogView />}
          {tab === 'settings' && <SettingsView />}
        </main>
      </div>
    </div>
  );
}
