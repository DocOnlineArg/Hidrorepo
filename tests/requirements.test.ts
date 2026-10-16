/**
 * Pruebas de los 12 requisitos mínimos de seguridad y comportamiento (sección 11).
 */
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/core/engine';
import { loadScenario } from '../src/core/scenarios';
import { MemoryStore } from '../src/core/persistence';
import { PUMP_IDS, type OutputId } from '../src/core/types';
import type { BackendLink, HardwareBackend, OutputFrame, SensorFrame } from '../src/hal/backend';
import { evaluatePumpStart } from '../src/core/safety/safety';
import { pairKey } from '../src/core/util';

function demoEngine(scenario = 'demo'): Engine {
  const e = new Engine({ seed: 42 });
  loadScenario(e, scenario);
  return e;
}

/** Backend "físico" espía: registra toda escritura. */
class SpyPhysicalBackend implements HardwareBackend {
  readonly kind = 'esp32-ws' as const;
  readonly isPhysical = true;
  writes: OutputFrame[] = [];
  connected = false;
  now = 0;
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  tick(now: number) {
    this.now = now;
  }
  link(): BackendLink {
    return { connected: this.connected, lastHeartbeatAt: this.now, firmware: 'spy', deviceArmed: false, estop: false, faults: [] };
  }
  latestSensors(): SensorFrame | null {
    return null;
  }
  reportedOutputs(): Record<OutputId, boolean> | null {
    return null;
  }
  writeOutputs(frame: OutputFrame) {
    this.writes.push(frame);
  }
  requestArm() {}
}

const anyOn = (f: OutputFrame) => Object.values(f.outputs).some(Boolean);

describe('1. Sensor desconectado impide dosificaciones dependientes', () => {
  it('EC desconectada → ni soluciones ni aditivos automáticos; pH sigue permitido', () => {
    const e = demoEngine();
    e.perturb('ecShift', -0.5); // EC claramente baja
    e.advance(30);
    e.setSensorFault('ec', { disconnected: true });
    e.advance(3600);
    for (const id of ['solA', 'solB', 'silicon', 'bloom', 'pk'] as const) {
      expect(e.pumps[id].doseLog.filter((d) => d.origin === 'auto')).toHaveLength(0);
      const v = evaluatePumpStart(e.safetyCtx(), id, 1, 'auto');
      expect(v.ok).toBe(false);
      expect(v.reasons.join(' ')).toMatch(/disconnected/);
    }
    expect(e.chem.loops.ec.phase).toBe('blocked');
    expect(e.alarms.isActive('SENSOR_ec')).toBe(true);
    // Una bomba que no depende de EC no queda bloqueada por este sensor.
    const ph = evaluatePumpStart(e.safetyCtx(), 'phDown', 1, 'auto');
    expect(ph.reasons.join(' ')).not.toMatch(/Conductividad/);
  });

  it('sonda sin calibración válida también bloquea la dosificación automática', () => {
    const e = new Engine({ seed: 1 });
    loadScenario(e, 'demo');
    e.invalidateCalibration('ph');
    e.perturb('phShift', 1.0);
    e.advance(1800);
    expect(e.pumps.phDown.doseLog).toHaveLength(0);
    expect(e.sensors.ph.reading.status).toBe('uncalibrated');
  });
});

describe('2. Una bomba alcanza su límite de tiempo y se apaga', () => {
  it('accionamiento mantenido se corta en maxRunS, bloquea y alarma', () => {
    const e = demoEngine();
    const max = e.config.pumps.solA.maxRunS;
    expect(e.holdPump('solA').ok).toBe(true);
    e.advance(max - 1);
    expect(e.pumps.solA.running).toBe(true);
    e.advance(2);
    expect(e.pumps.solA.running).toBe(false);
    expect(e.pumps.solA.locked).toBe(true);
    expect(e.alarms.isActive('PUMP_MAXRUN_solA')).toBe(true);
    const ml = e.pumps.solA.lastOpMl;
    expect(ml).toBeCloseTo((e.config.pumps.solA.flowMlPerMin * max) / 60, 1);
  });

  it('una dosis cuya duración excede el máximo se rechaza antes de arrancar', () => {
    const e = demoEngine();
    const v = evaluatePumpStart(e.safetyCtx(), 'phUp', 1000, 'manual_test');
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/supera el máximo/);
  });
});

