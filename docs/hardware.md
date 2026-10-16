# Hardware: componentes, esquema de conexiones y migración

> Nada de este documento sustituye la revisión de un electricista matriculado ni las hojas de
> datos vigentes de cada fabricante. Los modelos citados se verificaron en sus fichas públicas
> (ver "Fuentes"); confirme siempre la revisión exacta que compre.

## 1. Placa seleccionada

**ESP32-DevKitC V4 con módulo ESP32-WROOM-32E** (Arduino framework vía PlatformIO, o ESP-IDF).

Criterios: soporte maduro en Arduino-ESP32 y ESP-IDF, Wi-Fi para el dashboard, suficientes GPIO.
Limitaciones que condicionan el diseño:

- El ADC del ESP32 es poco lineal y el ADC2 no se puede usar con Wi-Fi activo → **no se usan
  entradas analógicas para pH/EC/ORP**; se usan circuitos de medida digitales aislados.
- GPIO 6–11 reservados para la flash; 34–39 solo entrada y sin pull-up interno.
- Pines de *strapping* (0, 2, 5, 12, 15) condicionan el arranque. GPIO12 debe estar en BAJO al
  arrancar (con flash de 3,3 V) y GPIO2/0 influyen en el modo de descarga; 5, 14 y 15 pueden
  emitir señales durante el arranque. Por eso 2 y 12 se usan solo como salidas con **pull-down
  externo** (nivel bajo = arranque normal = salida apagada) y 15 como bus 1-Wire con pull-up.

## 2. Lista de componentes compatibles

| Función | Componente propuesto | Interfaz eléctrica | Biblioteca / soporte | Notas |
|---|---|---|---|---|
| pH | Atlas Scientific **EZO-pH** + sonda pH | UART o I²C, 3,3–5 V; I²C por defecto 0x63 | Protocolo ASCII simple (driver propio en `sensors.cpp`) | Sale de fábrica en **modo UART**: pasar a I²C (`I2C,99`). Requiere pull-ups en SDA/SCL. |
| EC | Atlas **EZO-EC** + sonda K 1.0 | Ídem; I²C 0x64 | Ídem | Entrega µS/cm; el firmware convierte a mS/cm. Compensación de temperatura con `RT,<t>`. |
| ORP | Atlas **EZO-ORP** + sonda ORP | Ídem; I²C 0x62 | Ídem | |
| Aislamiento | Atlas **Electrically Isolated EZO Carrier Board (Gen 2)** ×3 | Entrada 3,0–5,0 V; UART/I²C; SMA | — | Imprescindible con varias sondas en la misma solución (bucles de masa, interferencia EC↔pH). |
| Temp./HR aire | Sensirion **SHT4x** (p. ej. SHT40/SHT45 en placa breakout) | I²C 0x44, 3,3 V | Driver propio (comando 0xFD + CRC) | Montar fuera de la luz directa y con protección contra condensación. |
| Temp. agua | **DS18B20** sumergible | 1-Wire, 3,0–5,5 V, pull-up 4,7 kΩ | OneWire + DallasTemperature (modo asíncrono) | Rechazar 85 °C (valor de reset). |
| Bombas | Bombas peristálticas **12 V DC** (×8) | Carga inductiva | — | Medir la corriente real (típ. 0,2–0,5 A) antes de dimensionar fuente y MOSFET. |
| Drivers bombas | MOSFET canal N de **nivel lógico a 3,3 V** (p. ej. AO3400A / IRLML6344) + diodo de rueda libre (SS14/1N5819) + 100 Ω serie + 10 kΩ pull-down | GPIO 3,3 V → puerta | — | Comprobar R<sub>DS(on)</sub> especificada a V<sub>GS</sub> = 2,5 V. Evitar IRLZ44N (especificado a 4–5 V). Alternativa: ULN2803A (≤500 mA/canal, con límite térmico total). |
| Rail de bombas | Relé o MOSFET de lado alto en el rail de 12 V (`PUMP_RAIL_EN`) en serie con el E-STOP | — | — | Segundo elemento de corte independiente del GPIO de cada bomba. |
| Habilitación oxidante | Relé independiente en serie con la bomba 3 (`OX_EN`) | — | — | Dos órdenes distintas para que el oxidante funcione. |
| Cargas de red (120 V) | **Digital Loggers IoT Power Relay II** | Entrada aislada 3,3–48 V DC (polaridad), ~2–3 mA | GPIO directo | Producto con enchufes NEMA (Norteamérica). Mantener 3,3 V estables (por debajo de ~2,9 V puede no retener). |
| Cargas de red (220–230 V) | Relé de interfaz optoacoplado en carril DIN → **contactor** con categoría adecuada (AC-3 para compresores/motores) en envolvente certificada | Bobina vía transistor/opto | — | Instalación por electricista: diferencial 30 mA, magnetotérmicos, puesta a tierra. Los SSR tienen fuga y no son aislamiento seguro. |
| E-STOP | Pulsador de seta NC con enclavamiento | Corta rail de bombas + cargas; contacto auxiliar a GPIO34 | — | Lazo normalmente cerrado: un cable roto equivale a E-STOP. |
| Alimentación | Fuente 12 V (bombas) + regulador 5 V/3,3 V; o fuente 5 V para la DevKit | — | — | Masas separadas por los carriers aislados; desacoplos cerca de cada EZO. |

