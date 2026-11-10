// Smart Water - node firmware: measuring, serial commands, Wi-Fi and MQTT over TLS.
//
// The node is "dumb" on purpose: it counts flow pulses, reads pressure volts, drives
// valves and reports. Leak detection and calibration live in the backend.
// Which sensors and valves this board has comes from config.h.
// Message format: docs/mqtt-contract.md (v1.4).
//
// Serial Monitor: 115200 baud, line ending "Newline". Type "help" for commands.

#include <stdarg.h>
#include <sys/time.h>
#include <time.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <MQTT.h>         // library "MQTT" by Joel Gaehwiler (256dpi)
#include <ArduinoJson.h>  // library "ArduinoJson" by Benoit Blanchon
#include <esp_task_wdt.h>
#include "config.h"
#include "secrets.h"      // copy secrets.example.h to secrets.h and fill it in
#include "ca_cert.h"

// Result of a valve command. The rejections match the "reason" codes of the MQTT ack
// (contract section 7). Declared up here because the Arduino IDE puts its generated
// function prototypes above the first function.
enum ValveResult { VALVE_DONE, VALVE_UNKNOWN, VALVE_LAST_OPEN };

// What the backend last told us about leaks. UNKNOWN until its message arrives.
enum LeakIndicator { LEAK_UNKNOWN, LEAK_NONE, LEAK_CONFIRMED };

// ================================================================ flow counting
// One counter per flow sensor. The interrupt handler only touches these; "volatile"
// because they change behind loop()'s back, and the spinlock stops loop() reading a
// count half-way through an update.
struct FlowCounter {
  volatile uint32_t total;        // cumulative pulses since boot, never reset while running
  volatile uint32_t lastPulseUs;  // time of the last accepted pulse, for glitch rejection
};

FlowCounter flowCounters[FLOW_COUNT];
portMUX_TYPE countLock = portMUX_INITIALIZER_UNLOCKED;

// attachInterruptArg() passes us the counter of the sensor that fired,
// so one handler serves every flow sensor.
void IRAM_ATTR onFlowPulse(void *arg) {
  FlowCounter *counter = (FlowCounter *)arg;
  uint32_t now = micros();
  if (now - counter->lastPulseUs < MIN_PULSE_GAP_US) return;  // too soon: a glitch
  counter->lastPulseUs = now;
  portENTER_CRITICAL_ISR(&countLock);
  counter->total = counter->total + 1;
  portEXIT_CRITICAL_ISR(&countLock);
}

uint32_t readFlowTotal(int i) {
  portENTER_CRITICAL(&countLock);
  uint32_t total = flowCounters[i].total;
  portEXIT_CRITICAL(&countLock);
  return total;
}

// ================================================================ readings
// One "window" is about a second. At its end we freeze the numbers into `latest`,
// which the serial line and the MQTT message are made from.
struct Reading {
  uint32_t seq;                      // goes up by 1 per window, starts at 0 at boot
  char     ts[32];                   // end of the window, UTC; empty until NTP has synced
  uint32_t intervalMs;               // measured window length
  uint32_t pulses[FLOW_COUNT];       // pulses in this window
  uint32_t totals[FLOW_COUNT];       // cumulative pulses at the end of the window
  int      pressureMv[PRESSURE_COUNT];  // sensor mV (divider undone), window average
};

Reading latest;
bool haveReading = false;
uint32_t nextSeq = 0;
uint32_t windowStartMs = 0;
uint32_t totalsAtWindowStart[FLOW_COUNT];

// Pressure is sampled in short bursts all through the window, then averaged,
// so pump pulsation evens out.
uint32_t pressureSumMv[PRESSURE_COUNT];
uint32_t pressureSampleCount = 0;
uint32_t lastPressureSampleMs = 0;

void samplePressure() {
  for (int p = 0; p < PRESSURE_COUNT; p++) {
    for (int i = 0; i < PRESSURE_BURST; i++) {
      pressureSumMv[p] += analogReadMilliVolts(PRESSURE_SENSORS[p].pin);  // factory-calibrated
    }
  }
  pressureSampleCount += PRESSURE_BURST;
}

