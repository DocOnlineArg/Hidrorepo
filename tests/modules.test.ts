import { describe, expect, it } from 'vitest';
import { createDefaultConfig } from '../src/core/config';
import {
  captureCalibrationPoint,
  createSensorRuntime,
  finishCalibration,
  isUsable,
  processSample,
  startCalibration,
  type RawSample,
} from '../src/core/sensors/sensor';
import { absFromRh, rhFromAbs, saturationVaporPressure } from '../src/core/physics/plant';
import { photoperiodFromTimes, scheduleInfo } from '../src/core/control/lights';
import { diffProfiles, profileProblems } from '../src/core/profiles';
import { parseDevice, encodeHost } from '../src/hal/protocol';
import { Esp32WsBackend, type Transport } from '../src/hal/esp32Ws';
import { authResponse, hmacSha256, sha256, toHex } from '../src/hal/hmac';
import { OutputGate, offOutputs } from '../src/hal/backend';
import { MockHardwareBackend } from '../src/hal/mockHardware';
import { exportConfigJson, importConfigJson } from '../src/core/persistence';
import { runComparison } from '../src/core/compare';
import { Engine } from '../src/core/engine';
import { loadScenario } from '../src/core/scenarios';
import { ecFromDisplay, ecToDisplay } from '../src/core/util';

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const sample = (raw: number | null, ts: number, extra: Partial<RawSample> = {}): RawSample => ({
  raw,
  ts,
  source: 'simulated',
  connected: raw !== null,
  engineering: false,
  ...extra,
});

describe('Pipeline de sensores', () => {
  const cfg = createDefaultConfig().sensors;

  it('pH sin calibrar → uncalibrated (no apto); tras calibración 2 puntos → ok y corregido', () => {
    const rt = createSensorRuntime(cfg.ph, 0);
    const probe = (v: number) => v * 0.97 + 0.12;
    let r = processSample(cfg.ph, rt, sample(probe(6), T0));
    expect(r.status).toBe('uncalibrated');
    expect(isUsable(r)).toBe(false);
    startCalibration(rt, [7, 4]);
    captureCalibrationPoint(rt, 7, probe(7), T0);
    captureCalibrationPoint(rt, 4, probe(4), T0);
    expect(finishCalibration(rt, T0).ok).toBe(true);
    for (let i = 1; i <= 20; i++) r = processSample(cfg.ph, rt, sample(probe(6), T0 + i * 1000));
    expect(r.status).toBe('ok');
    expect(r.value).toBeCloseTo(6, 3);
  });

  it('calibración con pendiente fuera de tolerancia se rechaza (sonda defectuosa)', () => {
    const rt = createSensorRuntime(cfg.ph, 0);
    startCalibration(rt, [7, 4]);
    captureCalibrationPoint(rt, 7, 7, T0);
    captureCalibrationPoint(rt, 4, 6, T0); // pendiente 3×
    const res = finishCalibration(rt, T0);
    expect(res.ok).toBe(false);
    expect(rt.calibration.status).toBe('none');
  });

  it('calibración caduca tras el periodo de validez', () => {
    const c = { ...cfg.ph, calibrationValidityDays: 1 };
    const rt = createSensorRuntime(c, 0);
    rt.calibration = { ...rt.calibration, status: 'valid', calibratedAt: T0 };
    expect(processSample(c, rt, sample(6, T0 + 3600_000)).status).toBe('ok');
    expect(processSample(c, rt, sample(6.01, T0 + 2 * 86400_000)).status).toBe('uncalibrated');
    expect(rt.calibration.status).toBe('expired');
  });

  it('desconexión, fuera de rango, pico y atascado', () => {
    const rt = createSensorRuntime(cfg.rh, 0);
    expect(processSample(cfg.rh, rt, sample(null, T0)).status).toBe('disconnected');
    expect(processSample(cfg.rh, rt, sample(130, T0 + 1000)).status).toBe('out_of_range');
    for (let i = 0; i < 5; i++) processSample(cfg.rh, rt, sample(50 + (i % 2) * 0.1, T0 + 2000 + i * 1000));
    const spike = processSample(cfg.rh, rt, sample(90, T0 + 8000));
    expect(spike.status).toBe('suspect');
    expect(spike.value).not.toBeNull();
    expect(spike.value as number).toBeLessThan(55); // conserva el valor previo
    const rt2 = createSensorRuntime(cfg.airTemp, 0);
    let r = processSample(cfg.airTemp, rt2, sample(22, T0));
    for (let i = 1; i <= 400; i++) r = processSample(cfg.airTemp, rt2, sample(22, T0 + i * 1000));
    expect(r.status).toBe('suspect');
    expect(r.message).toMatch(/atascado/);
  });

  it('filtros: mediana elimina valores aislados; EMA suaviza', () => {
    const c = { ...cfg.waterTemp, filter: { kind: 'median' as const, window: 5, alpha: 0.2 }, spikeThreshold: 100 };
    const rt = createSensorRuntime(c, 0);
    let r = processSample(c, rt, sample(20, T0));
    for (const [i, v] of [20, 20, 25, 20].entries()) r = processSample(c, rt, sample(v + i * 0.001, T0 + (i + 1) * 1000));
    expect(r.value).toBeCloseTo(20, 1);
  });

  it('EC en mS/cm y µS/cm', () => {
    expect(ecToDisplay(1.413, 'µS/cm')).toBeCloseTo(1413);
    expect(ecFromDisplay(1413, 'µS/cm')).toBeCloseTo(1.413);
    expect(ecToDisplay(1.2, 'mS/cm')).toBe(1.2);
  });
});

