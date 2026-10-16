# Protocolo ESP32 ⇄ dashboard (v1)

Transporte: WebSocket (servidor en la ESP32, puerto 81), un objeto JSON por mensaje.
Implementaciones: `src/hal/protocol.ts` (validación estricta) y `firmware/esp32/src/main.cpp`.

## Dispositivo → host

```json
{"type":"hello","proto":1,"fw":"hydro-esp32 0.1.0","board":"esp32-wroom-32e","resetReason":"POWERON boot#12"}
```

Cada 1 s:

```json
{
  "type": "telemetry", "seq": 812, "uptimeMs": 812345,
  "sensors": {
    "ph": {"raw": 5.91, "ok": true}, "ec": {"raw": 1.21, "ok": true}, "orp": {"raw": 248, "ok": true},
    "airTemp": {"raw": 24.8, "ok": true}, "rh": {"raw": 61.2, "ok": true}, "waterTemp": {"raw": null, "ok": false}
  },
  "outputs": {"phUp": false, "phDown": true, "oxidant": false, "solA": false, "solB": false, "bloom": false,
              "silicon": false, "pk": false, "humidifier": false, "dehumidifier": false, "fan": true, "lights": true},
  "armed": true, "estop": false,
  "faults": ["pump_maxon"]
}
```

- `raw` en unidades de ingeniería del circuito (EC en **mS/cm**; el firmware convierte desde µS/cm).
- `ok:false` o `raw:null` → el dashboard marca el sensor como desconectado. Sin telemetría
  durante `staleAfterS` → `stale`. Sin telemetría durante `commTimeoutS` → estado seguro.
- `outputs` es el estado **real** de los GPIO tras las protecciones del firmware.

```json
{"type":"ack","seq":17,"ok":false,"error":"armado rechazado"}
```

## Host → dispositivo

```json
{"type":"heartbeat","seq":1001}
{"type":"arm","seq":1002,"armed":true,"token":"ARMAR"}
{"type":"outputs","seq":1003,
 "outputs":{"phUp":false,"phDown":true, "...":false},
 "maxOnMs":{"phDown":4100}}
```

- El host envía `heartbeat` cada 1 s y una trama `outputs` en cada paso.
- Cada bomba encendida lleva su `maxOnMs`; sin él el firmware no la arranca. El firmware lo
  limita además a su máximo duro (NVS `pmax0..7`).
- Si la bomba se corta por tiempo, queda **enclavada** hasta recibir una orden OFF para ella
  (evita rearranques por tramas repetidas).

## Reglas que el firmware aplica siempre (`OutputSafety`)

| Regla | Comportamiento |
|-------|----------------|
| Arranque / reinicio | Todos los GPIO a BAJO antes de cualquier otra cosa; desarmado |
| Armado | Token exacto `ARMAR`, heartbeat reciente, sin E-STOP |
| Heartbeat | Sin heartbeat/orden durante `hb_timeout` (3 s) → todo apagado y desarmado |
| Bombas | Una a la vez (configurable); tiempo máximo con enclavamiento |
| Oxidante | Nunca con otra bomba (aunque se permita simultaneidad); `OX_EN` independiente |
| Clima | Humidificador y deshumidificador nunca simultáneos |
| E-STOP | Entrada de lazo cerrado; abierto → todo apagado, desarmado, rearme manual |
| Watchdog | Task WDT 5 s con reinicio; tras el reinicio, estado seguro |

## Seguridad de red (pendiente)

La v1 no autentica clientes: use una red aislada (AP propio o VLAN). Antes de exponerlo,
añadir un token compartido en `hello`/`arm` y TLS (wss) o un puente local.