describe('3. Un recipiente vacío genera una alarma', () => {
  it('la bomba se detiene, se bloquea y se registra alarma crítica', () => {
    const e = demoEngine();
    e.setAutomation(false);
    e.setPumpLevel('phDown', 52); // umbral 50 mL; la prueba entrega ~4,2 mL
    expect(e.testPump('phDown').ok).toBe(true);
    e.advance(10);
    expect(e.pumps.phDown.running).toBe(false);
    expect(e.pumps.phDown.locked).toBe(true);
    expect(e.pumps.phDown.primed).toBe(false);
    const a = e.alarms.alarms.find((x) => x.key === 'PUMP_EMPTY_phDown');
    expect(a?.active).toBe(true);
    expect(a?.severity).toBe('critical');
    // Rellenar despeja la alarma pero exige cebado para uso automático.
    e.refillPump('phDown');
    expect(e.alarms.isActive('PUMP_EMPTY_phDown')).toBe(false);
    expect(evaluatePumpStart(e.safetyCtx(), 'phDown', 1, 'auto').reasons).toContain('Bomba sin cebar');
  });
});

describe('4. El temporizador de luces conserva el ciclo tras reiniciar', () => {
  it('horario 18/6 persiste y el estado depende solo de la hora', () => {
    const store = new MemoryStore();
    const e1 = new Engine({ store, seed: 3 });
    loadScenario(e1, 'demo'); // inicio 05:30, luces 06:00 + 18 h
    e1.updateProfile('veg', 'lights.onTime', '06:00');
    e1.updateProfile('veg', 'lights.photoperiodH', 18);
    expect(e1.validateProfile('veg').ok).toBe(true);
    e1.advance(20 * 60); // 05:50
    expect(e1.relays.lights.on).toBe(false);
    e1.persist();

    // "Reinicio": nueva instancia desde el mismo almacenamiento.
    const e2 = new Engine({ store, seed: 3 });
    expect(e2.config.profiles.veg.lights).toEqual({ onTime: '06:00', photoperiodH: 18 });
    expect(e2.t).toBe(e1.t);
    expect(e2.mode).toBe('simulation');
    e2.advance(11 * 60); // 06:01
    expect(e2.relays.lights.on).toBe(true);
    e2.advance(17 * 3600 + 58 * 60); // 23:59
    expect(e2.relays.lights.on).toBe(true);
    e2.advance(2 * 60); // 00:01
    expect(e2.relays.lights.on).toBe(false);
    e2.advance(6 * 3600); // 06:01 del día siguiente
    expect(e2.relays.lights.on).toBe(true);
  });
});

describe('5. Humidificador y deshumidificador respetan sus interbloqueos', () => {
  it('órdenes manuales simultáneas: solo uno queda encendido', () => {
    const e = demoEngine();
    e.setRelay('humidifier', 'manual', true);
    e.advance(5);
    e.setRelay('dehumidifier', 'manual', true);
    for (let i = 0; i < 600; i++) {
      e.step();
      expect(e.relays.humidifier.on && e.relays.dehumidifier.on).toBe(false);
      expect(e.plant.state.applied.humidifier && e.plant.state.applied.dehumidifier).toBe(false);
    }
    expect(e.relays.humidifier.on).toBe(true);
    expect(e.alarms.isActive('INTERLOCK_HUM_DEHUM')).toBe(true);
  });

  it('en automático con aire seco nunca coinciden', () => {
    const e = demoEngine('dry_air');
    let both = 0;
    for (let i = 0; i < 4 * 3600; i++) {
      e.step();
      if (e.relays.humidifier.on && e.relays.dehumidifier.on) both++;
    }
    expect(both).toBe(0);
    expect(e.relays.humidifier.cycles).toBeGreaterThan(0);
  });

  it('se permite solo con justificación configurada explícitamente', () => {
    const e = demoEngine();
    e.updateConfig((c) => {
      c.climate.allowHumDehumSimultaneous = true;
      c.climate.simultaneousJustification = 'Prueba de equipos';
    }, 'test');
    e.setRelay('humidifier', 'manual', true);
    e.setRelay('dehumidifier', 'manual', true);
    e.advance(200);
    expect(e.relays.humidifier.on && e.relays.dehumidifier.on).toBe(true);
  });
});

