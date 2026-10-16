// HidroTwin · firmware ESP32 (Arduino framework)
//
// Responsabilidades del firmware (la lógica de control vive en el dashboard):
//  - Estado seguro inmediato al arrancar: todas las salidas en BAJO antes que nada.
//  - Lectura no bloqueante de sensores (EZO pH/EC/ORP, SHT4x, DS18B20).
//  - Protocolo JSON v1 por WebSocket (puerto 81): hello, telemetry, ack / heartbeat, outputs, arm.
//  - Capa de seguridad local (hydro::OutputSafety): armado explícito, timeout de heartbeat,
//    tiempo máximo por bomba, exclusión de bombas, oxidante aislado, interbloqueo hum/deshum, E-STOP.
//  - Watchdog de tareas, recuperación tras reinicio (siempre desarmado) y registro de errores en NVS.
#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WebSocketsServer.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_system.h>
#include <esp_task_wdt.h>

#include "OutputSafety.h"
#include "pins.h"
#include "sensors.h"

static const char* FW_VERSION = "hydro-esp32 0.1.0";
static constexpr int PROTOCOL_VERSION = 1;
static constexpr uint32_t WDT_TIMEOUT_S = 5;
static constexpr uint32_t TELEMETRY_PERIOD_MS = 1000;

static const char* OUTPUT_KEYS[hydro::NUM_OUTPUTS] = {"phUp", "phDown", "oxidant", "solA", "solB", "bloom",
                                                       "silicon", "pk", "humidifier", "dehumidifier", "fan", "lights"};
static const uint8_t OUTPUT_PINS[hydro::NUM_OUTPUTS] = {
    pins::PUMP[0], pins::PUMP[1], pins::PUMP[2], pins::PUMP[3], pins::PUMP[4], pins::PUMP[5],
    pins::PUMP[6], pins::PUMP[7], pins::HUMIDIFIER, pins::DEHUMIDIFIER, pins::FAN, pins::LIGHTS};

static hydro::OutputSafety safety;
static WebSocketsServer ws(81);
static Preferences prefs;

static EzoSensor ezoPh(i2caddr::EZO_PH, 900);
static EzoSensor ezoEc(i2caddr::EZO_EC, 600);
static EzoSensor ezoOrp(i2caddr::EZO_ORP, 900);
static Sht4x sht;
static WaterTemp waterTemp(pins::ONEWIRE);

static uint32_t telemetrySeq = 0;
static uint32_t lastTelemetry = 0;
static uint32_t bootCount = 0;
static String resetReason;

// ---------------------------------------------------------------- registro de errores
static constexpr int ERRLOG_SIZE = 16;
static String errLog[ERRLOG_SIZE];
static int errHead = 0;
static uint32_t lastFaults = 0;

static void logError(const String& msg) {
  errLog[errHead] = String(millis()) + ":" + msg;
  errHead = (errHead + 1) % ERRLOG_SIZE;
  Serial.println("[ERR] " + msg);
  prefs.putUInt("errcount", prefs.getUInt("errcount", 0) + 1);
}

static const char* resetReasonStr(esp_reset_reason_t r) {
  switch (r) {
    case ESP_RST_POWERON: return "POWERON";
    case ESP_RST_SW: return "SOFTWARE";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT: return "WDT";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    default: return "OTRO";
  }
}

// ---------------------------------------------------------------- salidas
static void forceAllOutputsLow() {
  for (uint8_t i = 0; i < hydro::NUM_OUTPUTS; i++) {
    digitalWrite(OUTPUT_PINS[i], LOW);  // primero el nivel, luego el modo: sin glitch
    pinMode(OUTPUT_PINS[i], OUTPUT);
  }
  digitalWrite(pins::PUMP_RAIL_EN, LOW);
  pinMode(pins::PUMP_RAIL_EN, OUTPUT);
  digitalWrite(pins::OX_EN, LOW);
  pinMode(pins::OX_EN, OUTPUT);
}

static void applyOutputs() {
  for (uint8_t i = 0; i < hydro::NUM_OUTPUTS; i++) digitalWrite(OUTPUT_PINS[i], safety.output(i) ? HIGH : LOW);
  digitalWrite(pins::PUMP_RAIL_EN, safety.pumpRailEnabled() ? HIGH : LOW);
  digitalWrite(pins::OX_EN, safety.oxidantEnable() ? HIGH : LOW);
}