// The clock starts near 1970 until NTP sets it, so a date this recent means it's synced.
bool clockIsSynced() {
  return time(nullptr) > 1700000000;
}

// Writes e.g. 2026-10-28T09:15:02.004Z, or an empty string if NTP hasn't synced yet.
void formatTimestamp(char *buf, size_t size) {
  buf[0] = '\0';
  if (!clockIsSynced()) return;
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  struct tm utc;
  gmtime_r(&tv.tv_sec, &utc);
  char seconds[24];
  strftime(seconds, sizeof(seconds), "%Y-%m-%dT%H:%M:%S", &utc);
  snprintf(buf, size, "%s.%03dZ", seconds, (int)(tv.tv_usec / 1000));
}

void finishWindow(uint32_t now) {
  latest.seq = nextSeq++;
  latest.intervalMs = now - windowStartMs;
  formatTimestamp(latest.ts, sizeof(latest.ts));

  for (int i = 0; i < FLOW_COUNT; i++) {
    uint32_t total = readFlowTotal(i);
    latest.totals[i] = total;
    latest.pulses[i] = total - totalsAtWindowStart[i];
    totalsAtWindowStart[i] = total;
  }

  for (int p = 0; p < PRESSURE_COUNT; p++) {
    float pinMv = pressureSampleCount > 0 ? (float)pressureSumMv[p] / pressureSampleCount : 0;
    latest.pressureMv[p] = (int)(pinMv * DIVIDER_RATIO + 0.5);
    pressureSumMv[p] = 0;
  }
  pressureSampleCount = 0;

  windowStartMs = now;
  haveReading = true;
}

// Default conversions, for the Serial monitor only (the backend uses the database).
float pulsesToLpm(uint32_t pulses, uint32_t intervalMs) {
  if (intervalMs == 0) return 0;
  return pulses / (intervalMs / 1000.0) / DEFAULT_K_FACTOR;
}

float pulsesToMl(uint32_t pulses) {
  return pulses * 1000.0 / (DEFAULT_K_FACTOR * 60.0);  // 5880 pulses per litre
}

float sensorMvToKpa(int mv) {
  return (mv / 1000.0 - DEFAULT_P_OFFSET_V) * DEFAULT_P_SCALE_KPA_V;
}

// ================================================================ valves
bool valveOpen[VALVE_COUNT];

void driveValve(int v, bool open) {
  // NC valve opens when energised; NO valve closes when energised.
  bool energise = (VALVES[v].type == NORMALLY_CLOSED) ? open : !open;
  bool pinHigh = (VALVES[v].driver == HIGH_ENERGISES) ? energise : !energise;
  digitalWrite(VALVES[v].pin, pinHigh ? HIGH : LOW);
  valveOpen[v] = open;
}

int findValve(const char *code) {
  for (int v = 0; v < VALVE_COUNT; v++) {
    if (strcasecmp(VALVES[v].code, code) == 0) return v;
  }
  return -1;
}

int countOpenValves() {
  int open = 0;
  for (int v = 0; v < VALVE_COUNT; v++) {
    if (valveOpen[v]) open++;
  }
  return open;
}

// The one place where valves are opened or closed on request. Serial commands use it
// now; MQTT commands will use it in step 4, so both get the same safety check.
ValveResult commandValve(const char *code, bool open, bool force) {
  int v = findValve(code);
  if (v < 0) return VALVE_UNKNOWN;

  // Already in that state: nothing gets closed, so no safety check needed.
  if (valveOpen[v] == open) return VALVE_DONE;

  // Closing the only open valve while the pump runs dead-heads the pump.
  if (!open && LAST_OPEN_VALVE_PROTECTION && !force && countOpenValves() == 1) {
    return VALVE_LAST_OPEN;
  }

  driveValve(v, open);
  return VALVE_DONE;
}

// ================================================================ readings JSON
// Append formatted text to buf, keeping track of how much is used.
// Returns false if it didn't fit.
bool appendf(char *buf, size_t size, size_t &used, const char *fmt, ...) {
  if (used >= size) return false;
  va_list args;
  va_start(args, fmt);
  int n = vsnprintf(buf + used, size - used, fmt, args);
  va_end(args);
  if (n < 0 || used + n >= size) {
    used = size;
    return false;
  }
  used += n;
  return true;
}

