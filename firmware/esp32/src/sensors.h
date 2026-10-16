// Drivers no bloqueantes de sensores. Cada uno expone `poll(now)` y el último valor.
#pragma once
#include <Arduino.h>
#include <DallasTemperature.h>
#include <OneWire.h>
#include <Wire.h>

struct Sample {
  float value = NAN;
  bool ok = false;
  uint32_t at = 0;
};

// Circuito Atlas Scientific EZO en modo I2C (pH, EC, ORP).
// Protocolo: escribir "R", esperar ~900 ms (pH/ORP) / ~600 ms (EC), leer: 1er byte = estado (1 = ok).
// IMPORTANTE: los EZO salen de fábrica en modo UART; se pasan a I2C con el comando "I2C,<dir>".
class EzoSensor {
 public:
  EzoSensor(uint8_t addr, uint16_t waitMs) : addr_(addr), waitMs_(waitMs) {}
  void poll(uint32_t now);
  // Compensación de temperatura ("RT,<t>" en la misma lectura) para pH/EC.
  void setTempComp(float t) { tempComp_ = t; }
  const Sample& sample() const { return s_; }

 private:
  uint8_t addr_;
  uint16_t waitMs_;
  bool pending_ = false;
  uint32_t requestedAt_ = 0;
  float tempComp_ = NAN;
  Sample s_;
};

// Sensirion SHT4x (I2C 0x44): medida de alta repetibilidad 0xFD, 6 bytes con CRC.
class Sht4x {
 public:
  void poll(uint32_t now);
  const Sample& temperature() const { return t_; }
  const Sample& humidity() const { return rh_; }

 private:
  bool pending_ = false;
  uint32_t requestedAt_ = 0;
  Sample t_, rh_;
  static uint8_t crc8(const uint8_t* d, int n);
};

// DS18B20 en modo asíncrono.
class WaterTemp {
 public:
  explicit WaterTemp(uint8_t pin) : wire_(pin), dt_(&wire_) {}
  void begin();
  void poll(uint32_t now);
  const Sample& sample() const { return s_; }

 private:
  OneWire wire_;
  DallasTemperature dt_;
  bool pending_ = false;
  uint32_t requestedAt_ = 0;
  Sample s_;
};
