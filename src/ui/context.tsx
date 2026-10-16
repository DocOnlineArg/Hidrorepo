import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Engine } from '../core/engine';

interface Ctx {
  engine: Engine;
  version: number;
  refresh(): void;
}

const EngineContext = createContext<Ctx | null>(null);

/** Velocidades disponibles (segundos simulados por segundo real). */
export const SPEEDS = [1, 10, 60, 300, 900, 3600];

/**
 * Bucle de ejecución: cada 100 ms avanza `speed × 0,1 s` simulados, con un
 * presupuesto de CPU por fotograma para no bloquear la interfaz.
 */
export function EngineProvider({ engine, children }: { engine: Engine; children: ReactNode }) {
  const [version, setVersion] = useState(engine.version);
  const acc = useRef(0);
  const lastPersist = useRef(Date.now());

  useEffect(() => {
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const realDt = Math.min(0.5, (now - last) / 1000);
      last = now;
      if (engine.running) {
        acc.current += realDt * engine.speed;
        const budgetEnd = performance.now() + 40;
        while (acc.current >= 1 && performance.now() < budgetEnd) {
          const chunk = Math.min(Math.floor(acc.current), 200);
          engine.advance(chunk);
          acc.current -= chunk;
          if (engine.engineFault) break;
        }
        if (acc.current > engine.speed * 2) acc.current = 0; // no acumular retraso
      } else acc.current = 0;
      if (Date.now() - lastPersist.current > 5000) {
        engine.persist();
        lastPersist.current = Date.now();
      }
      setVersion((v) => (v === engine.version ? v : engine.version));
    }, 100);
    const onUnload = () => engine.persist();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [engine]);

  const refresh = () => setVersion(engine.version);
  return <EngineContext.Provider value={{ engine, version, refresh }}>{children}</EngineContext.Provider>;
}

export function useEngine(): Ctx {
  const c = useContext(EngineContext);
  if (!c) throw new Error('EngineProvider ausente');
  return c;
}