// Builds the "readings" payload exactly as in docs/mqtt-contract.md section 4.
// "ts" is left out until NTP has synced; the backend then uses its receive time.
bool buildReadingsJson(char *buf, size_t size) {
  size_t used = 0;
  bool ok = appendf(buf, size, used, "{\"node\":\"%s\",\"seq\":%lu,",
                    NODE_ID, (unsigned long)latest.seq);
  if (latest.ts[0] != '\0') {
    ok &= appendf(buf, size, used, "\"ts\":\"%s\",", latest.ts);
  }
  ok &= appendf(buf, size, used, "\"interval_ms\":%lu,\"flow\":[", (unsigned long)latest.intervalMs);
  for (int i = 0; i < FLOW_COUNT; i++) {
    ok &= appendf(buf, size, used, "%s{\"sensor\":\"%s\",\"pulses\":%lu,\"total\":%lu}",
                  i > 0 ? "," : "", FLOW_SENSORS[i].code,
                  (unsigned long)latest.pulses[i], (unsigned long)latest.totals[i]);
  }
  ok &= appendf(buf, size, used, "],\"pressure\":[");
  for (int p = 0; p < PRESSURE_COUNT; p++) {
    ok &= appendf(buf, size, used, "%s{\"sensor\":\"%s\",\"mv\":%d}",
                  p > 0 ? "," : "", PRESSURE_SENSORS[p].code, latest.pressureMv[p]);
  }
  ok &= appendf(buf, size, used, "],\"valves\":[");
  for (int v = 0; v < VALVE_COUNT; v++) {
    ok &= appendf(buf, size, used, "%s{\"valve\":\"%s\",\"state\":\"%s\"}",
                  v > 0 ? "," : "", VALVES[v].code, valveOpen[v] ? "open" : "closed");
  }
  ok &= appendf(buf, size, used, "]}");
  return ok;
}

// ================================================================ network
// Everything here retries by itself. Pulse counting and valve state carry on regardless,
// and a valve never changes because Wi-Fi or the broker went away.
WiFiClientSecure tlsClient;
MQTTClient mqtt(1024);  // read and write buffers; payloads are under 1024 bytes

char readingsTopic[48];
char statusTopic[48];
char cmdTopic[48];
char ackTopic[48];
char indicatorTopic[48];

LeakIndicator leakIndicator = LEAK_UNKNOWN;

bool wifiWasUp = false;
bool mqttWasUp = false;
uint32_t lastWifiAttemptMs = 0;
uint32_t lastMqttAttemptMs = 0;
uint32_t mqttRetryDelayMs = MQTT_RETRY_MIN_MS;
uint32_t lastStatusMs = 0;

// Commands wait here until loop() handles them, because the MQTT library says not to
// publish from inside its message callback, and every command needs an ack.
const int CMD_QUEUE_SIZE = 4;
char cmdQueue[CMD_QUEUE_SIZE][256];
int cmdQueueCount = 0;

// QoS 1 can deliver a command twice: remember the last 10 ids and their acks, so a
// repeat gets the same ack and the valve isn't operated twice.
const int REMEMBERED_ACKS = 10;
char rememberedIds[REMEMBERED_ACKS][48];
char rememberedAcks[REMEMBERED_ACKS][220];
int nextRememberedAck = 0;

// Green must never claim "all fine" when the node can't hear the backend, so with no
// connection, or before the backend's message arrives, both LEDs are off.
void updateLeds() {
  bool connected = mqtt.connected();
  digitalWrite(LED_GREEN_PIN, connected && leakIndicator == LEAK_NONE ? HIGH : LOW);
  digitalWrite(LED_RED_PIN, connected && leakIndicator == LEAK_CONFIRMED ? HIGH : LOW);
}

