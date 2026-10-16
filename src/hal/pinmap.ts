/**
 * Asignación de pines PROPUESTA para ESP32-WROOM-32E (DevKitC V4).
 * Debe coincidir con firmware/esp32/include/pins.h. Criterios:
 *  - Se evitan GPIO 6–11 (flash), 34–39 solo como entradas.
 *  - Se evitan para salidas los pines que emiten señal en el arranque (1, 3, 5, 14, 15).
 *  - Los strapping (2, 12) solo se usan con pull-down externo (nivel bajo = arranque normal).
 *  - Todas las salidas son activas en ALTO con pull-down externo: en reset quedan apagadas.
 */
export interface PinAssignment {
  gpio: number;
  signal: string;
  direction: 'out' | 'in' | 'bus';
  notes: string;
}

export const PIN_MAP: PinAssignment[] = [
  { gpio: 16, signal: 'PUMP_1 pH+', direction: 'out', notes: 'Puerta MOSFET canal N, 10 kΩ pull-down' },
  { gpio: 17, signal: 'PUMP_2 pH−', direction: 'out', notes: 'Ídem' },
  { gpio: 18, signal: 'PUMP_3 Desinfectante', direction: 'out', notes: 'Ídem; además requiere relé de habilitación independiente (OX_EN)' },
  { gpio: 19, signal: 'PUMP_4 Solución A', direction: 'out', notes: 'Ídem' },
  { gpio: 23, signal: 'PUMP_5 Solución B', direction: 'out', notes: 'Ídem' },
  { gpio: 25, signal: 'PUMP_6 Bloom', direction: 'out', notes: 'Ídem' },
  { gpio: 26, signal: 'PUMP_7 Silicio', direction: 'out', notes: 'Ídem' },
  { gpio: 27, signal: 'PUMP_8 PK', direction: 'out', notes: 'Ídem' },
  { gpio: 13, signal: 'PUMP_RAIL_EN', direction: 'out', notes: 'Habilita el rail de 12 V de bombas (relé/MOSFET en serie con E-STOP)' },
  { gpio: 32, signal: 'HUMIDIFIER', direction: 'out', notes: 'Entrada de módulo de relé/SSR aislado o relé IoT certificado' },
  { gpio: 33, signal: 'DEHUMIDIFIER', direction: 'out', notes: 'Ídem' },
  { gpio: 4, signal: 'FAN', direction: 'out', notes: 'Ídem' },
  { gpio: 2, signal: 'LIGHTS', direction: 'out', notes: 'Strapping: pull-down 10 kΩ obligatorio; nivel bajo en arranque' },
  { gpio: 12, signal: 'OX_EN', direction: 'out', notes: 'Strapping (MTDI): pull-down 10 kΩ obligatorio; habilitación independiente del oxidante' },
  { gpio: 21, signal: 'I2C SDA', direction: 'bus', notes: 'EZO-pH 0x63, EZO-EC 0x64, EZO-ORP 0x62, SHT4x/SHT3x 0x44; pull-ups 4,7 kΩ a 3,3 V' },
  { gpio: 22, signal: 'I2C SCL', direction: 'bus', notes: 'Ídem' },
  { gpio: 15, signal: '1-Wire DS18B20', direction: 'bus', notes: 'Pull-up 4,7 kΩ a 3,3 V (compatible con el nivel alto de strapping)' },
  { gpio: 34, signal: 'ESTOP_SENSE', direction: 'in', notes: 'Solo entrada; pull-up externo; abierto = E-STOP' },
  { gpio: 35, signal: 'PUMP_RAIL_SENSE', direction: 'in', notes: 'Solo entrada; divisor desde 12 V para verificar el rail' },
  { gpio: 36, signal: 'LEVEL_RESERVOIR', direction: 'in', notes: 'Solo entrada; interruptor de nivel del depósito (opcional)' },
];
