import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { EngineProvider } from './context';
import { Engine } from '../core/engine';
import { LocalStorageStore } from '../core/persistence';

const engine = new Engine({ store: new LocalStorageStore() });
// Exposición para depuración desde la consola del navegador.
(window as unknown as { hydro: Engine }).hydro = engine;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EngineProvider engine={engine}>
      <App />
    </EngineProvider>
  </StrictMode>,
);
