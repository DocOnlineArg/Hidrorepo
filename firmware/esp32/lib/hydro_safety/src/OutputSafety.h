// Capa de seguridad de salidas del firmware (C++ portable, sin dependencias de Arduino).
// Se prueba en el host con g++ (test/native). Es la ÚLTIMA barrera antes de los GPIO:
// aunque el dashboard falle, estas reglas se cumplen en la placa.
#pragma once
#include <stdint.h>

namespace hydro {

enum Output : uint8_t {
  PUMP_PH_UP = 0,
  PUMP_PH_DOWN,
  PUMP_OXIDANT,
  PUMP_SOL_A,
  PUMP_SOL_B,
  PUMP_BLOOM,
  PUMP_SILICON,
  PUMP_PK,
  HUMIDIFIER,
  DEHUMIDIFIER,
  FAN,
  LIGHTS,
  NUM_OUTPUTS
};
constexpr uint8_t NUM_PUMPS = 8;

enum Fault : uint32_t {
  FAULT_NONE = 0,
  FAULT_COMM_TIMEOUT = 1u << 0,
  FAULT_PUMP_MAXON = 1u << 1,
  FAULT_ESTOP = 1u << 2,
  FAULT_REJECTED_CONCURRENT = 1u << 3,
  FAULT_REJECTED_OXIDANT = 1u << 4,
  FAULT_REJECTED_HUM_DEHUM = 1u << 5,
  FAULT_REJECTED_NOT_ARMED = 1u << 6,
};

struct SafetyConfig {
  uint32_t heartbeatTimeoutMs = 3000;
  uint32_t pumpHardMaxMs[NUM_PUMPS] = {60000, 60000, 30000, 60000, 60000, 60000, 60000, 60000};
  bool allowSimultaneousPumps = false;  // por defecto, una bomba a la vez
  bool allowHumDehum = false;
};

class OutputSafety {
 public:
  explicit OutputSafety(const SafetyConfig& cfg = SafetyConfig());

  // Estado tras el arranque: todo apagado y desarmado.
  void boot(uint32_t now);
  // Habilitación explícita: requiere token exacto, sin E-STOP y heartbeat reciente.
  bool arm(const char* token, uint32_t now);
  void disarm();
  void heartbeat(uint32_t now);
  void setEstop(bool active);

  // Orden del host. `maxOnMs` es el tiempo máximo ON pedido para cada bomba.
  void command(const bool requested[NUM_OUTPUTS], const uint32_t maxOnMs[NUM_PUMPS], uint32_t now);
  // Debe llamarse periódicamente: aplica timeouts de comunicación y de bombas.
  void update(uint32_t now);
  void allOff();

  bool output(uint8_t i) const { return i < NUM_OUTPUTS && out_[i]; }
  bool armed() const { return armed_; }
  bool estop() const { return estop_; }
  // Rail de 12 V de bombas: solo con salidas armadas y alguna bomba activa.
  bool pumpRailEnabled() const;
  // Habilitación independiente del oxidante (segundo elemento en serie, OX_EN).
  bool oxidantEnable() const { return out_[PUMP_OXIDANT]; }
  uint32_t faults() const { return faults_; }
  void clearFaults() { faults_ = 0; }

 private:
  SafetyConfig cfg_;
  bool out_[NUM_OUTPUTS];
  bool latchedOff_[NUM_PUMPS];  // bomba cortada por tiempo: exige orden OFF antes de rearrancar
  uint32_t onSince_[NUM_PUMPS];
  uint32_t limitMs_[NUM_PUMPS];
  bool armed_ = false;
  bool estop_ = false;
  uint32_t lastHeartbeat_ = 0;
  bool heartbeatSeen_ = false;
  uint32_t faults_ = 0;
  bool anyPumpOnExcept(uint8_t idx) const;
};

}  // namespace hydro