void handleIndicatorMessage(const char *payload) {
  JsonDocument indicator;
  LeakIndicator newState = LEAK_UNKNOWN;
  if (!deserializeJson(indicator, payload) && indicator["leak"].is<bool>()) {
    newState = indicator["leak"].as<bool>() ? LEAK_CONFIRMED : LEAK_NONE;
  }
  if (newState != leakIndicator) {
    Serial.printf("> Leak indicator: %s\n", newState == LEAK_CONFIRMED ? "LEAK (red)"
                                          : newState == LEAK_NONE      ? "no leak (green)"
                                                                       : "unknown (LEDs off)");
  }
  leakIndicator = newState;
}

void onMqttMessage(String &topic, String &payload) {
  if (topic == indicatorTopic) {
    handleIndicatorMessage(payload.c_str());
    return;
  }
  if (cmdQueueCount >= CMD_QUEUE_SIZE) {
    Serial.println("> MQTT: command queue full, command dropped");
    return;
  }
  strlcpy(cmdQueue[cmdQueueCount], payload.c_str(), sizeof(cmdQueue[0]));
  cmdQueueCount++;
}

void handleMqttCommand(const char *payload) {
  JsonDocument command;
  DeserializationError parseError = deserializeJson(command, payload);
  const char *id = command["id"] | "";
  const char *valve = command["valve"] | "";
  const char *action = command["action"] | "";
  bool force = command["force"] | false;

  bool idUsable = strlen(id) > 0 && strlen(id) < sizeof(rememberedIds[0]);
  if (idUsable) {
    for (int i = 0; i < REMEMBERED_ACKS; i++) {
      if (strcmp(rememberedIds[i], id) == 0) {
        mqtt.publish(ackTopic, rememberedAcks[i], false, 1);
        Serial.printf("> MQTT: repeated command %s, same ack sent again\n", id);
        return;
      }
    }
  }

  bool isOpen = strcmp(action, "open") == 0;
  bool isClose = strcmp(action, "close") == 0;
  const char *reason = nullptr;

  if (parseError || !idUsable || (!isOpen && !isClose)) {
    reason = "bad_command";
  } else {
    ValveResult result = commandValve(valve, isOpen, force);
    if (result == VALVE_UNKNOWN) reason = "unknown_valve";
    if (result == VALVE_LAST_OPEN) reason = "last_open_valve";
  }

  int v = findValve(valve);
  JsonDocument ack;
  ack["id"] = id;
  ack["valve"] = valve;
  ack["result"] = reason ? "rejected" : "done";
  ack["state"] = v < 0 ? "unknown" : (valveOpen[v] ? "open" : "closed");
  if (reason) ack["reason"] = reason;
  else ack["reason"] = nullptr;

  char ackJson[220];
  serializeJson(ack, ackJson, sizeof(ackJson));
  mqtt.publish(ackTopic, ackJson, false, 1);
  Serial.printf("> MQTT command: %s %s -> %s\n", action, valve, ackJson);

  if (idUsable) {
    strlcpy(rememberedIds[nextRememberedAck], id, sizeof(rememberedIds[0]));
    strlcpy(rememberedAcks[nextRememberedAck], ackJson, sizeof(rememberedAcks[0]));
    nextRememberedAck = (nextRememberedAck + 1) % REMEMBERED_ACKS;
  }
}

void handleQueuedCommands() {
  for (int i = 0; i < cmdQueueCount; i++) {
    handleMqttCommand(cmdQueue[i]);
  }
  cmdQueueCount = 0;
}

void publishStatus() {
  JsonDocument status;
  status["node"] = NODE_ID;
  status["state"] = "online";
  status["fw"] = FW_VERSION;
  status["mac"] = WiFi.macAddress();
  status["ip"] = WiFi.localIP().toString();
  status["rssi"] = WiFi.RSSI();
  status["uptime_s"] = millis() / 1000;
  status["heap"] = ESP.getFreeHeap();
  status["ntp"] = clockIsSynced();

  char json[256];
  serializeJson(status, json, sizeof(json));
  mqtt.publish(statusTopic, json, true, 1);
  lastStatusMs = millis();
}

void publishReadings() {
  char json[1024];
  if (!buildReadingsJson(json, sizeof(json))) {
    Serial.println("> readings message too big, not sent");
    return;
  }
  // QoS 0: it doesn't wait for the broker, and a lost message loses no volume because
  // every message carries the cumulative totals.
  mqtt.publish(readingsTopic, json, false, 0);
}