## 3. Esquema de conexiones propuesto

```
                         +3V3 ──┬──4k7──┬──4k7──┐
                                │       │       │
  ESP32-DevKitC V4             SDA     SCL     1-Wire
  ┌────────────────────┐        │       │       │
  │ GPIO21 (SDA) ───────────────┴───────┼───────┼──▶ EZO-pH (0x63) ─┐ carriers aislados Gen 2
  │ GPIO22 (SCL) ───────────────────────┴───────┼──▶ EZO-EC (0x64) ─┤ (lado lógico 3,3 V)
  │                    │                        │    EZO-ORP(0x62) ─┤
  │                    │                        │    SHT4x  (0x44) ─┘
  │ GPIO15 (1-Wire) ────────────────────────────┴──▶ DS18B20 (agua)
  │                    │
  │ GPIO16..19,23,25..27 ──100Ω──▶ puerta MOSFET Pn ──┐      +12V_RAIL
  │                    │          10k a GND           │         │
  │                    │                              │   ┌─────┴─────┐
  │                    │                              │   │ Bomba n   │◀─ diodo rueda libre
  │                    │                              └──▶│ (−)       │   en paralelo
  │                    │                                  └───────────┘
  │ GPIO13 PUMP_RAIL_EN ─▶ driver relé/MOSFET lado alto ─▶ +12V ──[E-STOP NC]──▶ +12V_RAIL
  │ GPIO12 OX_EN (10k↓) ─▶ relé en serie con Bomba 3 (oxidante)
  │                    │
  │ GPIO32 HUMIDIFIER ──▶ entrada aislada relé/contactor ─▶ Humidificador (red)
  │ GPIO33 DEHUMIDIFIER ▶ entrada aislada relé/contactor ─▶ Deshumidificador (red)
  │ GPIO4  FAN ─────────▶ entrada aislada relé/contactor ─▶ Ventilador (red)
  │ GPIO2  LIGHTS (10k↓)▶ entrada aislada relé/contactor ─▶ Luces (red)
  │                    │
  │ GPIO34 ESTOP_SENSE ◀── contacto auxiliar NC del E-STOP (pull-up 10k a 3V3)
  │ GPIO35 RAIL_SENSE  ◀── divisor 12V→3V3 (p. ej. 30k/10k) + TVS
  │ GPIO36 LEVEL       ◀── interruptor de nivel del depósito (opcional)
  └────────────────────┘
```

Tabla de pines completa: `src/hal/pinmap.ts` y `firmware/esp32/include/pins.h` (deben coincidir).

Reglas eléctricas obligatorias:

1. **Ninguna sonda analógica directa a un GPIO.** pH/ORP son señales de alta impedancia en
   mV y EC requiere excitación AC: se usan circuitos EZO aislados.
