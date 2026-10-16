#include "sensors.h"

#include "pins.h"

// Lecturas más antiguas que esto se consideran inválidas.
static constexpr uint32_t SENSOR_STALE_MS = 10000;

void EzoSensor::poll(uint32_t now) {
  if (s_.ok && now - s_.at > SENSOR_STALE_MS) s_.ok = false;
  if (!pending_) {
    Wire.beginTransmission(addr_);
    if (!isnan(tempComp_)) {
      char cmd[16];
      snprintf(cmd, sizeof(cmd), "RT,%.1f", tempComp_);
      Wire.write(reinterpret_cast<const uint8_t*>(cmd), strlen(cmd));
    } else {
      Wire.write('R');
    }
    if (Wire.endTransmission() != 0) {
      s_.ok = false;  // sin ACK: desconectado
      return;
    }
    pending_ = true;
    requestedAt_ = now;
    return;
  }
  if (now - requestedAt_ < waitMs_) return;
  pending_ = false;
  char buf[32] = {0};
  uint8_t n = Wire.requestFrom(addr_, static_cast<uint8_t>(sizeof(buf) - 1));
  if (n == 0) {
    s_.ok = false;
    return;
  }
  uint8_t status = Wire.read();
  uint8_t i = 0;
  while (Wire.available() && i < sizeof(buf) - 1) {
    char c = static_cast<char>(Wire.read());
    if (c == 0) break;
    buf[i++] = c;
  }
  if (status != 1) {  // 2 = error de sintaxis, 254 = sin terminar, 255 = sin datos
    s_.ok = false;
    return;
  }
  char* end = nullptr;
  float v = strtof(buf, &end);
  if (end == buf) {
    s_.ok = false;
    return;
  }
  s_.value = v;
  s_.ok = true;
  s_.at = now;
}

uint8_t Sht4x::crc8(const uint8_t* d, int n) {
  uint8_t crc = 0xFF;
  for (int i = 0; i < n; i++) {
    crc ^= d[i];
    for (int b = 0; b < 8; b++) crc = (crc & 0x80) ? (crc << 1) ^ 0x31 : (crc << 1);
  }
  return crc;
}

void Sht4x::poll(uint32_t now) {
  if (t_.ok && now - t_.at > SENSOR_STALE_MS) t_.ok = rh_.ok = false;
  if (!pending_) {
    Wire.beginTransmission(i2caddr::SHT4X);
    Wire.write(0xFD);
    if (Wire.endTransmission() != 0) {
      t_.ok = rh_.ok = false;
      return;
    }
    pending_ = true;
    requestedAt_ = now;
    return;
  }
  if (now - requestedAt_ < 20) return;  // 8,3 ms típicos (alta repetibilidad)
  pending_ = false;
  uint8_t d[6];
  if (Wire.requestFrom(i2caddr::SHT4X, static_cast<uint8_t>(6)) != 6) {
    t_.ok = rh_.ok = false;
    return;
  }
  for (int i = 0; i < 6; i++) d[i] = Wire.read();
  if (crc8(d, 2) != d[2] || crc8(d + 3, 2) != d[5]) {
    t_.ok = rh_.ok = false;
    return;
  }
  uint16_t rt = (d[0] << 8) | d[1];
  uint16_t rr = (d[3] << 8) | d[4];
  t_.value = -45.0f + 175.0f * rt / 65535.0f;
  float rh = -6.0f + 125.0f * rr / 65535.0f;
  rh_.value = rh < 0 ? 0 : rh > 100 ? 100 : rh;
  t_.ok = rh_.ok = true;
  t_.at = rh_.at = now;
}

void WaterTemp::begin() {
  dt_.begin();
  dt_.setResolution(12);
  dt_.setWaitForConversion(false);
}

void WaterTemp::poll(uint32_t now) {
  if (s_.ok && now - s_.at > SENSOR_STALE_MS) s_.ok = false;
  if (!pending_) {
    dt_.requestTemperatures();
    pending_ = true;
    requestedAt_ = now;
    return;
  }
  if (now - requestedAt_ < 800) return;  // 750 ms a 12 bits
  pending_ = false;
  float t = dt_.getTempCByIndex(0);
  if (t == DEVICE_DISCONNECTED_C || t == 85.0f) {  // 85 °C = valor de reset del DS18B20
    s_.ok = false;
    return;
  }
  s_.value = t;
  s_.ok = true;
  s_.at = now;
}
