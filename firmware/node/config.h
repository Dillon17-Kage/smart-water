// Smart Water - per-node configuration.
//
// Every ESP32 runs the same node.ino; only this file changes between boards.
// Adding a zone means adding rows to the tables below, not changing code.
// Sensor and valve codes must match the database and docs/mqtt-contract.md (v1.1).

#pragma once

// ---------------------------------------------------------------- identity
#define NODE_ID     "node-2"
#define FW_VERSION  "0.1.0"

// ---------------------------------------------------------------- hardware tables
enum FlowRole  { FLOW_IN, FLOW_OUT };
enum ValveType { NORMALLY_CLOSED, NORMALLY_OPEN };

struct FlowSensorConfig {
  const char *code;  // e.g. "F2"
  int pin;
  const char *zone;  // inlet and outlet of the same zone share this, for "cal stop"
  FlowRole role;
};

struct PressureSensorConfig {
  const char *code;  // e.g. "P1"
  int pin;           // must be an ADC1 pin (GPIO32-39): ADC2 stops working with Wi-Fi on
};

struct ValveConfig {
  const char *code;  // e.g. "SV1"
  int pin;           // GPIO HIGH = coil energised
  ValveType type;    // NC: energised = open. NO: energised = closed
};

// node-2, Zone A. Zone B rows are ready to uncomment when its sensors arrive.
const FlowSensorConfig FLOW_SENSORS[] = {
  {"F2", 18, "A", FLOW_IN},
  {"F3", 19, "A", FLOW_OUT},
  // {"F4", 16, "B", FLOW_IN},
  // {"F5", 17, "B", FLOW_OUT},
};

const PressureSensorConfig PRESSURE_SENSORS[] = {
  {"P1", 32},
  // {"P2", 33},
};

// A node with no valves (node-1) leaves this list empty: {}
const ValveConfig VALVES[] = {
  {"SV1", 26, NORMALLY_CLOSED},
  // {"SV2", 25, NORMALLY_CLOSED},
};

const int FLOW_COUNT     = sizeof(FLOW_SENSORS) / sizeof(FLOW_SENSORS[0]);
const int PRESSURE_COUNT = sizeof(PRESSURE_SENSORS) / sizeof(PRESSURE_SENSORS[0]);
const int VALVE_COUNT    = sizeof(VALVES) / sizeof(VALVES[0]);

// ---------------------------------------------------------------- safety
// Refuse to close the last open valve unless the command says "force"
// (the pump would dead-head). Keep this on.
const bool LAST_OPEN_VALVE_PROTECTION = true;

// ---------------------------------------------------------------- timings
const uint32_t READINGS_INTERVAL_MS = 1000;  // one readings message per second
const uint32_t PRESSURE_SAMPLE_MS   = 50;    // take a pressure burst this often in the window
const int      PRESSURE_BURST       = 8;     // ADC reads per burst (about 160 per window)
const uint32_t MIN_PULSE_GAP_US     = 1000;  // closer pulses are noise (real max ~600 Hz)

// ---------------------------------------------------------------- measuring
const float DIVIDER_RATIO = 1.5;  // 10k/20k divider in front of each sensor pin

// Default calibration, used ONLY for the Serial monitor. The backend converts the raw
// values with the calibration stored in the database.
const float DEFAULT_K_FACTOR       = 98.0;    // YF-S401: pulses per second per L/min (5880 / L)
const float DEFAULT_P_OFFSET_V     = 0.5;     // sensor volts at 0 kPa
const float DEFAULT_P_SCALE_KPA_V  = 172.37;  // 689.5 kPa (100 PSI) over 4.0 V