void setupNetwork() {
  snprintf(readingsTopic, sizeof(readingsTopic), "smartwater/%s/readings", NODE_ID);
  snprintf(statusTopic, sizeof(statusTopic), "smartwater/%s/status", NODE_ID);
  snprintf(cmdTopic, sizeof(cmdTopic), "smartwater/%s/cmd", NODE_ID);
  snprintf(ackTopic, sizeof(ackTopic), "smartwater/%s/ack", NODE_ID);
  snprintf(indicatorTopic, sizeof(indicatorTopic), "smartwater/%s/indicator", NODE_ID);

  if (MQTT_INSECURE_TLS_DEBUG) {
    tlsClient.setInsecure();
    Serial.println("WARNING: broker certificate NOT checked (debug flag in config.h)");
  } else {
    tlsClient.setCACert(MQTT_ROOT_CA);
  }
  tlsClient.setHandshakeTimeout(TLS_HANDSHAKE_S);

  mqtt.begin(MQTT_HOST, MQTT_PORT, tlsClient);
  mqtt.onMessage(onMqttMessage);
  mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
  mqtt.setCleanSession(true);
  mqtt.setTimeout(MQTT_TIMEOUT_MS);

  // The broker publishes this for us if the node disappears.
  char offlineJson[64];
  snprintf(offlineJson, sizeof(offlineJson), "{\"node\":\"%s\",\"state\":\"offline\"}", NODE_ID);
  mqtt.setWill(statusTopic, offlineJson, true, 1);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // so valve commands aren't delayed by Wi-Fi power saving
  WiFi.begin(WIFI_SSID, WIFI_PASS);
#if CONFIG_IDF_TARGET_ESP32C3
  // The C3 SuperMini's antenna is badly matched: at full transmit power it often never
  // joins the network. Lower power is the known fix, and still reaches a nearby hotspot.
  WiFi.setTxPower(WIFI_POWER_8_5dBm);
#endif
  lastWifiAttemptMs = millis();
  Serial.printf("Wi-Fi: connecting to %s\n", WIFI_SSID);
}

void connectMqtt() {
  Serial.printf("MQTT: connecting to %s\n", MQTT_HOST);
  // This can take a few seconds while TLS sets up. Pulses are still counted by the
  // interrupts, and the next window's interval_ms covers the extra time.
  if (mqtt.connect(MQTT_CLIENT_ID, MQTT_USER, MQTT_PASS)) {
    Serial.println("MQTT: connected");
    mqttWasUp = true;
    mqttRetryDelayMs = MQTT_RETRY_MIN_MS;
    leakIndicator = LEAK_UNKNOWN;  // forget the old state; the retained message brings it back
    mqtt.subscribe(cmdTopic, 1);  // clean session: subscribe again after every connect
    mqtt.subscribe(indicatorTopic, 1);
    publishStatus();              // replaces the retained "offline" straight away
  } else {
    Serial.printf("MQTT: failed (error %d, broker code %d), retrying in %lu s\n",
                  (int)mqtt.lastError(), (int)mqtt.returnCode(),
                  (unsigned long)(mqttRetryDelayMs / 1000));
    mqttRetryDelayMs = min(mqttRetryDelayMs * 2, MQTT_RETRY_MAX_MS);
  }
  lastMqttAttemptMs = millis();
}