describe('Modelo físico (partes validadas)', () => {
  it('Magnus: es(20 °C) ≈ 23,4 hPa; ida y vuelta HR ↔ humedad absoluta', () => {
    expect(saturationVaporPressure(20)).toBeCloseTo(23.37, 1);
    expect(rhFromAbs(absFromRh(60, 25), 25)).toBeCloseTo(60, 6);
  });

  it('una dosis se incorpora gradualmente (tiempo de mezcla)', () => {
    const e = new Engine();
    const ph0 = e.plant.state.ph;
    e.plant.addDose(e.config.liquids.phDown, 10);
    e.plant.step(1, e.t, e.config.liquids);
    const ph1 = e.plant.state.ph;
    for (let i = 0; i < 1200; i++) e.plant.step(1, e.t, e.config.liquids);
    const expected = (-2.5 * 10) / 100;
    expect(ph0 - ph1).toBeLessThan(Math.abs(expected) * 0.1);
    expect(e.plant.state.ph - ph0).toBeCloseTo(expected, 1);
  });

  it('la evaporación concentra la EC (masa de sales constante)', () => {
    const e = new Engine();
    const ec0 = e.plant.ec;
    e.plant.state.volumeL = 50;
    expect(e.plant.ec).toBeCloseTo(ec0 * 2, 6);
  });
});

describe('Temporizador de luces', () => {
  it('18/6 desde las 06:00 y ciclo que cruza medianoche', () => {
    const s = { onTime: '06:00', photoperiodH: 18 };
    const at = (h: number, m = 0) => Date.UTC(2026, 0, 1, h, m);
    expect(scheduleInfo(s, at(5, 59)).on).toBe(false);
    expect(scheduleInfo(s, at(6, 0)).on).toBe(true);
    expect(scheduleInfo(s, at(23, 59)).on).toBe(true);
    expect(scheduleInfo(s, at(0, 0)).on).toBe(false);
    const i = scheduleInfo(s, at(12));
    expect(i.offTime).toBe('00:00');
    expect(i.darkH).toBe(6);
    expect(i.minutesToNextChange).toBe(12 * 60);
    expect(scheduleInfo({ onTime: null, photoperiodH: 18 }, at(12)).configured).toBe(false);
    expect(photoperiodFromTimes('18:00', '06:00')).toBe(12);
  });
});

