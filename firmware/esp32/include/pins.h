// Asignación de pines PROPUESTA (ESP32-WROOM-32E / DevKitC V4).
// Debe coincidir con src/hal/pinmap.ts. Todas las salidas son activas en ALTO
// con resistencia pull-down externa de 10 kΩ: en reset/arranque quedan apagadas.
#pragma once
#include <stdint.h>

namespace pins {
// Bombas dosificadoras (puerta de MOSFET de canal N de nivel lógico).
constexpr uint8_t PUMP[8] = {16, 17, 18, 19, 23, 25, 26, 27};
constexpr uint8_t PUMP_RAIL_EN = 13;  // relé/MOSFET del rail de 12 V (en serie con E-STOP)
constexpr uint8_t OX_EN = 12;         // habilitación independiente del oxidante (strapping: pull-down obligatorio)
// Clima e iluminación (entrada de módulos de relé/SSR aislados o relé IoT certificado).
constexpr uint8_t HUMIDIFIER = 32;
constexpr uint8_t DEHUMIDIFIER = 33;
constexpr uint8_t FAN = 4;
constexpr uint8_t LIGHTS = 2;  // strapping: pull-down obligatorio
// Buses.
constexpr uint8_t I2C_SDA = 21;
constexpr uint8_t I2C_SCL = 22;
constexpr uint8_t ONEWIRE = 15;  // DS18B20, pull-up 4,7 kΩ
// Entradas (solo entrada, sin pull-up interno: resistencia externa).
constexpr uint8_t ESTOP_SENSE = 34;      // ALTO = circuito cerrado (normal); BAJO/abierto = E-STOP
constexpr uint8_t PUMP_RAIL_SENSE = 35;  // divisor desde 12 V
constexpr uint8_t LEVEL_RESERVOIR = 36;
}  // namespace pins

// Direcciones I2C por defecto (Atlas Scientific EZO y Sensirion SHT4x).
namespace i2caddr {
constexpr uint8_t EZO_ORP = 0x62;
constexpr uint8_t EZO_PH = 0x63;
constexpr uint8_t EZO_EC = 0x64;
constexpr uint8_t SHT4X = 0x44;
}  // namespace i2caddr