2. **Ningún GPIO acciona cargas.** Bombas con MOSFET + diodo; cargas de red con relés/contactores
   aislados y certificados.
3. **Estado seguro al reiniciar:** todas las salidas activas en ALTO con pull-down externo; el
   firmware escribe BAJO antes de configurar los pines; el rail de bombas y `OX_EN` añaden un
   segundo corte.
4. E-STOP cableado en serie con la energía, no solo leído por software.
5. Verificar con multímetro el nivel de cada salida durante reset, arranque y carga de firmware.

## 4. Migración del simulador al hardware real

El dashboard no cambia: solo se sustituye el backend (`HardwareBackend`) y los sensores pasan a
leer telemetría real por el mismo pipeline (calibración, validación, filtro).

1. **Banco sin cargas.** Monte ESP32 + EZO + SHT4x + DS18B20 sin bombas ni red. Pase cada EZO a
   I²C. Compile y cargue: `cd firmware/esp32 && pio run -t upload`. Configure Wi-Fi en NVS
   (`wifi_ssid`, `wifi_pass`) o use el AP `HidroTwin` (cambie `ap_pass`).
2. **Pruebas nativas** de la capa de seguridad: `npm run test:firmware`.
3. **Hardware simulado primero.** En el dashboard: *Hardware → Hardware simulado → Entrar en modo
   hardware*. Recorra armado, E-STOP, pérdida de enlace (*Laboratorio*) y verifique que todo
   se apaga.
4. **Conectar la ESP32 real.** *Hardware → URL `ws://<ip>:81/` → ESP32 real*. Las salidas siguen
   desarmadas. Compruebe que llegan lecturas (`source = HARDWARE`) y que un sensor desconectado
   se detecta.
5. **Calibración real** con soluciones patrón (pH 7/4, EC 1413 µS/cm, ORP 225 mV). Recomendado:
   calibrar en el propio EZO (con compensación de temperatura) y repetir la calibración del
   dashboard como verificación (debe salir ganancia ≈ 1, offset ≈ 0).
6. **Salidas con cargas ficticias** (LED/lámpara de 12 V) y luego bombas con **agua**. Mida el
   caudal real de cada bomba (mL en 60 s) y configúrelo. Complete la lista de verificación y arme.
7. **Identificar los modelos de respuesta**: con agua y producto real, dosis pequeñas y medición
   tras mezcla; introduzca las estimaciones del controlador (*Automatización*) y, si quiere
   reproducirlo en la simulación, el modelo del líquido (*Configuración*).
8. **Perfiles**: introduzca y valide sus objetivos. Empiece con la automatización de un solo lazo
   y supervisión presencial.
9. **Oxidante al final**, solo tras validar compatibilidad, límites, separación y un método de
   verificación independiente.

## 5. Recuperación, persistencia y registro en la ESP32

- NVS (`Preferences`, espacio `hydro`): contador de arranques, motivo del último reinicio,
  contador de errores, timeout de heartbeat, máximos duros por bomba, credenciales Wi-Fi.
- Tras cualquier reinicio (watchdog, brown-out, pánico) el firmware arranca **desarmado** y con
  todo apagado; el dashboard también vuelve a modo simulación al recargarse.
- Registro de errores: buffer circular en RAM (últimos 16) + contador en NVS + fallos en la telemetría.

## Fuentes consultadas

- [Atlas Scientific – EZO-pH Circuit](https://atlas-scientific.com/circuits/ezo-ph-circuit/) y [hoja de datos EZO-pH](https://cdn.sparkfun.com/assets/b/8/a/1/2/pH_EZO_datasheet.pdf)
- [Atlas Scientific – Electrically Isolated EZO Carrier Board Gen 2](https://atlas-scientific.com/carrier-boards/electrically-isolated-ezo-carrier-board-gen-2/)
- [Digital Loggers – IoT Relay II spec](https://www.digital-loggers.com/iot2spec.pdf) y [FAQ](https://www.digital-loggers.com/iot2faqs.html)
- [SunFounder – ESP32-WROOM-32E (strapping pins)](https://docs.sunfounder.com/projects/umsk/de/latest/07_appendix/esp32_wroom_32e.html)
