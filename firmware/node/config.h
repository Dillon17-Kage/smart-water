// Smart Water - per-node configuration.
//
// Every ESP32 runs the same node.ino; only this file changes between boards.
// Adding a zone means adding rows to the tables below, not changing code.
// Sensor and valve codes must match the database and docs/mqtt-contract.md (v1.4).

#pragma once

// ---------------------------------------------------------------- which board
// Set this before flashing: 2 = node-2 (trunk, Zone A, return), 3 = node-3 (Zone B),
// 4 = node-4 (Zone C).
#ifndef THIS_NODE
#define THIS_NODE 2
#endif

// ---------------------------------------------------------------- identity
#if THIS_NODE == 2
#define NODE_ID     "node-2"
#elif THIS_NODE == 3
#define NODE_ID     "node-3"
#elif THIS_NODE == 4
#define NODE_ID     "node-4"
#else
#error "THIS_NODE must be 2, 3 or 4"
#endif
#define FW_VERSION  "0.3.0"
#define MQTT_CLIENT_ID "sw-" NODE_ID  // must match nodes.mqtt_client_id in the database

// ---------------------------------------------------------------- hardware tables
enum FlowRole  { FLOW_IN, FLOW_OUT };
enum ValveType { NORMALLY_CLOSED, NORMALLY_OPEN };

// Which GPIO level powers the solenoid coil.
//   HIGH_ENERGISES: logic-level MOSFET, or a relay module with the coil on its NO contact.
//   LOW_ENERGISES:  relay module (on when its input is HIGH) with the coil on its NC
//                   contact: the coil is powered while the relay is off, so the valve
//                   stays open if the ESP32 resets or loses power.
enum ValveDriver { HIGH_ENERGISES, LOW_ENERGISES };

struct FlowSensorConfig {
  const char *code;  // e.g. "F2"
  int pin;
  const char *zone;  // inlet and outlet of the same zone share this, for "cal stop"
  FlowRole role;
};

struct PressureSensorConfig {
  const char *code;  // e.g. "P1"
  int pin;           // must be an ADC1 pin (ESP32: GPIO32-39, C3: GPIO0-4): ADC2 stops working with Wi-Fi on
};

struct ValveConfig {
  const char *code;  // e.g. "SV1"
  int pin;
  ValveType type;      // NC: energised = open. NO: energised = closed
  ValveDriver driver;  // which GPIO level powers the coil
};

// Every flow pin has the same 12k/22k divider. Unwired flow pins float and can count
// noise, so comment out any sensor that isn't connected.
#if THIS_NODE == 2
// node-2: trunk and return flow, plus Zone A.
const FlowSensorConfig FLOW_SENSORS[] = {
  {"F1",  4, "Loop", FLOW_IN},   // trunk
  {"F2", 18, "A", FLOW_IN},
  {"F3", 19, "A", FLOW_OUT},
  {"F8", 14, "Loop", FLOW_OUT},  // return
};

const PressureSensorConfig PRESSURE_SENSORS[] = {
  {"P1", 32},
};

const ValveConfig VALVES[] = {
  {"SV1", 26, NORMALLY_CLOSED, LOW_ENERGISES},  // relay module CH1, coil on NC contact
};

#elif THIS_NODE == 3
// node-3: Zone B. Same pins the contract first gave Zone B on node-2.
const FlowSensorConfig FLOW_SENSORS[] = {
  {"F4", 16, "B", FLOW_IN},
  {"F5", 17, "B", FLOW_OUT},
};

const PressureSensorConfig PRESSURE_SENSORS[] = {
  {"P2", 33},
};

const ValveConfig VALVES[] = {
  {"SV2", 25, NORMALLY_CLOSED, LOW_ENERGISES},  // relay channel, coil on NC contact
};