void maintainNetwork(uint32_t now) {
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiWasUp) {
      Serial.println("Wi-Fi: lost");
      wifiWasUp = false;
    }
    if (mqttWasUp) {
      Serial.println("MQTT: disconnected");
      mqttWasUp = false;
    }
    if (now - lastWifiAttemptMs >= WIFI_RETRY_MS) {
      Serial.println("Wi-Fi: trying again");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
      lastWifiAttemptMs = now;
    }
    return;
  }

  if (!wifiWasUp) {
    wifiWasUp = true;
    Serial.printf("Wi-Fi: connected, IP %s, signal %d dBm\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
    configTime(0, 0, "pool.ntp.org", "time.google.com");  // UTC; syncs in the background
    mqttRetryDelayMs = 0;  // connect straight away
  }

  if (mqtt.connected()) {
    mqtt.loop();
    handleQueuedCommands();
    if (now - lastStatusMs >= STATUS_INTERVAL_MS) publishStatus();
    return;
  }

  if (mqttWasUp) {
    Serial.println("MQTT: disconnected");
    mqttWasUp = false;
    mqttRetryDelayMs = MQTT_RETRY_MIN_MS;
    lastMqttAttemptMs = now;
  }
  if (now - lastMqttAttemptMs >= mqttRetryDelayMs) {
    if (mqttRetryDelayMs == 0) mqttRetryDelayMs = MQTT_RETRY_MIN_MS;
    connectMqtt();
  }
}

// ================================================================ serial output
void printReadingLine() {
  // e.g. F2 0.67 L/min | F3 0.66 L/min | P1 0.85 V ~ 60 kPa | SV1 open | MQTT off
  for (int i = 0; i < FLOW_COUNT; i++) {
    Serial.printf("%s %.2f L/min | ", FLOW_SENSORS[i].code,
                  pulsesToLpm(latest.pulses[i], latest.intervalMs));
  }
  for (int p = 0; p < PRESSURE_COUNT; p++) {
    Serial.printf("%s %.2f V ~ %.0f kPa | ", PRESSURE_SENSORS[p].code,
                  latest.pressureMv[p] / 1000.0, sensorMvToKpa(latest.pressureMv[p]));
  }
  for (int v = 0; v < VALVE_COUNT; v++) {
    Serial.printf("%s %s | ", VALVES[v].code, valveOpen[v] ? "open" : "closed");
  }
  Serial.println(mqtt.connected() ? "MQTT ok" : "MQTT off");
}

// ================================================================ calibration window
// "cal start" / "cal stop" give the pulse totals over a hand-timed window, for the
// flow-pair calibration and the jug test (hardware brief section 6).
bool calRunning = false;
uint32_t calStartMs = 0;
uint32_t calStartTotals[FLOW_COUNT];

void calStart() {
  for (int i = 0; i < FLOW_COUNT; i++) calStartTotals[i] = readFlowTotal(i);
  calStartMs = millis();
  calRunning = true;
  Serial.println("> calibration window started; type \"cal stop\" to finish");
}

void calStop() {
  if (!calRunning) {
    Serial.println("> no calibration window running; type \"cal start\" first");
    return;
  }
  calRunning = false;
  uint32_t calPulses[FLOW_COUNT];
  for (int i = 0; i < FLOW_COUNT; i++) calPulses[i] = readFlowTotal(i) - calStartTotals[i];

  Serial.printf("> calibration window: %.1f s\n", (millis() - calStartMs) / 1000.0);
  for (int i = 0; i < FLOW_COUNT; i++) {
    Serial.printf("  %s  %lu pulses  ~ %.0f mL\n", FLOW_SENSORS[i].code,
                  (unsigned long)calPulses[i], pulsesToMl(calPulses[i]));
  }

  // For every zone with both an inlet and an outlet sensor: ratio and difference.
  for (int in = 0; in < FLOW_COUNT; in++) {
    if (FLOW_SENSORS[in].role != FLOW_IN) continue;
    for (int out = 0; out < FLOW_COUNT; out++) {
      if (FLOW_SENSORS[out].role != FLOW_OUT) continue;
      if (strcmp(FLOW_SENSORS[in].zone, FLOW_SENSORS[out].zone) != 0) continue;
      float ratio = calPulses[in] > 0 ? (float)calPulses[out] / calPulses[in] : 0;
      Serial.printf("  Zone %s: %s/%s pulse ratio %.4f, in - out ~ %.0f mL\n",
                    FLOW_SENSORS[in].zone, FLOW_SENSORS[out].code, FLOW_SENSORS[in].code,
                    ratio, pulsesToMl(calPulses[in]) - pulsesToMl(calPulses[out]));
    }
  }
}

