#include "OutputSafety.h"

#include <string.h>

namespace hydro {

OutputSafety::OutputSafety(const SafetyConfig& cfg) : cfg_(cfg) { boot(0); }

void OutputSafety::boot(uint32_t now) {
  allOff();
  for (uint8_t i = 0; i < NUM_PUMPS; i++) {
    latchedOff_[i] = false;
    onSince_[i] = 0;
    limitMs_[i] = 0;
  }
  armed_ = false;
  heartbeatSeen_ = false;
  lastHeartbeat_ = now;
  faults_ = 0;
}

void OutputSafety::allOff() {
  for (uint8_t i = 0; i < NUM_OUTPUTS; i++) out_[i] = false;
}

bool OutputSafety::arm(const char* token, uint32_t now) {
  if (estop_ || token == nullptr || strcmp(token, "ARMAR") != 0) return false;
  if (!heartbeatSeen_ || now - lastHeartbeat_ > cfg_.heartbeatTimeoutMs) return false;
  armed_ = true;
  return true;
}

void OutputSafety::disarm() {
  armed_ = false;
  allOff();
}

void OutputSafety::heartbeat(uint32_t now) {
  lastHeartbeat_ = now;
  heartbeatSeen_ = true;
}

void OutputSafety::setEstop(bool active) {
  estop_ = active;
  if (active) {
    faults_ |= FAULT_ESTOP;
    disarm();
  }
}

bool OutputSafety::anyPumpOnExcept(uint8_t idx) const {
  for (uint8_t i = 0; i < NUM_PUMPS; i++)
    if (i != idx && out_[i]) return true;
  return false;
}

bool OutputSafety::pumpRailEnabled() const {
  if (!armed_ || estop_) return false;
  for (uint8_t i = 0; i < NUM_PUMPS; i++)
    if (out_[i]) return true;
  return false;
}

void OutputSafety::command(const bool req[NUM_OUTPUTS], const uint32_t maxOnMs[NUM_PUMPS], uint32_t now) {
  // Toda orden válida cuenta como señal de vida.
  heartbeat(now);
  if (!armed_ || estop_) {
    for (uint8_t i = 0; i < NUM_OUTPUTS; i++)
      if (req[i]) faults_ |= FAULT_REJECTED_NOT_ARMED;
    allOff();
    return;
  }
  // 1) Apagados primero (liberan interbloqueos y latches).
  for (uint8_t i = 0; i < NUM_OUTPUTS; i++) {
    if (!req[i]) {
      out_[i] = false;
      if (i < NUM_PUMPS) latchedOff_[i] = false;
    }
  }
  // 2) Bombas.
  for (uint8_t i = 0; i < NUM_PUMPS; i++) {
    if (!req[i] || out_[i]) continue;  // ya encendida: se mantiene con su límite original
    if (latchedOff_[i]) continue;
    uint32_t limit = maxOnMs[i];
    if (limit == 0) continue;  // sin límite explícito no se arranca
    if (limit > cfg_.pumpHardMaxMs[i]) limit = cfg_.pumpHardMaxMs[i];
    bool otherOn = anyPumpOnExcept(i);
    if (i == PUMP_OXIDANT && otherOn) {
      faults_ |= FAULT_REJECTED_OXIDANT;
      continue;
    }
    if (i != PUMP_OXIDANT && out_[PUMP_OXIDANT]) {
      faults_ |= FAULT_REJECTED_OXIDANT;
      continue;
    }
    if (otherOn && !cfg_.allowSimultaneousPumps) {
      faults_ |= FAULT_REJECTED_CONCURRENT;
      continue;
    }
    out_[i] = true;
    onSince_[i] = now;
    limitMs_[i] = limit;
  }
  // 3) Clima con interbloqueo humidificador/deshumidificador.
  for (uint8_t i = HUMIDIFIER; i < NUM_OUTPUTS; i++) {
    if (!req[i]) continue;
    if (!cfg_.allowHumDehum) {
      if (i == HUMIDIFIER && out_[DEHUMIDIFIER]) {
        faults_ |= FAULT_REJECTED_HUM_DEHUM;
        continue;
      }
      if (i == DEHUMIDIFIER && out_[HUMIDIFIER]) {
        faults_ |= FAULT_REJECTED_HUM_DEHUM;
        continue;
      }
    }
    out_[i] = true;
  }
}

void OutputSafety::update(uint32_t now) {
  if (estop_) {
    allOff();
    armed_ = false;
    return;
  }
  if (armed_ && now - lastHeartbeat_ > cfg_.heartbeatTimeoutMs) {
    faults_ |= FAULT_COMM_TIMEOUT;
    disarm();
  }
  for (uint8_t i = 0; i < NUM_PUMPS; i++) {
    if (out_[i] && now - onSince_[i] >= limitMs_[i]) {
      out_[i] = false;
      latchedOff_[i] = true;
      faults_ |= FAULT_PUMP_MAXON;
    }
  }
}

}  // namespace hydro
