// Pruebas nativas (host) de la capa de seguridad del firmware. Sin dependencias.
#include <cstdio>
#include <cstring>

#include "../../lib/hydro_safety/src/OutputSafety.h"

using namespace hydro;

static int failures = 0, checks = 0;
#define CHECK(cond)                                                     \
  do {                                                                  \
    checks++;                                                           \
    if (!(cond)) {                                                      \
      failures++;                                                       \
      std::printf("FALLO %s:%d  %s\n", __FILE__, __LINE__, #cond);      \
    }                                                                   \
  } while (0)

struct Frame {
  bool req[NUM_OUTPUTS];
  uint32_t maxOn[NUM_PUMPS];
  Frame() {
    std::memset(req, 0, sizeof(req));
    std::memset(maxOn, 0, sizeof(maxOn));
  }
};

static OutputSafety armedSafety(uint32_t now, SafetyConfig cfg = SafetyConfig()) {
  OutputSafety s(cfg);
  s.boot(now);
  s.heartbeat(now);
  s.arm("ARMAR", now);
  return s;
}

static void test_boot_and_arming() {
  OutputSafety s;
  s.boot(0);
  for (int i = 0; i < NUM_OUTPUTS; i++) CHECK(!s.output(i));
  CHECK(!s.armed());
  CHECK(!s.arm("ARMAR", 0));  // sin heartbeat
  s.heartbeat(10);
  CHECK(!s.arm("armar", 10));
  CHECK(!s.arm(nullptr, 10));
  CHECK(s.arm("ARMAR", 10));
  Frame f;
  f.req[FAN] = true;
  s.disarm();
  s.command(f.req, f.maxOn, 20);
  CHECK(!s.output(FAN));  // desarmado → nada se enciende
  CHECK(s.faults() & FAULT_REJECTED_NOT_ARMED);
}

static void test_pump_maxon_and_latch() {
  OutputSafety s = armedSafety(0);
  Frame f;
  f.req[PUMP_SOL_A] = true;
  f.maxOn[PUMP_SOL_A] = 5000;
  s.command(f.req, f.maxOn, 0);
  CHECK(s.output(PUMP_SOL_A));
  CHECK(s.pumpRailEnabled());
  s.heartbeat(2000);
  s.update(4000);
  CHECK(s.output(PUMP_SOL_A));
  s.command(f.req, f.maxOn, 4500);  // la misma trama repetida no amplía el límite
  s.update(5000);
  CHECK(!s.output(PUMP_SOL_A));
  CHECK(s.faults() & FAULT_PUMP_MAXON);
  s.command(f.req, f.maxOn, 5100);  // sigue pidiendo ON: bloqueada hasta una orden OFF
  CHECK(!s.output(PUMP_SOL_A));
  Frame off;
  s.command(off.req, off.maxOn, 5200);
  s.command(f.req, f.maxOn, 5300);
  CHECK(s.output(PUMP_SOL_A));
}

static void test_hard_max_and_missing_limit() {
  OutputSafety s = armedSafety(0);
  Frame f;
  f.req[PUMP_PH_UP] = true;
  f.maxOn[PUMP_PH_UP] = 0;  // sin límite → rechazo
  s.command(f.req, f.maxOn, 0);
  CHECK(!s.output(PUMP_PH_UP));
  f.maxOn[PUMP_PH_UP] = 10u * 60u * 1000u;  // pide 10 min; el máximo duro es 60 s
  s.command(f.req, f.maxOn, 0);
  CHECK(s.output(PUMP_PH_UP));
  for (uint32_t t = 1000; t <= 59000; t += 1000) {
    s.heartbeat(t);
    s.update(t);
  }
  CHECK(s.output(PUMP_PH_UP));
  s.heartbeat(60000);
  s.update(60000);
  CHECK(!s.output(PUMP_PH_UP));
}

static void test_concurrency_and_oxidant() {
  OutputSafety s = armedSafety(0);
  Frame f;
  f.req[PUMP_PH_DOWN] = true;
  f.maxOn[PUMP_PH_DOWN] = 5000;
  s.command(f.req, f.maxOn, 0);
  f.req[PUMP_SOL_A] = true;
  f.maxOn[PUMP_SOL_A] = 5000;
  f.req[PUMP_OXIDANT] = true;
  f.maxOn[PUMP_OXIDANT] = 5000;
  s.command(f.req, f.maxOn, 100);
  CHECK(s.output(PUMP_PH_DOWN));
  CHECK(!s.output(PUMP_SOL_A));
  CHECK(!s.output(PUMP_OXIDANT));
  CHECK(!s.oxidantEnable());
  // Incluso permitiendo simultaneidad, el oxidante nunca coincide con otra bomba.
  SafetyConfig cfg;
  cfg.allowSimultaneousPumps = true;
  OutputSafety s2 = armedSafety(0, cfg);
  Frame g;
  g.req[PUMP_OXIDANT] = true;
  g.maxOn[PUMP_OXIDANT] = 3000;
  s2.command(g.req, g.maxOn, 0);
  CHECK(s2.output(PUMP_OXIDANT));
  g.req[PUMP_BLOOM] = true;
  g.maxOn[PUMP_BLOOM] = 3000;
  s2.command(g.req, g.maxOn, 10);
  CHECK(!s2.output(PUMP_BLOOM));
  CHECK(s2.faults() & FAULT_REJECTED_OXIDANT);
}

static void test_hum_dehum_interlock() {
  OutputSafety s = armedSafety(0);
  Frame f;
  f.req[HUMIDIFIER] = true;
  s.command(f.req, f.maxOn, 0);
  f.req[DEHUMIDIFIER] = true;
  s.command(f.req, f.maxOn, 10);
  CHECK(s.output(HUMIDIFIER));
  CHECK(!s.output(DEHUMIDIFIER));
  CHECK(s.faults() & FAULT_REJECTED_HUM_DEHUM);
}

static void test_comm_timeout_and_estop() {
  OutputSafety s = armedSafety(0);
  Frame f;
  f.req[FAN] = true;
  f.req[LIGHTS] = true;
  s.command(f.req, f.maxOn, 0);
  CHECK(s.output(FAN));
  s.update(2999);
  CHECK(s.output(FAN));
  s.update(3001);
  CHECK(!s.output(FAN));
  CHECK(!s.output(LIGHTS));
  CHECK(!s.armed());
  CHECK(s.faults() & FAULT_COMM_TIMEOUT);

  OutputSafety e = armedSafety(0);
  e.command(f.req, f.maxOn, 0);
  e.setEstop(true);
  CHECK(!e.output(FAN));
  CHECK(!e.armed());
  CHECK(!e.arm("ARMAR", 1));
  e.command(f.req, f.maxOn, 2);
  CHECK(!e.output(FAN));
  CHECK(!e.pumpRailEnabled());
}

static void test_config_validation() {
  SafetyConfig c;
  CHECK(validateConfig(c) == nullptr);
  c.heartbeatTimeoutMs = 500;
  CHECK(validateConfig(c) != nullptr);
  c.heartbeatTimeoutMs = 3000;
  c.pumpHardMaxMs[PUMP_SOL_B] = 400000;
  CHECK(validateConfig(c) != nullptr);
  c.pumpHardMaxMs[PUMP_SOL_B] = 20000;
  OutputSafety s = armedSafety(0);
  CHECK(s.applyConfig(c) != nullptr);  // armado → rechazo
  s.disarm();
  CHECK(s.applyConfig(c) == nullptr);
  CHECK(s.config().pumpHardMaxMs[PUMP_SOL_B] == 20000);
  // El nuevo máximo duro se aplica a las órdenes siguientes
  s.heartbeat(0);
  CHECK(s.arm("ARMAR", 0));
  Frame f;
  f.req[PUMP_SOL_B] = true;
  f.maxOn[PUMP_SOL_B] = 60000;
  s.command(f.req, f.maxOn, 0);
  s.heartbeat(19000);
  s.update(19000);
  CHECK(s.output(PUMP_SOL_B));
  s.update(20000);
  CHECK(!s.output(PUMP_SOL_B));
  CHECK(constantTimeEqual("abcd", "abcd", 4));
  CHECK(!constantTimeEqual("abcd", "abce", 4));
}

int main() {
  test_config_validation();
  test_boot_and_arming();
  test_pump_maxon_and_latch();
  test_hard_max_and_missing_limit();
  test_concurrency_and_oxidant();
  test_hum_dehum_interlock();
  test_comm_timeout_and_estop();
  std::printf("%d comprobaciones, %d fallos\n", checks, failures);
  return failures ? 1 : 0;
}
