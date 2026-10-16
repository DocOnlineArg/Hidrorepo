# HidroTwin · Simulador de automatización hidropónica con ESP32

Gemelo digital para diseñar, probar y validar la automatización de una instalación
hidropónica **antes** de comprar o conectar componentes. No es solo un dashboard: hay un
motor de simulación con estado, variables interdependientes, sensores con fallos,
bombas con recipientes, control con tiempos de mezcla y estabilización, interbloqueos,
alarmas, perfiles y una capa de hardware desacoplada preparada para una ESP32 real.

> **Aviso.** Los modelos físicos y químicos son aproximaciones (ver
> [docs/arquitectura.md](docs/arquitectura.md#qué-es-validado-y-qué-es-aproximado)).
> Los perfiles empiezan **sin objetivos**: el sistema no inventa valores agronómicos ni dosis.
> El escenario "Demostración" carga valores de **ejemplo** marcados como tales.

## Requisitos

- Node.js ≥ 18 (probado con 22) y npm.
- Para las pruebas del firmware en el host: `g++` con C++17.
- Para compilar/subir el firmware: [PlatformIO](https://platformio.org/) (`pip install platformio`).

## Instalación y ejecución

```bash
npm install
npm run dev          # http://localhost:5173 (dashboard + simulador en el navegador)
npm test             # 44 pruebas del núcleo (Vitest)
npm run test:firmware  # pruebas nativas de la capa de seguridad del firmware (g++)
npm run build        # typecheck + build de producción en dist/
npm run preview      # sirve dist/
```

Primeros pasos en la interfaz:

1. Al abrir, la instalación está **sin configurar** (sondas sin calibrar, bombas sin cebar,
   perfiles vacíos): la automatización no actúa. Es intencionado.
2. Para ver la lógica completa: *Laboratorio → Escenarios → Demostración → Cargar y ejecutar*,
   y suba la velocidad (60×–3600×).
3. Para configurar su instalación: calibre las sondas (*Sensores*), cebe las bombas
   (*Dosificación*), introduzca y valide un perfil (*Perfiles*) y configure las estimaciones
   del controlador (*Automatización → Parámetros del controlador*).

La configuración se guarda automáticamente en el navegador y puede exportarse/importarse en JSON
(*Configuración*). Al recargar, la app vuelve siempre a modo simulación y con salidas desarmadas.

## Estructura

```
src/core/            Núcleo puro TypeScript (sin UI ni hardware)
  types.ts           Modelo de datos
  config.ts          Configuración por defecto (sin objetivos agronómicos)
  physics/plant.ts   Modelo físico aproximado (clima, agua, química)
  sensors/sensor.ts  Pipeline: driver → calibración → validación → filtro
  actuators/pumps.ts Bombas, recipientes, corte por tiempo máximo
  safety/safety.ts   Compatibilidad química, interbloqueos, subsistema oxidante
  control/           Controlador químico (pH/EC/ORP), clima con histéresis, temporizador de luces
  alarms.ts history.ts profiles.ts persistence.ts scenarios.ts compare.ts
  engine.ts          Orquestador (paso de simulación, modos, estado seguro, salidas)
src/hal/             Capa de hardware: interfaz, compuerta de salidas, hardware simulado,
                     backend ESP32 por WebSocket, protocolo v1, mapa de pines
src/ui/              Dashboard React (10 vistas, responsive, modo claro/oscuro)
tests/               Pruebas Vitest (requisitos de seguridad + módulos)
firmware/esp32/      Firmware PlatformIO (Arduino) + pruebas nativas de seguridad
docs/                Arquitectura, protocolo, hardware/migración, esquema y componentes
```

## Documentación

- [Arquitectura, modelo de datos e interfaces](docs/arquitectura.md)
- [Protocolo ESP32 ⇄ dashboard](docs/protocolo.md)
- [Hardware: componentes, esquema de conexiones y migración del simulador al hardware real](docs/hardware.md)
- [Estado del proyecto: qué funciona, qué está simulado y qué requiere validación física](docs/estado.md)