describe('6. Una lectura ruidosa no genera oscilaciones constantes', () => {
  it('EC en objetivo con ruido σ=0,05: ninguna o casi ninguna corrección en 6 h', () => {
    const e = demoEngine('noisy_sensor');
    e.advance(6 * 3600);
    const doses = e.pumps.solA.opCount;
    expect(doses).toBeLessThanOrEqual(1);
  });

  it('HR ruidosa: el ruido no multiplica las conmutaciones (histéresis + filtro + tiempos mínimos)', () => {
    const run = (noise: number) => {
      const e = demoEngine('dry_air');
      e.setSensorFault('rh', { noise });
      e.advance(4 * 3600);
      return e.relays.humidifier.cycles + e.relays.dehumidifier.cycles;
    };
    const clean = run(0);
    const noisy = run(2);
    // Las conmutaciones se deben a la dinámica física (ciclo límite), no al ruido.
    expect(noisy).toBeLessThanOrEqual(Math.ceil(clean * 1.3) + 5);
  });

  it('frente a un control ingenuo (sin filtro, sin histéresis, sin tiempos mínimos) las protecciones reducen drásticamente las conmutaciones', () => {
    const run = (naive: boolean) => {
      const e = demoEngine('dry_air');
      if (naive) {
        e.updateConfig((c) => {
          c.climate.humidifier.minOnS = 0;
          c.climate.humidifier.minOffS = 0;
          c.sensors.rh.filter.kind = 'none';
        }, 'test');
        e.updateProfile('veg', 'climate.rh.deadband', 0.01);
        e.validateProfile('veg');
      }
      e.setSensorFault('rh', { noise: 2 });
      e.advance(2 * 3600);
      return e.relays.humidifier.cycles;
    };
    expect(run(true)).toBeGreaterThan(5 * run(false));
  });
});

describe('7. Un fallo de comunicación activa un estado seguro', () => {
  it('simulación: pérdida de enlace → estado seguro, todo apagado', () => {
    const e = demoEngine();
    e.setRelay('fan', 'manual', true);
    e.holdPump('solA');
    e.advance(2);
    expect(e.plant.state.applied.fan).toBe(true);
    e.setLinkFault(true);
    e.advance(e.config.commTimeoutS + 2);
    expect(e.safeState).toBe(true);
    expect(PUMP_IDS.every((id) => !e.pumps[id].running)).toBe(true);
    expect(Object.values(e.commanded).some(Boolean)).toBe(false);
    expect(Object.values(e.plant.state.applied).some(Boolean)).toBe(false);
    expect(e.alarms.isActive('COMM_LOSS')).toBe(true);
    // Restablecer exige enlace sano.
    expect(e.resetSafeState().ok).toBe(false);
    e.setLinkFault(false);
    e.advance(1);
    expect(e.resetSafeState().ok).toBe(true);
  });

  it('hardware simulado: el enlace caído fuerza estado seguro y desarme', () => {
    const e = demoEngine();
    e.setMode('hardware');
    e.advance(1);
    expect(e.arm('ARMAR', true).ok).toBe(true);
    e.advance(2);
    e.setLinkFault(true);
    e.advance(e.config.commTimeoutS + 2);
    expect(e.safeState).toBe(true);
    expect(e.link.armed).toBe(false);
    expect(Object.values(e.hardware.reportedOutputs() ?? {}).some(Boolean)).toBe(false);
  });
});

