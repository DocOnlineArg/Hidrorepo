import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { EngineProvider } from './context';
import { Engine } from '../core/engine';
import { LocalStorageStore } from '../core/persistence';
import { loadScenario } from '../core/scenarios';

const store = new LocalStorageStore();
const firstVisit = store.load() === null;
const engine = new Engine({ store });
// Versión publicada: la primera visita abre la demostración en marcha.
if (import.meta.env.VITE_PUBLISHED === '1' && firstVisit) {
  loadScenario(engine, 'demo');
  engine.speed = 60;
  engine.running = true;
}
// Exposición para depuración desde la consola del navegador.
(window as unknown as { hydro: Engine }).hydro = engine;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EngineProvider engine={engine}>
      <App />
    </EngineProvider>
  </StrictMode>,
);
