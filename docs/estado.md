# Estado del proyecto (v0.2.0)

## Qué funciona realmente

- **Motor de simulación** determinista con paso de 1 s: pausa/reanudación, +1 s/+1 min/+10 min/+1 h,
  velocidades 1×–3600×, reinicio, 10 escenarios, perturbaciones e inyección de fallos.
- **Sensores** (6) con pipeline completo: error de sonda, calibración simulada de 1–2 puntos con
  validación de pendiente y caducidad, rango, picos, lectura atascada, datos antiguos, filtros
  (EMA, media móvil, mediana), lectura manual marcada como tal, EC en mS/cm y µS/cm.
- **8 bombas** con caudal, duración, volumen, contadores, recipiente y nivel, cebado, intervalo
  mínimo, tiempo máximo con corte duro, vacío con alarma y bloqueo, prueba individual, cebado,
  accionamiento mantenido, bloqueo/desbloqueo.
- **Seguridad química**: matriz de compatibilidad (desconocido = bloqueado), una bomba a la vez por
  defecto, subsistema independiente del oxidante, bloqueo de dosificación automática ante sensores
  no válidos o sin calibrar.
- **Control pH/EC/ORP** con confirmación, mezcla, estabilización, re-medición, límite de
  correcciones, detección de falta de respuesta y registro de decisiones justificadas.
- **Clima y luces** con histéresis, tiempos mínimos, interbloqueo, estados de fallo de sensor,
  protección térmica y temporizador persistente (18/6 fijo).
- **Perfiles** vegetativo/floración independientes, sin valores por defecto, validación, diff y
  cambio sin perder historial.
- **Alarmas** con fecha, causa, acción, normalización con histéresis, reconocimiento y exportación CSV.
- **Persistencia** en el navegador, exportación/importación JSON, recuperación siempre en modo seguro.
- **Capa de hardware**: compuerta de salidas, hardware simulado (enlace, armado, watchdog, corte
  local), backend WebSocket para ESP32 y protocolo v1 con validación estricta.
- **Dashboard** responsive (escritorio y móvil, verificado con Chromium a 1400 px y 390 px sin
  desbordamiento horizontal ni errores de consola), modo claro/oscuro.
- **Autenticación** desafío-respuesta HMAC-SHA256 con token de emparejamiento (el token no viaja).
- **Configuración remota** del firmware (timeout de heartbeat, máximos duros por bomba, Wi-Fi),
  validada en el dispositivo y solo con salidas desarmadas.
- **Asistente de calibración de caudal** (prueba a probeta; en simulación cada bomba tiene un caudal
  real distinto del nominal, como ocurre con peristálticas reales).
- **Firmware**: capa de seguridad portable (`OutputSafety`) probada en host; `main.cpp` con
  arranque seguro, watchdog, NVS, Wi-Fi STA/AP, WebSocket, drivers EZO/SHT4x/DS18B20 no bloqueantes.

## Qué está simulado (no medido)

- Todos los valores de sensores en modo simulación (etiqueta SIMULADO; línea "Modelo (interno)").
- Los efectos químicos de cada líquido (lineales, **no validados**), las derivas y la mezcla.
- El clima de la sala (un nodo térmico, aire perfectamente mezclado).
- Los niveles de los recipientes (calculados a partir del caudal configurado; no hay sensor).
- La "verificación independiente" del oxidante es una declaración del usuario.
- Los valores del escenario Demostración son ejemplos, no recomendaciones agronómicas.

## Pruebas

| Conjunto | Resultado |
|---|---|
| `npm test` (Vitest): 12 requisitos de la sección 11 (25 casos) + módulos (23 casos) | **48/48 OK** |
| `npm run test:firmware` (g++ C++17, -Wall -Wextra -Werror) | **62/62 comprobaciones OK** |
| `npm run build` (typecheck estricto + Vite) | OK |
| Compilación del firmware para ESP32 (`pio run`, en GitHub Actions) | OK (v0.1: RAM 14 %, flash 62 %) |

Todo lo anterior se ejecuta automáticamente en GitHub Actions en cada push (`.github/workflows/ci.yml`).

Correspondencia con los requisitos: ver `tests/requirements.test.ts` (un `describe` por requisito).

## Requiere validación física antes de operar equipos reales

1. Compilar y cargar el firmware; revisar avisos del compilador en la versión real de Arduino-ESP32.
2. Medir niveles de todas las salidas durante reset, arranque, carga de firmware y reinicio por watchdog.
3. Probar E-STOP, corte de rail de bombas y `OX_EN` con cargas ficticias.
4. Verificar el aislamiento de las sondas en la solución real (sin interferencia pH↔EC).
5. Calibrar con soluciones patrón y comprobar la deriva y caducidad reales.
6. Medir el caudal real de cada bomba y su variación con la viscosidad de cada producto.
7. Identificar el efecto real de cada producto y la capacidad tampón de la solución antes de
   activar la dosificación automática; empezar con correcciones pequeñas y supervisadas.
8. Confirmar la compatibilidad química con documentación del fabricante; el oxidante solo con un
   método de verificación independiente (el ORP no basta).
9. Instalación eléctrica de red realizada y certificada por un profesional (diferencial,
   protecciones, envolvente, puesta a tierra).
10. La autenticación HMAC ya está implementada, pero el canal no está cifrado: mantenga la ESP32
    en una red aislada.
11. Ajustar los parámetros de clima (tiempos mínimos del compresor del deshumidificador, etc.) a
    las especificaciones de cada equipo.