describe('8. Una dosificación no se repite antes de terminar el tiempo de mezcla', () => {
  it('pH alto persistente: separación entre dosis ≥ duración + mezcla + estabilización', () => {
    const e = demoEngine();
    e.perturb('phShift', 1.5); // pH muy alto → varias correcciones
    e.advance(3 * 3600);
    const doses = e.pumps.phDown.doseLog.filter((d) => d.origin === 'auto');
    expect(doses.length).toBeGreaterThanOrEqual(2);
    const lc = e.config.control.loops.ph;
    for (let i = 1; i < doses.length; i++) {
      const gapS = (doses[i].t - doses[i - 1].t) / 1000;
      expect(gapS).toBeGreaterThanOrEqual(lc.mixS + lc.stabilizeS);
    }
    // Cada dosis queda justificada en el registro de decisiones.
    expect(e.decisions.filter((d) => d.loop === 'ph' && d.action === 'dose').length).toBe(doses.length);
  });
});

describe('9. Los perfiles mantienen configuraciones independientes', () => {
  it('editar un perfil no altera el otro; cambiar de perfil conserva el historial', () => {
    const e = demoEngine();
    const flowerBefore = JSON.stringify(e.config.profiles.flower);
    e.updateProfile('veg', 'reservoir.ph.target', 5.5);
    e.updateProfile('veg', 'lights.photoperiodH', 20);
    expect(JSON.stringify(e.config.profiles.flower)).toBe(flowerBefore);
    expect(e.config.profiles.veg.reservoir.ph.target).toBe(5.5);
    expect(e.config.profiles.veg.validated).toBe(false); // editar invalida
    e.advance(600);
    const pts = e.history.get('ph').t.length;
    const diff = e.setActiveProfile('flower');
    expect(diff.length).toBeGreaterThan(0);
    expect(e.history.get('ph').t.length).toBe(pts);
    expect(e.profile.id).toBe('flower');
    expect(e.config.profiles.veg.reservoir.ph.target).toBe(5.5);
    expect(e.config.profiles.flower.lights.photoperiodH).toBe(12);
  });

  it('un perfil nuevo no tiene objetivos y no se puede validar vacío', () => {
    const e = new Engine();
    expect(e.config.profiles.veg.reservoir.ph.target).toBeNull();
    const v = e.validateProfile('veg');
    expect(v.ok).toBe(false);
    expect(v.reasons.length).toBeGreaterThan(3);
  });
});

describe('10. Ningún fallo del simulador puede activar una salida de hardware', () => {
  it('en modo simulación el backend físico nunca recibe tramas, aun con fallos', () => {
    const spy = new SpyPhysicalBackend();
    const e = new Engine({ seed: 9, hardware: spy });
    loadScenario(e, 'demo');
    e.attachBackend(spy);
    e.setRelay('fan', 'manual', true);
    e.holdPump('solA');
    e.setSensorFault('ph', { forcedRaw: 99 });
    e.setSensorFault('rh', { disconnected: true });
    e.perturb('phShift', 2);
    e.advance(1200);
    e.testHook = () => {
      throw new Error('fallo inyectado en el simulador');
    };
    e.advance(10);
    expect(e.engineFault).toMatch(/fallo inyectado/);
    expect(e.safeState).toBe(true);
    expect(spy.writes).toHaveLength(0);
  });

  it('en modo hardware sin armar solo se envían tramas con todo apagado', () => {
    const spy = new SpyPhysicalBackend();
    const e = new Engine({ seed: 9, hardware: spy });
    loadScenario(e, 'demo');
    e.attachBackend(spy);
    e.setMode('hardware');
    e.setRelay('fan', 'manual', true);
    e.holdPump('solA'); // rechazada: no armado
    e.advance(30);
    expect(spy.writes.length).toBeGreaterThan(0);
    expect(spy.writes.some(anyOn)).toBe(false);
    // Un fallo interno en modo hardware tampoco enciende nada.
    e.testHook = () => {
      throw new Error('boom');
    };
    e.advance(5);
    expect(spy.writes.some(anyOn)).toBe(false);
  });

  it('el armado exige modo hardware, checklist y frase exacta', () => {
    const e = demoEngine();
    expect(e.arm('ARMAR', true).ok).toBe(false); // modo simulación
    e.setMode('hardware');
    e.advance(1);
    expect(e.arm('armar', true).ok).toBe(false);
    expect(e.arm('ARMAR', false).ok).toBe(false);
    expect(e.arm('ARMAR', true).ok).toBe(true);
  });

  it('al reiniciar desde almacenamiento nunca se vuelve a modo hardware', () => {
    const store = new MemoryStore();
    const e = new Engine({ store });
    e.setMode('hardware');
    e.persist();
    const e2 = new Engine({ store });
    expect(e2.mode).toBe('simulation');
    expect(e2.link.armed).toBe(false);
  });
});

