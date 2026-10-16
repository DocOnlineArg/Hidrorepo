/**
 * Escenarios predefinidos. Cada escenario fija condiciones iniciales, una
 * configuración base y perturbaciones programadas.
 */
import type { Engine } from './engine';
import { DEFAULT_INITIAL, type InitialConditions } from './physics/plant';
import { createDefaultConfig } from './config';
import { HOUR, MIN } from './util';

export interface Scenario {
  id: string;
  name: string;
  description: string;
  /** true si carga la configuración de demostración (valores de ejemplo). */
  demo: boolean;
  initial: Partial<InitialConditions>;
  setup?: (e: Engine) => void;
}

const S = (ms: number) => ms / 1000;

export const SCENARIOS: Scenario[] = [
  {
    id: 'blank',
    name: 'Instalación sin configurar',
    description:
      'Estado inicial realista: sondas sin calibrar, bombas sin cebar y perfiles sin objetivos. La automatización no actúa hasta que el usuario configura y valida.',
    demo: false,
    initial: {},
  },
  {
    id: 'demo',
    name: 'Demostración (valores de ejemplo)',
    description:
      'Calibración simulada, bombas cebadas y perfiles con valores de EJEMPLO (no agronómicos) para observar la lógica de control completa.',
    demo: true,
    initial: {},
  },
  {
    id: 'ph_drift',
    name: 'Deriva de pH acelerada',
    description: 'Configuración de demostración con una deriva de pH 10× mayor de lo habitual.',
    demo: true,
    initial: { ph: 6.0, ec: 1.2 },
    setup: (e) => e.updateConfig((c) => (c.plant.phDriftPerH = 0.2), 'Escenario: deriva de pH 0,2/h'),
  },
  {
    id: 'heat_wave',
    name: 'Ola de calor',
    description: 'A los 30 min la temperatura exterior sube a 35 °C. Observe ventilador y protección térmica de luces.',
    demo: true,
    initial: { ph: 5.8, ec: 1.2 },
    setup: (e) => e.schedule(S(30 * MIN), 'Temperatura exterior 35 °C', (x) => x.perturb('extTemp', 35)),
  },
  {
    id: 'dry_air',
    name: 'Aire exterior seco',
    description: 'HR exterior 20 %: el humidificador debe trabajar; el deshumidificador queda interbloqueado.',
    demo: true,
    initial: { ph: 5.8, ec: 1.2, extRh: 20, rh: 35 },
  },
  {
    id: 'sensor_disconnect',
    name: 'Desconexión de sonda EC',
    description: 'EC baja; a los 20 min la sonda EC se desconecta en plena corrección.',
    demo: true,
    initial: { ph: 5.8, ec: 0.8 },
    setup: (e) => e.schedule(S(20 * MIN), 'Sonda EC desconectada', (x) => x.setSensorFault('ec', { disconnected: true })),
  },
  {
    id: 'empty_container',
    name: 'Recipiente pH− casi vacío',
    description: 'pH alto y recipiente de pH− con 80 mL: se vacía durante las correcciones.',
    demo: true,
    initial: { ph: 7.2, ec: 1.2 },
    setup: (e) => e.setPumpLevel('phDown', 80),
  },
  {
    id: 'noisy_sensor',
    name: 'Sonda EC ruidosa',
    description: 'EC en el objetivo pero con ruido σ = 0,05 mS/cm: no debe haber correcciones repetitivas.',
    demo: true,
    initial: { ph: 5.8, ec: 1.2 },
    setup: (e) => e.setSensorFault('ec', { noise: 0.05 }),
  },
  {
    id: 'comm_failure',
    name: 'Fallo de comunicación',
    description: 'A los 15 min se pierde el enlace con el controlador: debe activarse el estado seguro.',
    demo: true,
    initial: { ph: 6.6, ec: 1.0 },
    setup: (e) => e.schedule(S(15 * MIN), 'Enlace perdido', (x) => x.setLinkFault(true)),
  },
  {
    id: 'model_mismatch',
    name: 'Modelo del controlador erróneo',
    description:
      'El controlador cree que el pH− es 4× más débil de lo real: calcula dosis mayores (limitadas por la dosis máxima). Compare cambio esperado vs observado en el registro de decisiones.',
    demo: true,
    initial: { ph: 6.8, ec: 1.2 },
    setup: (e) =>
      e.updateConfig((c) => {
        if (c.control.estimates.phDown) c.control.estimates.phDown /= 4;
      }, 'Escenario: estimación pH− incorrecta'),
  },
];

export function getScenario(id: string): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

/** Carga un escenario: restablece configuración y estado dinámico. */
export function loadScenario(e: Engine, id: string): void {
  const sc = getScenario(id);
  const keepUi = { ecDisplayUnit: e.config.ecDisplayUnit };
  e.replaceConfig({ ...createDefaultConfig(), ...keepUi });
  e.resetRuntime({ ...DEFAULT_INITIAL, ...sc.initial }, false);
  e.scenarioId = sc.id;
  if (sc.demo) e.applyDemoSetup();
  sc.setup?.(e);
  e.log.add(e.t, 'lab', 'Escenario', `Escenario cargado: ${sc.name}`);
  e.persist();
}

export const COMPARISON_HOURS = [1, 3, 6, 12, 24];
export const H = HOUR;
