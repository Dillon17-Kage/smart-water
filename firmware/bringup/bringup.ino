// Smart Water - bring-up sketch for node-2, Zone A (serial only, no Wi-Fi).
//
// Purpose: check the wiring before the real node firmware goes on.
//   - F2 / F3 flow sensors: blow gently through one and watch its pulses go up.
//   - P1 pressure sensor:   prints the pin voltage and the sensor voltage.
//   - SV1 solenoid:         "open SV1" / "close SV1 force" over serial; listen for the click.
//
// Open the Serial Monitor at 115200 baud, line ending "Newline". Type "help" for commands.
// Wiring: docs/zoneA-schematic.png and section 3 of docs/hardware-brief.md.
// Sensor codes follow docs/mqtt-contract.md v1.1 (the brief still says F6 for F3, P2 for P1).

// ---------------------------------------------------------------- pins
const int PIN_F2  = 18;  // flow IN  (yellow wire, through the 12k/22k divider)
const int PIN_F3  = 19;  // flow OUT (yellow wire, through the 12k/22k divider)
const int PIN_P1  = 32;  // pressure (ADC1, so it keeps working once Wi-Fi is added)
const int PIN_SV1 = 26;  // MOSFET gate: HIGH = coil energised

// ---------------------------------------------------------------- settings
const bool SV1_NORMALLY_CLOSED = true;   // NC valve: coil energised = open

const float PULSES_PER_LPM = 98.0;       // YF-S401: 5880 pulses/L = 98 Hz per L/min
const uint32_t MIN_PULSE_GAP_US = 1000;  // pulses closer than 1 ms are noise (real max ~600 Hz)

// Divider in front of each sensor pin (E12 values): 12k from the sensor, 22k to GND.
// 5 V in gives 3.24 V at the pin. Sensor V = pin V x (12 + 22) / 22.
const float DIVIDER_R_TOP    = 12000.0;
const float DIVIDER_R_BOTTOM = 22000.0;
const float DIVIDER_RATIO = (DIVIDER_R_TOP + DIVIDER_R_BOTTOM) / DIVIDER_R_BOTTOM;
const float P1_ZERO_V   = 0.5;           // sensor volts at 0 kPa
const float P1_SPAN_V   = 4.0;           // 0.5 V .. 4.5 V
const float P1_FULL_KPA = 689.5;         // 100 PSI
const int   ADC_SAMPLES = 64;            // average many readings to calm ADC noise

const uint32_t REPORT_INTERVAL_MS = 1000;

// ---------------------------------------------------------------- flow counting
// The interrupt handlers only touch these. "volatile" because they change behind
// loop()'s back; the spinlock stops loop() reading a count half-way through an update.
struct FlowCounter {
  volatile uint32_t total;        // cumulative since boot (or since "reset")
  volatile uint32_t lastPulseUs;  // time of the last accepted pulse, for glitch rejection
  uint32_t totalAtLastReport;     // used by loop() to get pulses in this window
};

FlowCounter f2 = {0, 0, 0};
FlowCounter f3 = {0, 0, 0};
portMUX_TYPE countLock = portMUX_INITIALIZER_UNLOCKED;

void IRAM_ATTR countPulse(FlowCounter &c) {
  uint32_t now = micros();
  if (now - c.lastPulseUs < MIN_PULSE_GAP_US) return;  // too soon: a glitch, not water
  c.lastPulseUs = now;
  portENTER_CRITICAL_ISR(&countLock);
  c.total = c.total + 1;
  portEXIT_CRITICAL_ISR(&countLock);
}

void IRAM_ATTR onF2Pulse() { countPulse(f2); }
void IRAM_ATTR onF3Pulse() { countPulse(f3); }

uint32_t readTotal(FlowCounter &c) {
  portENTER_CRITICAL(&countLock);
  uint32_t t = c.total;
  portEXIT_CRITICAL(&countLock);
  return t;
}

// ---------------------------------------------------------------- valve
bool sv1Open = false;

void setSV1(bool open) {
  // NC valve opens when energised; an NO valve would be the other way round.
  bool energise = SV1_NORMALLY_CLOSED ? open : !open;
  digitalWrite(PIN_SV1, energise ? HIGH : LOW);
  sv1Open = open;
}

// ---------------------------------------------------------------- pressure
int readPinMilliVolts(int pin) {
  uint32_t sum = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) {
    sum += analogReadMilliVolts(pin);  // factory-calibrated, better than analogRead()
  }
  return sum / ADC_SAMPLES;
}

float sensorVoltsToKpa(float volts) {
  return (volts - P1_ZERO_V) * (P1_FULL_KPA / P1_SPAN_V);
}