describe('11. Las combinaciones químicas incompatibles quedan bloqueadas', () => {
  it('con dosificación simultánea habilitada: incompatible y desconocida se bloquean', () => {
    const e = demoEngine();
    e.updateConfig((c) => (c.compatibility.allowSimultaneousDosing = true), 'test');
    expect(e.testPump('solA').ok).toBe(true);
    const b = e.testPump('solB'); // incompatible (concentrados)
    expect(b.ok).toBe(false);
    expect(b.reasons.join(' ')).toMatch(/incompatible/i);
    const bloom = e.testPump('bloom'); // desconocida
    expect(bloom.ok).toBe(false);
    expect(bloom.reasons.join(' ')).toMatch(/desconocida/);
    // Tras validación explícita del usuario se permite.
    e.updateConfig((c) => (c.compatibility.pairs[pairKey('solA', 'bloom')] = { status: 'compatible', note: 'validado', validatedBy: 'usuario' }), 'test');
    expect(e.testPump('bloom').ok).toBe(true);
  });

  it('el oxidante nunca se mezcla ni se dosifica cerca de otro producto', () => {
    const e = demoEngine();
    e.setAutomation(false);
    e.updateConfig((c) => {
      c.oxidantGuard.enabled = true;
      c.oxidantGuard.acknowledgedWarning = true;
      c.compatibility.allowSimultaneousDosing = true;
    }, 'test');
    expect(e.testPump('phDown').ok).toBe(true);
    const ox = e.testPump('oxidant');
    expect(ox.ok).toBe(false);
    expect(ox.reasons.join(' ')).toMatch(/oxidante|incompatible/i);
    e.advance(30); // pH− terminó, pero dentro de la separación
    const ox2 = e.testPump('oxidant');
    expect(ox2.ok).toBe(false);
    expect(ox2.reasons.join(' ')).toMatch(/Separación/);
    e.advance(e.config.oxidantGuard.separationS);
    expect(e.testPump('oxidant').ok).toBe(true);
    e.advance(2);
    expect(e.testPump('solA').ok).toBe(false); // otro producto durante el oxidante
  });

  it('el oxidante está bloqueado por defecto y en automático exige verificación independiente', () => {
    const e = demoEngine();
    expect(e.testPump('oxidant').ok).toBe(false);
    e.updateConfig((c) => {
      c.oxidantGuard.enabled = true;
      c.oxidantGuard.acknowledgedWarning = true;
    }, 'test');
    const v = evaluatePumpStart(e.safetyCtx(), 'oxidant', 2, 'auto');
    expect(v.reasons.join(' ')).toMatch(/verificación independiente/);
  });
});

describe('12. Las alarmas quedan registradas con fecha, causa y acción tomada', () => {
  it('cada alarma tiene marca de tiempo, causa y acción; y se registra en eventos', () => {
    const e = demoEngine();
    e.setSensorFault('ec', { disconnected: true });
    e.setPumpLevel('phUp', 10);
    e.setLinkFault(true);
    e.advance(60);
    expect(e.alarms.alarms.length).toBeGreaterThanOrEqual(3);
    for (const a of e.alarms.alarms) {
      expect(typeof a.raisedAt).toBe('number');
      expect(a.raisedAt).toBeGreaterThan(0);
      expect(a.cause.length).toBeGreaterThan(3);
      expect(a.actionTaken.length).toBeGreaterThan(3);
      expect(e.log.events.some((ev) => ev.category === 'alarm' && ev.message.includes(a.actionTaken))).toBe(true);
    }
    e.setLinkFault(false);
    e.advance(2);
    const comm = e.alarms.alarms.find((a) => a.key === 'COMM_LOSS');
    expect(comm?.active).toBe(false);
    expect(comm?.clearedAt).not.toBeNull();
  });
});
