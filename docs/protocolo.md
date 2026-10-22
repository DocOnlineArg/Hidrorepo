# Protocolo ESP32 ⇄ dashboard (v2)

Transporte: WebSocket (servidor en la ESP32, puerto 81), un objeto JSON por mensaje.
Implementaciones: `src/hal/protocol.ts` (validación estricta) y `firmware/esp32/src/main.cpp`.

## Autenticación (desafío-respuesta)

1. En su primer arranque la ESP32 genera un **token de emparejamiento** aleatorio de 20 caracteres,
   lo guarda en NVS (`auth_token`) y lo imprime por el puerto serie en cada arranque
   (`Token de emparejamiento: ...`). Quien tiene acceso físico al USB puede leerlo.
2. Al conectar, el dispositivo envía `hello` con un `nonce` aleatorio de 128 bits (de un solo uso).
3. El dashboard responde `{"type":"auth","seq":n,"mac": hex(HMAC-SHA256(token, nonce))}`.
   **El token nunca viaja por la red.**
4. El dispositivo compara en tiempo constante y responde `ack`. Hasta autenticarse, el cliente no
   puede enviar heartbeats, órdenes, armado ni configuración (se responde `no autenticado`).

El dashboard no persiste el token. Para regenerarlo, borrar la clave NVS `auth_token`
(p. ej. `pio run -t erase` y volver a cargar el firmware).

Limitación: el canal no está cifrado (ws://). La autenticación impide que un tercero en la red
dé órdenes sin el token, pero no protege frente a un atacante que intercepte y modifique la sesión
ya abierta. Use una red aislada para la instalación.

## Dispositivo → host

```json
{"type":"hello","proto":2,"fw":"hydro-esp32 0.2.0","board":"esp32-wroom-32e","resetReason":"POWERON boot#12",
 "nonce":"9f2c…(32 hex)","config":{"hbTimeoutMs":3000,"pumpMaxMs":[60000,60000,30000,60000,60000,60000,60000,60000]}}
```

`proto` distinto de 2 se rechaza en el dashboard (versiones de firmware y dashboard deben coincidir).

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
{"type":"auth","seq":1000,"mac":"<64 hex>"}
{"type":"heartbeat","seq":1001}
{"type":"arm","seq":1002,"armed":true,"token":"ARMAR"}
{"type":"outputs","seq":1003,
 "outputs":{"phUp":false,"phDown":true, "...":false},
 "maxOnMs":{"phDown":4100}}
```

- `config` (solo desarmado; validado y guardado en NVS):
  `{"type":"config","seq":1004,"hbTimeoutMs":3000,"pumpMaxMs":[…8 valores…],"wifi":{"ssid":"…","pass":"…"}}`
  con heartbeat 1000–10000 ms, cada bomba 1000–300000 ms, SSID 1–32 y clave vacía u 8–63
  caracteres. Si algo es inválido no se guarda nada. El Wi-Fi se aplica al reiniciar.
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

## Seguridad de red

- v2 autentica clientes (HMAC-SHA256 con desafío). Pendiente: cifrado (wss/TLS) o un puente local
  si el dispositivo debe estar en una red compartida.
- Nunca exponer el puerto 81 a Internet.