// ---------------------------------------------------------------- protocolo
static void sendJson(uint8_t client, JsonDocument& doc, bool broadcast = false) {
  String out;
  serializeJson(doc, out);
  if (broadcast)
    ws.broadcastTXT(out);
  else
    ws.sendTXT(client, out);
}

static void sendHello(uint8_t client) {
  JsonDocument doc;
  doc["type"] = "hello";
  doc["proto"] = PROTOCOL_VERSION;
  doc["fw"] = FW_VERSION;
  doc["board"] = "esp32-wroom-32e";
  doc["resetReason"] = resetReason + " boot#" + String(bootCount);
  sendJson(client, doc);
}

static void sendAck(uint8_t client, uint32_t seq, bool ok, const char* error = nullptr) {
  JsonDocument doc;
  doc["type"] = "ack";
  doc["seq"] = seq;
  doc["ok"] = ok;
  if (error) doc["error"] = error;
  sendJson(client, doc);
}

static void addSensor(JsonObject sensors, const char* key, const Sample& s, float scale = 1.0f) {
  JsonObject o = sensors[key].to<JsonObject>();
  if (s.ok)
    o["raw"] = s.value * scale;
  else
    o["raw"] = nullptr;
  o["ok"] = s.ok;
}

static void sendTelemetry() {
  JsonDocument doc;
  doc["type"] = "telemetry";
  doc["seq"] = ++telemetrySeq;
  doc["uptimeMs"] = millis();
  JsonObject sensors = doc["sensors"].to<JsonObject>();
  addSensor(sensors, "ph", ezoPh.sample());
  addSensor(sensors, "ec", ezoEc.sample(), 0.001f);  // EZO-EC entrega µS/cm → mS/cm
  addSensor(sensors, "orp", ezoOrp.sample());
  addSensor(sensors, "airTemp", sht.temperature());
  addSensor(sensors, "rh", sht.humidity());
  addSensor(sensors, "waterTemp", waterTemp.sample());
  JsonObject outputs = doc["outputs"].to<JsonObject>();
  for (uint8_t i = 0; i < hydro::NUM_OUTPUTS; i++) outputs[OUTPUT_KEYS[i]] = safety.output(i);
  doc["armed"] = safety.armed();
  doc["estop"] = safety.estop();
  JsonArray faults = doc["faults"].to<JsonArray>();
  uint32_t f = safety.faults();
  if (f & hydro::FAULT_COMM_TIMEOUT) faults.add("comm_timeout");
  if (f & hydro::FAULT_PUMP_MAXON) faults.add("pump_maxon");
  if (f & hydro::FAULT_ESTOP) faults.add("estop");
  if (f & hydro::FAULT_REJECTED_CONCURRENT) faults.add("rejected_concurrent");
  if (f & hydro::FAULT_REJECTED_OXIDANT) faults.add("rejected_oxidant");
  if (f & hydro::FAULT_REJECTED_HUM_DEHUM) faults.add("rejected_hum_dehum");
  if (f & hydro::FAULT_REJECTED_NOT_ARMED) faults.add("rejected_not_armed");
  sendJson(0, doc, true);
}

static void handleMessage(uint8_t client, const uint8_t* payload, size_t len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) {
    logError("JSON inválido");
    return;
  }
  const char* type = doc["type"] | "";
  uint32_t seq = doc["seq"] | 0;
  uint32_t now = millis();
  if (strcmp(type, "heartbeat") == 0) {
    safety.heartbeat(now);
  } else if (strcmp(type, "outputs") == 0) {
    bool req[hydro::NUM_OUTPUTS] = {false};
    uint32_t maxOn[hydro::NUM_PUMPS] = {0};
    JsonObject o = doc["outputs"];
    JsonObject m = doc["maxOnMs"];
    for (uint8_t i = 0; i < hydro::NUM_OUTPUTS; i++) req[i] = o[OUTPUT_KEYS[i]] | false;
    for (uint8_t i = 0; i < hydro::NUM_PUMPS; i++) maxOn[i] = m[OUTPUT_KEYS[i]] | 0;
    safety.command(req, maxOn, now);
    applyOutputs();
  } else if (strcmp(type, "arm") == 0) {
    bool armReq = doc["armed"] | false;
    if (armReq) {
      bool ok = safety.arm(doc["token"] | "", now);
      if (ok) {
        safety.clearFaults();
        lastFaults = 0;
      } else {
        logError("Armado rechazado");
      }
      sendAck(client, seq, ok, ok ? nullptr : "armado rechazado");
    } else {
      safety.disarm();
      applyOutputs();
      sendAck(client, seq, true);
    }
  } else {
    sendAck(client, seq, false, "tipo desconocido");
  }
}