// ================================================================ serial commands
void printHelp() {
  // The examples use this board's own codes, so node-3 shows SV2 and P2, not SV1 and P1.
  const char *valve = VALVE_COUNT > 0 ? VALVES[0].code : "SV1";
  const char *pressure = PRESSURE_COUNT > 0 ? PRESSURE_SENSORS[0].code : "P1";
  Serial.println("Commands:");
  Serial.printf("  open %-4s          open a valve\n", valve);
  Serial.printf("  close %-4s         close a valve (refused if it is the last open one)\n", valve);
  Serial.printf("  close %-4s force   close it anyway. ONLY with the pump OFF\n", valve);
  Serial.printf("  zero %-4s          pressure sensor volts now (pump off, line open)\n", pressure);
  Serial.println("  cal start          start a flow calibration / jug test window");
  Serial.println("  cal stop           print pulses, mL and in/out ratio for the window");
  Serial.println("  status             node health and totals");
  Serial.println("  json               the readings message that MQTT will send");
  Serial.println("  help               this list");
}

void printStatus() {
  Serial.printf("> node %s, firmware %s, uptime %lu s, free heap %lu bytes\n",
                NODE_ID, FW_VERSION, (unsigned long)(millis() / 1000),
                (unsigned long)ESP.getFreeHeap());
  for (int i = 0; i < FLOW_COUNT; i++) {
    Serial.printf("  %s on GPIO%d: total %lu pulses (~ %.0f mL)\n", FLOW_SENSORS[i].code,
                  FLOW_SENSORS[i].pin, (unsigned long)readFlowTotal(i),
                  pulsesToMl(readFlowTotal(i)));
  }
  for (int v = 0; v < VALVE_COUNT; v++) {
    Serial.printf("  %s on GPIO%d: %s\n", VALVES[v].code, VALVES[v].pin,
                  valveOpen[v] ? "open" : "closed");
  }
  Serial.printf("  last-open-valve protection: %s\n", LAST_OPEN_VALVE_PROTECTION ? "on" : "off");
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("  Wi-Fi: %s, IP %s, signal %d dBm\n", WIFI_SSID,
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    Serial.printf("  Wi-Fi: not connected (trying %s)\n", WIFI_SSID);
  }
  Serial.printf("  MQTT: %s, client id %s\n", mqtt.connected() ? "connected" : "not connected",
                MQTT_CLIENT_ID);
  Serial.printf("  clock: %s\n", clockIsSynced() ? "synced (NTP)" : "not synced yet");
  Serial.printf("  leak indicator: %s\n", leakIndicator == LEAK_CONFIRMED ? "LEAK (red)"
                                        : leakIndicator == LEAK_NONE      ? "no leak (green)"
                                                                          : "unknown (LEDs off)");
}

void handleValveCommand(const char *code, bool open, bool force) {
  ValveResult result = commandValve(code, open, force);
  if (result == VALVE_UNKNOWN) {
    Serial.printf("> no valve called %s on this node\n", code);
  } else if (result == VALVE_LAST_OPEN) {
    Serial.printf("> Refused: %s is the last open valve and the pump would dead-head.\n", code);
    Serial.printf("  Switch the pump OFF, then type: close %s force\n", code);
  } else {
    int v = findValve(code);
    Serial.printf("> %s %s\n", VALVES[v].code, valveOpen[v] ? "open" : "closed");
  }
}

void handleZero(const char *code) {
  for (int p = 0; p < PRESSURE_COUNT; p++) {
    if (strcasecmp(PRESSURE_SENSORS[p].code, code) == 0) {
      // The last window is already an average of about 160 ADC reads.
      Serial.printf("> %s zero: %.3f V (put this in the database as the pressure offset)\n",
                    PRESSURE_SENSORS[p].code, latest.pressureMv[p] / 1000.0);
      return;
    }
  }
  Serial.printf("> no pressure sensor called %s on this node\n", code);
}