describe('Perfiles', () => {
  it('diferencias y validación', () => {
    const e = new Engine();
    loadScenario(e, 'demo');
    const d = diffProfiles(e.config.profiles.veg, e.config.profiles.flower);
    expect(d.map((x) => x.path)).toContain('lights.photoperiodH');
    expect(profileProblems(e.config.profiles.veg)).toEqual([]);
    const bad = structuredClone(e.config.profiles.veg);
    bad.reservoir.ph.alarmLow = 7;
    expect(profileProblems(bad).join()).toMatch(/pH/);
  });
});

describe('Protocolo y backends', () => {
  it('parseDevice valida estrictamente', () => {
    expect('error' in parseDevice('no json')).toBe(true);
    expect('error' in parseDevice('{"type":"hello","proto":99,"fw":"x"}')).toBe(true);
    const m = parseDevice(
      JSON.stringify({ type: 'telemetry', seq: 1, sensors: { ph: { raw: 6.1, ok: true }, ec: { raw: 'x', ok: true } }, outputs: { fan: true, bogus: true }, armed: true }),
    );
    expect('type' in m && m.type === 'telemetry').toBe(true);
    if ('type' in m && m.type === 'telemetry') {
      expect(m.sensors.ph).toEqual({ raw: 6.1, ok: true });
      expect(m.sensors.ec).toEqual({ raw: null, ok: false });
      expect(m.outputs).toEqual({ fan: true });
    }
    expect(JSON.parse(encodeHost({ type: 'heartbeat', seq: 3 }))).toEqual({ type: 'heartbeat', seq: 3 });
  });

  it('SHA-256 / HMAC-SHA256: vectores de prueba oficiales (FIPS 180-2, RFC 4231)', () => {
    const enc = (x: string) => new TextEncoder().encode(x);
    expect(toHex(sha256(enc('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(toHex(sha256(enc('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(sha256(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
    // RFC 4231, caso 2
    expect(toHex(hmacSha256(enc('Jefe'), enc('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
    // RFC 4231, caso 6 (clave > 64 bytes)
    expect(toHex(hmacSha256(new Uint8Array(131).fill(0xaa), enc('Test Using Larger Than Block-Size Key - Hash Key First')))).toBe(
      '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    );
  });

  it('Esp32WsBackend: autenticación desafío-respuesta, telemetría y órdenes con maxOnMs', () => {
    const sent: string[] = [];
    let tr!: Transport;
    const b = new Esp32WsBackend('ws://fake', 'token-secreto', () => {
      tr = { send: (d) => sent.push(d), close: () => {}, onopen: null, onmessage: null, onclose: null };
      return tr;
    });
    const last = () => JSON.parse(sent[sent.length - 1]);
    b.connect();
    tr.onopen?.();
    b.tick(1000);
    expect(JSON.parse(sent[0]).type).toBe('heartbeat');
    const nonce = '0123456789abcdef0123456789abcdef';
    tr.onmessage?.(JSON.stringify({ type: 'hello', proto: 2, fw: 'hydro 0.2', board: 'esp32', resetReason: 'POWERON', nonce, config: { hbTimeoutMs: 3000, pumpMaxMs: [1, 2, 3, 4, 5, 6, 7, 8] } }));
    const auth = last();
    expect(auth.type).toBe('auth');
    expect(auth.mac).toBe(authResponse('token-secreto', nonce));
    expect(JSON.stringify(sent)).not.toContain('token-secreto'); // el token nunca viaja
    expect(b.link().authenticated).toBe(false);

    // Sin autenticar no se envían órdenes
    const outputs = offOutputs();
    outputs.phUp = true;
    const n = sent.length;
    b.writeOutputs({ seq: 9, outputs, maxOnMs: { phUp: 4000 } });
    expect(sent.length).toBe(n);

    tr.onmessage?.(JSON.stringify({ type: 'ack', seq: auth.seq, ok: true }));
    expect(b.link().authenticated).toBe(true);
    expect(b.link().deviceConfig?.hbTimeoutMs).toBe(3000);
    tr.onmessage?.(JSON.stringify({ type: 'telemetry', seq: 1, uptimeMs: 5, sensors: { rh: { raw: 55, ok: true } }, outputs: {}, armed: false }));
    expect(b.link().lastHeartbeatAt).toBe(1000);
    expect(b.latestSensors()?.sensors.rh?.raw).toBe(55);
    b.writeOutputs({ seq: 9, outputs, maxOnMs: { phUp: 4000 } });
    expect(last()).toMatchObject({ type: 'outputs', seq: 9, maxOnMs: { phUp: 4000 } });

    b.sendConfig({ hbTimeoutMs: 4000 });
    const cfg = last();
    expect(cfg).toMatchObject({ type: 'config', hbTimeoutMs: 4000 });
    tr.onmessage?.(JSON.stringify({ type: 'ack', seq: cfg.seq, ok: false, error: 'armado' }));
    expect(b.lastConfigResult()).toEqual({ ok: false, error: 'armado' });

    tr.onmessage?.('garbage');
    expect(b.protocolErrors.length).toBe(1);
    // Versión antigua del firmware: rechazada
    tr.onmessage?.(JSON.stringify({ type: 'hello', proto: 1, fw: 'x', nonce }));
    expect(b.protocolErrors.length).toBe(2);
  });

  it('autenticación rechazada: el enlace no se considera sano y no se puede armar', () => {
    let tr!: Transport;
    const b = new Esp32WsBackend('ws://fake', 'malo', () => {
      tr = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null };
      return tr;
    });
    const e = new Engine({ hardware: b });
    e.setMode('hardware');
    tr.onopen?.();
    tr.onmessage?.(JSON.stringify({ type: 'hello', proto: 2, fw: 'x', board: 'b', resetReason: 'r', nonce: 'aaaaaaaaaaaaaaaa' }));
    tr.onmessage?.(JSON.stringify({ type: 'ack', seq: 2, ok: false, error: 'token incorrecto' }));
    tr.onmessage?.(JSON.stringify({ type: 'telemetry', seq: 1, uptimeMs: 5, sensors: {}, outputs: {}, armed: false }));
    e.advance(2);
    expect(b.link().authError).toBe('token incorrecto');
    expect(e.safeState).toBe(true);
    expect(e.arm('ARMAR', true).ok).toBe(false);
  });

  it('configuración remota: validación de límites y exigencia de desarmado', () => {
    const mock = new MockHardwareBackend(() => ({}));
    mock.connect();
    mock.sendConfig({ hbTimeoutMs: 500 });
    expect(mock.lastConfigResult()?.ok).toBe(false);
    mock.sendConfig({ pumpMaxMs: [1000, 2000] });
    expect(mock.lastConfigResult()?.ok).toBe(false);
    mock.sendConfig({ wifi: { ssid: 'red', pass: '123' } });
    expect(mock.lastConfigResult()?.ok).toBe(false);
    mock.sendConfig({ hbTimeoutMs: 5000, pumpMaxMs: [5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000] });
    expect(mock.lastConfigResult()?.ok).toBe(true);
    expect(mock.link().deviceConfig?.pumpMaxMs[0]).toBe(5000);
    mock.tick(0);
    mock.requestArm(true, 'ARMAR');
    mock.sendConfig({ hbTimeoutMs: 3000 });
    expect(mock.lastConfigResult()?.error).toMatch(/desarmado/);
    // El máximo del dispositivo limita la orden del host
    const o = offOutputs();
    o.solA = true;
    mock.writeOutputs({ seq: 1, outputs: o, maxOnMs: { solA: 60000 } });
    mock.tick(4000);
    expect(mock.reportedOutputs()?.solA).toBe(true);
    mock.writeOutputs({ seq: 2, outputs: o, maxOnMs: { solA: 60000 } });
    mock.tick(5100);
    expect(mock.reportedOutputs()?.solA).toBe(false);
  });

  it('OutputGate no envía nada fuera del modo hardware', () => {
    const mock = new MockHardwareBackend(() => ({}));
    mock.connect();
    const gate = new OutputGate(mock);
    const o = offOutputs();
    o.fan = true;
    expect(gate.send({ outputs: o, maxOnMs: {} }, { mode: 'simulation', armed: true, safeState: false, estop: false })).toBeNull();
    expect(mock.writes).toHaveLength(0);
    const f = gate.send({ outputs: o, maxOnMs: {} }, { mode: 'hardware', armed: false, safeState: false, estop: false });
    expect(f?.outputs.fan).toBe(false);
  });

  it('el hardware simulado aplica watchdog propio y corte por maxOnMs', () => {
    const mock = new MockHardwareBackend(() => ({}), 3000);
    mock.connect();
    mock.tick(0);
    mock.requestArm(true, 'ARMAR');
    const o = offOutputs();
    o.solA = true;
    o.fan = true;
    mock.writeOutputs({ seq: 1, outputs: o, maxOnMs: { solA: 2000 } });
    mock.tick(1000);
    expect(mock.reportedOutputs()?.solA).toBe(true);
    mock.tick(2500);
    expect(mock.reportedOutputs()?.solA).toBe(false);
    expect(mock.reportedOutputs()?.fan).toBe(true);
    mock.tick(4000); // sin órdenes > 3 s
    expect(mock.reportedOutputs()?.fan).toBe(false);
    expect(mock.link().deviceArmed).toBe(false);
  });

  it('el armado del hardware simulado exige el token exacto', () => {
    const mock = new MockHardwareBackend(() => ({}));
    mock.connect();
    mock.requestArm(true, 'armar');
    expect(mock.link().deviceArmed).toBe(false);
  });
});

describe('Exportación, modo hardware simulado y comparación', () => {
  it('exportar / importar configuración', () => {
    const e = new Engine();
    loadScenario(e, 'demo');
    const back = importConfigJson(exportConfigJson(e.config));
    expect(back.profiles.veg.reservoir.ph.target).toBe(5.8);
    expect(() => importConfigJson('{"foo":1}')).toThrow();
  });

  it('modo hardware con backend simulado: lee sensores y acciona tras armar', () => {
    const e = new Engine({ seed: 4 });
    loadScenario(e, 'demo');
    e.setAutomation(false);
    e.setMode('hardware');
    e.advance(3);
    expect(e.sensors.rh.reading.source).toBe('hardware');
    expect(e.sensors.rh.reading.status).toBe('ok');
    e.setRelay('fan', 'manual', true);
    e.advance(2);
    expect(e.hardware.reportedOutputs()?.fan).toBe(false); // sin armar
    expect(e.arm('ARMAR', true).ok).toBe(true);
    e.advance(2);
    expect(e.hardware.reportedOutputs()?.fan).toBe(true);
    e.setMode('simulation');
    expect(e.hardware.reportedOutputs()?.fan).toBe(false);
  });

  it('comparación con/sin automatización produce resultados distintos', () => {
    const r = runComparison('ph_drift', 2);
    expect(r.on.summary.doses).toBeGreaterThan(0);
    expect(r.off.summary.doses).toBe(0);
    expect((r.on.summary.timeInBand.ph ?? 0)).toBeGreaterThan(r.off.summary.timeInBand.ph ?? 0);
  });
});

describe('Calibración de caudal de bombas', () => {
  it('mide el caudal real a probeta, lo aplica y la segunda prueba coincide', () => {
    const e = new Engine({ seed: 2 });
    expect(e.runFlowTest('solA', 100).ok).toBe(false); // > tiempo máximo (60 s)
    expect(e.runFlowTest('solA', 60).ok).toBe(true);
    e.advance(61);
    const rt = e.pumps.solA;
    expect(rt.lastCalibrationS).toBe(60);
    const measured = rt.lastCalibrationMl as number;
    expect(measured).toBeCloseTo(50 * 1.08, 1); // caudal real simulado distinto del nominal
    expect(rt.totalDosedMl).toBe(0); // no entra al depósito ni cuenta como dosis
    expect(rt.primed).toBe(true); // la prueba deja la línea cebada
    expect(e.applyFlowCalibration('solA', measured, 60).ok).toBe(true);
    expect(e.config.pumps.solA.flowMlPerMin).toBeCloseTo(54, 1);
    e.runFlowTest('solA', 30);
    e.advance(31);
    expect(e.pumps.solA.lastCalibrationMl as number).toBeCloseTo(27, 1);
    // Medición absurda: rechazada
    expect(e.applyFlowCalibration('solA', 500, 60).ok).toBe(false);
  });
});