static void onWsEvent(uint8_t client, WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      sendHello(client);
      break;
    case WStype_TEXT:
      handleMessage(client, payload, len);
      break;
    case WStype_DISCONNECTED:
      // El timeout de heartbeat de OutputSafety apagará las salidas si no hay otro cliente.
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- red
static void startNetwork() {
  String ssid = prefs.getString("wifi_ssid", "");
  String pass = prefs.getString("wifi_pass", "");
  if (ssid.length()) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid.c_str(), pass.c_str());
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000) {
      esp_task_wdt_reset();
      delay(100);
    }
    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("WiFi STA %s IP %s\n", ssid.c_str(), WiFi.localIP().toString().c_str());
      return;
    }
    logError("WiFi STA no disponible; se inicia punto de acceso");
  }
  // Punto de acceso de configuración. Cambie la clave por defecto (NVS "ap_pass").
  String apPass = prefs.getString("ap_pass", "hidrotwin-setup");
  WiFi.mode(WIFI_AP);
  WiFi.softAP("HidroTwin", apPass.c_str());
  Serial.printf("AP HidroTwin IP %s\n", WiFi.softAPIP().toString().c_str());
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  forceAllOutputsLow();  // SIEMPRE lo primero
  pinMode(pins::ESTOP_SENSE, INPUT);
  pinMode(pins::PUMP_RAIL_SENSE, INPUT);
  pinMode(pins::LEVEL_RESERVOIR, INPUT);

  Serial.begin(115200);
  prefs.begin("hydro", false);
  bootCount = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", bootCount);
  resetReason = resetReasonStr(esp_reset_reason());
  prefs.putString("last_reset", resetReason);
  Serial.printf("%s arranque #%u motivo %s\n", FW_VERSION, bootCount, resetReason.c_str());

  hydro::SafetyConfig cfg;
  cfg.heartbeatTimeoutMs = prefs.getUInt("hb_timeout", 3000);
  for (uint8_t i = 0; i < hydro::NUM_PUMPS; i++) {
    char key[12];
    snprintf(key, sizeof(key), "pmax%u", i);
    cfg.pumpHardMaxMs[i] = prefs.getUInt(key, cfg.pumpHardMaxMs[i]);
  }
  safety = hydro::OutputSafety(cfg);
  safety.boot(millis());  // recuperación tras reinicio: desarmado y todo apagado

  esp_task_wdt_init(WDT_TIMEOUT_S, true);
  esp_task_wdt_add(nullptr);

  Wire.begin(pins::I2C_SDA, pins::I2C_SCL, 100000);
  waterTemp.begin();
  startNetwork();
  ws.begin();
  ws.onEvent(onWsEvent);
}

void loop() {
  esp_task_wdt_reset();
  uint32_t now = millis();

  // E-STOP físico (lazo normalmente cerrado: BAJO = activado o cable roto).
  bool estop = digitalRead(pins::ESTOP_SENSE) == LOW;
  if (estop != safety.estop()) {
    safety.setEstop(estop);
    if (estop) logError("E-STOP activado");
  }

  ezoPh.poll(now);
  ezoEc.poll(now);
  ezoOrp.poll(now);
  sht.poll(now);
  waterTemp.poll(now);
  if (waterTemp.sample().ok) {
    ezoPh.setTempComp(waterTemp.sample().value);
    ezoEc.setTempComp(waterTemp.sample().value);
  }

  ws.loop();
  safety.update(now);
  applyOutputs();

  uint32_t f = safety.faults();
  if (f != lastFaults) {
    if ((f & hydro::FAULT_COMM_TIMEOUT) && !(lastFaults & hydro::FAULT_COMM_TIMEOUT)) logError("Timeout de heartbeat: salidas apagadas");
    if ((f & hydro::FAULT_PUMP_MAXON) && !(lastFaults & hydro::FAULT_PUMP_MAXON)) logError("Bomba cortada por tiempo máximo");
    lastFaults = f;
  }

  if (now - lastTelemetry >= TELEMETRY_PERIOD_MS) {
    lastTelemetry = now;
    sendTelemetry();
  }
}