void handleCommand(const char *line) {
  char word1[16] = "", word2[16] = "", word3[16] = "";
  int words = sscanf(line, "%15s %15s %15s", word1, word2, word3);
  if (words <= 0) return;

  bool needsReading = strcasecmp(word1, "zero") == 0 || strcasecmp(word1, "json") == 0;
  if (needsReading && !haveReading) {
    Serial.println("> no readings yet, try again in a second");
    return;
  }

  if (strcasecmp(word1, "open") == 0 && words == 2) {
    handleValveCommand(word2, true, false);
  } else if (strcasecmp(word1, "close") == 0 && words == 2) {
    handleValveCommand(word2, false, false);
  } else if (strcasecmp(word1, "close") == 0 && words == 3 && strcasecmp(word3, "force") == 0) {
    handleValveCommand(word2, false, true);
  } else if (strcasecmp(word1, "zero") == 0 && words == 2) {
    handleZero(word2);
  } else if (strcasecmp(word1, "cal") == 0 && strcasecmp(word2, "start") == 0) {
    calStart();
  } else if (strcasecmp(word1, "cal") == 0 && strcasecmp(word2, "stop") == 0) {
    calStop();
  } else if (strcasecmp(word1, "status") == 0) {
    printStatus();
  } else if (strcasecmp(word1, "json") == 0) {
    char json[1024];
    if (buildReadingsJson(json, sizeof(json))) Serial.println(json);
    else Serial.println("> readings message too big for the 1024-byte buffer");
  } else if (strcasecmp(word1, "help") == 0) {
    printHelp();
  } else {
    Serial.println("> unknown command, type help");
  }
}

// Collect characters until Enter, without blocking loop().
void readSerialCommands() {
  static char line[64];
  static size_t length = 0;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      line[length] = '\0';
      handleCommand(line);
      length = 0;
    } else if (length < sizeof(line) - 1) {
      line[length++] = ch;
    }
  }
}

// ================================================================ setup / loop
void setup() {
  // Open every valve before anything else: the pump may already be running, and an
  // NC valve is closed while the ESP32 resets (e.g. after a brownout).
  for (int v = 0; v < VALVE_COUNT; v++) {
    pinMode(VALVES[v].pin, OUTPUT);
    driveValve(v, true);
  }

  pinMode(LED_GREEN_PIN, OUTPUT);
  pinMode(LED_RED_PIN, OUTPUT);
  digitalWrite(LED_GREEN_PIN, LOW);
  digitalWrite(LED_RED_PIN, LOW);

  Serial.begin(115200);

  // INPUT, not INPUT_PULLUP: the sensor and the divider already set the levels.
  for (int i = 0; i < FLOW_COUNT; i++) {
    pinMode(FLOW_SENSORS[i].pin, INPUT);
    attachInterruptArg(digitalPinToInterrupt(FLOW_SENSORS[i].pin), onFlowPulse,
                       &flowCounters[i], FALLING);
  }

  for (int p = 0; p < PRESSURE_COUNT; p++) {
    analogSetPinAttenuation(PRESSURE_SENSORS[p].pin, ADC_11db);  // up to ~3.1 V at the pin
  }

  // Restart the board if loop() ever gets stuck. The limit is longer than the default
  // because connecting to the broker over TLS can legitimately take several seconds.
  esp_task_wdt_config_t watchdog = {};
  watchdog.timeout_ms = WATCHDOG_TIMEOUT_S * 1000;
  watchdog.trigger_panic = true;
  if (esp_task_wdt_reconfigure(&watchdog) != ESP_OK) esp_task_wdt_init(&watchdog);
  enableLoopWDT();

  windowStartMs = millis();
  lastPressureSampleMs = windowStartMs;

  Serial.println();
  Serial.printf("Smart Water node %s, firmware %s. All valves opened at boot.\n",
                NODE_ID, FW_VERSION);
  printHelp();

  setupNetwork();
}

void loop() {
  readSerialCommands();
  maintainNetwork(millis());
  updateLeds();

  // No delay(): check the clock instead, so pulses, commands and valves never wait.
  uint32_t now = millis();
  if (now - lastPressureSampleMs >= PRESSURE_SAMPLE_MS) {
    samplePressure();
    lastPressureSampleMs = now;
  }
  if (now - windowStartMs >= READINGS_INTERVAL_MS) {
    samplePressure();  // make sure every window has at least one burst
    finishWindow(now);
    printReadingLine();
    if (mqtt.connected()) publishReadings();
  }
}