// ---------------------------------------------------------------- setup
void setup() {
  // Open the valve before anything else: the pump may already be running and
  // an NC valve is closed while the ESP32 is resetting.
  pinMode(PIN_SV1, OUTPUT);
  setSV1(true);

  Serial.begin(115200);

  // INPUT, not INPUT_PULLUP: the sensor and the divider already set the levels.
  pinMode(PIN_F2, INPUT);
  pinMode(PIN_F3, INPUT);
  attachInterrupt(digitalPinToInterrupt(PIN_F2), onF2Pulse, FALLING);
  attachInterrupt(digitalPinToInterrupt(PIN_F3), onF3Pulse, FALLING);

  analogSetPinAttenuation(PIN_P1, ADC_11db);  // full range up to ~3.1 V at the pin

  Serial.println();
  Serial.println("Smart Water bring-up, node-2 Zone A. SV1 opened at boot.");
  printHelp();
}

// ---------------------------------------------------------------- serial commands
void printHelp() {
  Serial.println("Commands:");
  Serial.println("  open SV1          energise the coil (valve opens, you should hear a click)");
  Serial.println("  close SV1 force   de-energise the coil. PUMP MUST BE OFF first");
  Serial.println("  pins              show the raw logic level on GPIO18/19 right now");
  Serial.println("  reset             set the F2/F3 totals back to 0");
  Serial.println("  help              this list");
}

void handleCommand(String cmd) {
  cmd.trim();
  cmd.toLowerCase();
  if (cmd.length() == 0) return;

  if (cmd == "open sv1") {
    setSV1(true);
    Serial.println("> SV1 open");
  } else if (cmd == "close sv1") {
    // Closing the only valve while the pump runs dead-heads it and can blow off hoses.
    Serial.println("> Refused: closing SV1 with the pump running dead-heads it.");
    Serial.println("  Switch the pump OFF, then type: close SV1 force");
  } else if (cmd == "close sv1 force") {
    setSV1(false);
    Serial.println("> SV1 closed (remember to open it before switching the pump on)");
  } else if (cmd == "pins") {
    Serial.printf("> GPIO18 (F2) = %d, GPIO19 (F3) = %d\n",
                  digitalRead(PIN_F2), digitalRead(PIN_F3));
  } else if (cmd == "reset") {
    portENTER_CRITICAL(&countLock);
    f2.total = 0;
    f3.total = 0;
    portEXIT_CRITICAL(&countLock);
    f2.totalAtLastReport = 0;
    f3.totalAtLastReport = 0;
    Serial.println("> totals reset");
  } else if (cmd == "help") {
    printHelp();
  } else {
    Serial.println("> unknown command, type help");
  }
}

// Collect characters until Enter, without blocking loop().
void readSerialCommands() {
  static String line;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      handleCommand(line);
      line = "";
    } else if (line.length() < 40) {
      line += ch;
    }
  }
}

// ---------------------------------------------------------------- report
void printReport(uint32_t intervalMs) {
  uint32_t f2Total = readTotal(f2);
  uint32_t f3Total = readTotal(f3);
  uint32_t f2Pulses = f2Total - f2.totalAtLastReport;
  uint32_t f3Pulses = f3Total - f3.totalAtLastReport;
  f2.totalAtLastReport = f2Total;
  f3.totalAtLastReport = f3Total;

  float seconds = intervalMs / 1000.0;
  float f2Lpm = f2Pulses / seconds / PULSES_PER_LPM;
  float f3Lpm = f3Pulses / seconds / PULSES_PER_LPM;

  int pinMv = readPinMilliVolts(PIN_P1);
  float sensorV = pinMv * DIVIDER_RATIO / 1000.0;
  float kpa = sensorVoltsToKpa(sensorV);

  Serial.printf("F2 %3lu p (%5lu) %.2f L/min | F3 %3lu p (%5lu) %.2f L/min | "
                "P1 pin %4d mV, sensor %.2f V ~ %4.0f kPa | SV1 %s\n",
                (unsigned long)f2Pulses, (unsigned long)f2Total, f2Lpm,
                (unsigned long)f3Pulses, (unsigned long)f3Total, f3Lpm,
                pinMv, sensorV, kpa, sv1Open ? "open" : "closed");
}

// ---------------------------------------------------------------- loop
void loop() {
  static uint32_t lastReportMs = millis();

  readSerialCommands();

  // No delay(): check the clock instead, so serial input stays responsive.
  uint32_t now = millis();
  if (now - lastReportMs >= REPORT_INTERVAL_MS) {
    printReport(now - lastReportMs);
    lastReportMs = now;
  }
}