#elif THIS_NODE == 4
// node-4: Zone C, on an ESP32-C3 SuperMini. The C3 only has GPIO0-10, 20 and 21, so its
// pins differ from the other boards. Avoid GPIO2, 8 and 9: they decide how the C3 boots
// (9 is the BOOT button, 8 the on-board LED).
#if !CONFIG_IDF_TARGET_ESP32C3
#error "node-4 is an ESP32-C3: choose the ESP32C3 Dev Module board"
#endif
const FlowSensorConfig FLOW_SENSORS[] = {
  {"F6", 5, "C", FLOW_IN},
  {"F7", 6, "C", FLOW_OUT},
};

const PressureSensorConfig PRESSURE_SENSORS[] = {
  {"P3", 3},  // the C3's ADC1 is GPIO0-4
};

const ValveConfig VALVES[] = {
  {"SV3", 7, NORMALLY_CLOSED, LOW_ENERGISES},  // relay channel, coil on NC contact
};
#endif

const int FLOW_COUNT     = sizeof(FLOW_SENSORS) / sizeof(FLOW_SENSORS[0]);
const int PRESSURE_COUNT = sizeof(PRESSURE_SENSORS) / sizeof(PRESSURE_SENSORS[0]);
const int VALVE_COUNT    = sizeof(VALVES) / sizeof(VALVES[0]);

// ---------------------------------------------------------------- leak indicator LEDs
// GPIO -> 220 ohm -> LED -> GND. The leak decision comes from the backend.
#if THIS_NODE == 4
const int LED_GREEN_PIN = 10;  // the C3 has no GPIO23 or GPIO13
const int LED_RED_PIN   = 4;
#else
const int LED_GREEN_PIN = 23;  // on: backend says no leak
const int LED_RED_PIN   = 13;  // on: backend says confirmed leak
#endif

// ---------------------------------------------------------------- safety
// Refuse to close the last open valve unless the command says "force"
// (the pump would dead-head). Keep this on.
const bool LAST_OPEN_VALVE_PROTECTION = true;

// ---------------------------------------------------------------- timings
const uint32_t READINGS_INTERVAL_MS = 1000;  // one readings message per second
const uint32_t PRESSURE_SAMPLE_MS   = 50;    // take a pressure burst this often in the window
const int      PRESSURE_BURST       = 8;     // ADC reads per burst (about 160 per window)
const uint32_t MIN_PULSE_GAP_US     = 1000;  // closer pulses are noise (real max ~600 Hz)

// ---------------------------------------------------------------- network
const uint32_t STATUS_INTERVAL_MS  = 10000;  // the database's heartbeat timeout is 30 s
const int      MQTT_KEEPALIVE_S    = 15;     // contract section 1
const int      MQTT_TIMEOUT_MS     = 5000;   // how long to wait for the broker's reply
const uint32_t WIFI_RETRY_MS       = 20000;
const uint32_t MQTT_RETRY_MIN_MS   = 2000;   // back-off: doubles after each failed attempt
const uint32_t MQTT_RETRY_MAX_MS   = 30000;
const int      TLS_HANDSHAKE_S     = 15;
const int      WATCHDOG_TIMEOUT_S  = 30;     // longer than a slow TLS connection attempt

// Debug only: skips checking the broker's certificate. Leave this false.
const bool MQTT_INSECURE_TLS_DEBUG = false;

// ---------------------------------------------------------------- measuring
// Divider in front of each sensor pin (E12 values): 12k from the sensor, 22k to GND.
// 5 V in gives 3.24 V at the pin. Sensor V = pin V x (12 + 22) / 22.
// Change these two if other resistors are fitted.
const float DIVIDER_R_TOP    = 12000.0;
const float DIVIDER_R_BOTTOM = 22000.0;
const float DIVIDER_RATIO = (DIVIDER_R_TOP + DIVIDER_R_BOTTOM) / DIVIDER_R_BOTTOM;

// Default calibration, used ONLY for the Serial monitor. The backend converts the raw
// values with the calibration stored in the database.
const float DEFAULT_K_FACTOR       = 98.0;    // YF-S401: pulses per second per L/min (5880 / L)
const float DEFAULT_P_OFFSET_V     = 0.5;     // sensor volts at 0 kPa
const float DEFAULT_P_SCALE_KPA_V  = 172.37;  // 689.5 kPa (100 PSI) over 4.0 V
