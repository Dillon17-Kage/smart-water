# Firmware and hardware results so far (node-2, Zone A)

Status on 1 November 2026. This file records what was built, what was tested, what the
measurements were, and what is still open. It is the source for the report and the user
manual. Anything not listed under "Tested" has **not** been tested.

## 1. Summary

| Item | Status |
|---|---|
| Development setup (Arduino IDE / arduino-cli, ESP32 board package) | Done |
| Build step 1: serial-only bring-up sketch (`bringup/bringup.ino`) | Written, flashed, running |
| F2 flow sensor (inlet, GPIO18) | Wired and working (air test) |
| F3 flow sensor (outlet, GPIO19) | Wired and working (air test) |
| P1 pressure sensor (GPIO32) | Wired and working; zero is 0.38 V, not 0.5 V |
| SV1 solenoid valve driver (GPIO26) | MOSFET driver failed (IRFZ44N fitted instead of IRLZ44N). **Replaced by a relay module**; firmware updated; valve switching test pending |
| Build step 2: node firmware without network (`node/node.ino`) | Written and compiles; **not yet flashed or tested on the board** |
| Build steps 3–5: Wi-Fi, MQTT (EMQX Serverless), commands and acks | Not started |
| Water tests (leak check, pressure zero, flow-pair calibration, jug test) | Not done: piping not connected yet |

## 2. Hardware actually used

| Part | Detail |
|---|---|
| MCU | ESP32 DevKit, 30-pin. Chip ESP32-D0WD-V3 rev 3.1, USB chip CH340 (shows up as COM6) |
| Flow sensors | 2 × YF-S401 (F2 inlet, F3 outlet). Design value 5880 pulses/L (98 Hz per L/min) |
| Pressure sensor | 0–100 PSI (0–689.5 kPa), 0.5–4.5 V output, 5 V supply |
| Valve | SV1, 12 V solenoid, normally closed (NC). Works when 12 V is applied directly |
| Valve driver | First an **IRFZ44N** MOSFET (the design calls for an **IRLZ44N**; failed, see 4.3). Now a **YS-4Relay V3.10** 4-channel relay module (SRD-05VDC-SL-C relays, 10 A / 30 V DC contacts, optocoupler inputs), channel 1 |
| Power during tests | Sensors and ESP32 powered from laptop USB (ESP32 VIN pin, about 4.7–4.9 V). 12 V PSU only for the solenoid. The LM2596 buck converter was left out for this step |

### Change from the original schematic: E12 resistor values

The original design used 10k / 20k voltage dividers. 20k is not in the E12 series (the
resistor kit available), so every sensor divider was changed to **12k (sensor side) and
22k (to GND)**.

| | 10k / 20k (original) | 12k / 22k (as built) |
|---|---|---|
| Ratio (sensor V ÷ pin V) | 1.5 | 34/22 = 1.545 |
| Flow pulse, 5 V in | 3.33 V at pin | 3.24 V at pin |
| Pressure, 4.5 V (full scale) | 3.00 V at pin | 2.91 V at pin |

Both are below the ESP32's 3.3 V limit. Both sketches calculate the ratio from the two
resistor values (`DIVIDER_R_TOP`, `DIVIDER_R_BOTTOM`). The updated schematic is
`firmware/zoneA-schematic-e12.png`.

### Pin assignment (as built)

| Signal | Code | ESP32 pin | Circuit |
|---|---|---|---|
| Inlet flow | F2 | GPIO18 | yellow → 12k → pin; 22k pin → GND |
| Outlet flow | F3 | GPIO19 | yellow → 12k → pin; 22k pin → GND |
| Inlet pressure | P1 | GPIO32 (ADC1) | signal → 12k → pin; 22k and 100 nF pin → GND |
| Solenoid | SV1 | GPIO26 | GPIO26 → relay module CH1. Module VCC → 5 V, GND and RGND → GND. +12 V → relay COM; relay **NC** → solenoid → PSU V−; 1N4007 across the solenoid. PSU V− joined to ESP32 GND |

The as-built schematic with the relay is `firmware/zoneA-schematic-relay.png`.
`firmware/zoneA-schematic-e12.png` shows the earlier MOSFET driver.

Sensor codes follow `docs/mqtt-contract.md` v1.1 (Zone A = F2, F3, P1, SV1). The hardware
brief still uses the older names (F6, P2).

## 3. Development setup

- Arduino IDE on Windows, with its bundled `arduino-cli` 1.5.1 used for compiling and uploading.
- Board package: **esp32 by Espressif Systems 3.3.12**, board **ESP32 Dev Module**.
- **Uploading needs the manual boot sequence on this board.** Automatic reset into upload
  mode fails ("Wrong boot mode detected (0x13)"). Fix: hold BOOT, press and release EN,
  release BOOT, then upload. Press EN afterwards to run the sketch.
- The CH340 USB driver was already installed.

## 4. Tests and results

All tests used the bring-up sketch (step 1), Serial Monitor at 115200 baud. No piping
was connected, so the flow sensors were tested by blowing air through them.

### 4.1 Flow sensors F2 and F3

| Test | Result |
|---|---|
| Blow through F2 only | Only F2 counted ✅ |
| Blow through F3 only | Only F3 counted ✅ (pins not swapped) |
| Blow through both together | Both counted, about 175–205 pulses per second at the peak |

The pulse rates while blowing are not a flow measurement; they only prove the sensor,
divider and interrupt counting work. Whether the counts stay at 0 with no airflow (noise
check) was not reported.

### 4.2 Pressure sensor P1

| Test | Result |
|---|---|
| No pressure, ESP32 pin reading | about 250 mV |
| No pressure, multimeter on the sensor's signal wire | about 0.38 V |
| Check: 0.38 V × 22/34 | 246 mV, matches the pin reading ✅ (divider and ADC correct) |
| Blowing into the sensor | pin rose from about 250 to 313 mV, then fell back ✅ |

The sensor's zero is **0.38 V instead of the nominal 0.5 V**. Possible reasons: normal
unit-to-unit offset, and the lower USB supply voltage (the output scales with supply).
No hardware change is needed: the zero is measured with `zero P1` (step 2 firmware, on
the 5.0 V buck supply, pump off) and stored as the sensor's offset in the database.
Until then, the kPa shown on the Serial Monitor reads negative at rest.

### 4.3 Solenoid valve SV1 and driver

| Observation | Meaning |
|---|---|
| Solenoid clicks when connected directly to 12 V | Solenoid is good |
| MOSFET source on ESP32 GND only: never switches | Coil current had no path back to the PSU |
| Grounds not joined: inconsistent readings, and a "zap" when a probe joined PSU V− and the laptop/ESP32 ground | The PSU output and the laptop ground were at different potentials |
| Fix applied: source to PSU V−, PSU V− joined to ESP32 GND | Common ground as the schematic requires |
| With `open SV1`: GPIO26 and gate ≈ 3.2 V, source 0 V, **drain stays at 12 V** | MOSFET not conducting |
| Marking on the MOSFET reads **IRFZ44N** | Standard-level part, needs about 10 V on the gate. The design specifies the logic-level **IRLZ44N**, which switches fully at 3.3 V |

**Result:** the ESP32 and firmware produce the correct gate signal (3.2 V open, 0 V
closed), but the fitted IRFZ44N cannot be switched by a 3.3 V output, so the valve can't
be controlled. No NPN transistor was available for a level shifter.

### 4.4 Relay module replacing the MOSFET

| Test (module VCC → 5 V, GND and RGND → GND, no solenoid) | Result |
|---|---|
| CH1 to 3.3 V | Relay 1 switches on ✅ |
| CH1 to GND | Relay 1 switches off ✅ |

So the module is **active-HIGH** and works directly from a 3.3 V ESP32 output. The
solenoid is wired to the relay's **NC** contact:

| GPIO26 | Relay | Solenoid | Valve |
|---|---|---|---|
| LOW (also the boot state) | off | powered | **open** |
| HIGH | on | off | **closed** |

This is fail-safe: if the ESP32 resets, crashes or loses power, the relay drops out and
the valve stays open, so the pump can't dead-head. The firmware setting for this is
`LOW_ENERGISES` in `config.h` (`SV1_LOW_ENERGISES` in the bring-up sketch).
Switching the actual solenoid through the relay is **not yet tested**.

### 4.5 Water test: pump running, Zone A loop

Bring-up sketch, 19 consecutive one-second lines. SV1 reported open throughout.

| Measurement | Result |
|---|---|
| F2 (inlet) | 1625 pulses over 18 windows, about 90.3 pulses/s (0.92 L/min at the default k-factor) |
| F3 (outlet) | 1601 pulses over 18 windows, about 88.9 pulses/s (0.91 L/min at the default k-factor) |
| F3 / F2 pulse ratio | 0.985, a 1.5% difference |
| P1 at the pin | 378–388 mV, sensor about 0.59 V |
| P1 gauge pressure | roughly 32–36 kPa: the serial line's 16 kPa assumes a 0.5 V zero, but this sensor reads about −16 to −20 kPa at rest (0.38–0.41 V). The exact value needs `zero P1` |

The readings were steady, so water flows through the whole loop and all three sensors
work under real flow. The default k-factor has not been checked against a measured
volume (jug test), so the L/min figures are not yet calibrated. These values do not
replace `cal start` / `cal stop` or `zero P1`. During the same work, the ESP32's VIN and
GND were found swapped on the breadboard, which had put reverse polarity on the rails
and pulled P1's pin to 3160 mV; these results were taken after correcting that.

## 5. Open problems and how to fix them

### 5.1 Valve driver

**Chosen fix: relay module (option 2 below), see 4.4.** The other options are kept for
the report's discussion. Any of these fixes it; only the first needs no firmware change:

1. **Replace the IRFZ44N with an IRLZ44N** (same pinout and wiring, G · D · S).
2. **5 V relay module** (relay on a small board with IN / VCC / GND pins; it contains its
   own transistor and diode): VCC → 5 V, GND → GND, IN → GPIO26; solenoid's +12 V
   through the relay's COM and NO contacts. Many modules switch on when IN is LOW,
   which needs a one-line firmware setting to invert the valve output. A bare relay
   (no module board) can't be driven from a GPIO pin directly.
3. **NPN transistor** (e.g. 2N2222, BC547) driving the IRFZ44N gate from 12 V through a
   pull-up. This inverts the logic (one-line firmware change) and keeps the valve open
   while the ESP32 resets.

### 5.2 Safety items not yet fitted

- **3 A fuse (F3) on the solenoid's 12 V line is not fitted.** The PSU can deliver 20 A,
  so a wiring short has no protection. Must be fitted before the pump runs.
- **1N4007 flyback diode** across the solenoid: orientation (stripe to +12 V) still to be
  confirmed.
- **If SV1's coil has no power, the valve is closed** (NC). The pump must not be
  run with SV1 in the water path, or it dead-heads (pressure builds until the pump's
  pressure switch trips; hose joints can blow off). Either leave SV1 out of the loop
  (tube straight through) or power it directly from 12 V so it stays open.

### 5.3 Still to do

- Flash and test `node.ino` (step 2), with the corrected 12k/22k ratio.
- Reconnect the buck converter (5.0 V) and fit C1 (1000 µF) and a 100 nF across the ESP32's 5V–GND.
- Steps 3–5: Wi-Fi, MQTT over TLS to EMQX Serverless, readings/status/last will, valve
  commands with acknowledgements.
- Water tests: leak check, `zero P1`, flow-pair calibration (`cal start` / `cal stop`),
  jug test. Store the results in the database, not the firmware.

## 6. Firmware written

**Added since section 5 was written:** Wi-Fi with retry, MQTT over TLS to EMQX (certificate
checked against DigiCert Global Root G2), NTP timestamps, readings every second, status
every 10 s with a retained last will, and valve commands with acknowledgements and
duplicate handling, per `docs/mqtt-contract.md` v1.2.

**Tested so far:** `node.ino` is flashed. It joined a phone hotspot and connected to EMQX
over TLS with the `node-2` login. The connection dropped once after about 20 s for an
unknown reason, reconnected by itself, then stayed up for a 90 s watch. **Not yet tested:**
whether messages arrive at the backend and web app, valve commands and acks over MQTT, and
the last will.

### `bringup/bringup.ino` (step 1, on the board now)

- Counts F2 and F3 pulses with interrupts, rejecting pulses less than 1 ms apart (noise).
- Prints once a second: pulses in the last second, total pulses, L/min (default 98 Hz per
  L/min), P1 pin mV, sensor volts and approximate kPa, and the SV1 state.
- Opens SV1 first thing at boot (an NC valve closes while the ESP32 resets).
- Commands: `open SV1`, `close SV1` (refused on purpose), `close SV1 force`, `pins`, `reset`, `help`.
- The copy on the board still uses the old 1.5 divider ratio; the committed source uses 1.545.

### `node/node.ino` + `node/config.h` (step 2, compiled, not yet flashed)

- **Per-node configuration table** (`config.h`): node name, sensors, valves and pins.
  Adding Zone B or C means uncommenting rows, not changing code.
- **Flow:** one interrupt handler for every flow sensor; cumulative totals that never
  reset, plus pulses per 1-second window with the measured window length.
- **Pressure:** sampled in bursts throughout each window (about 160 readings) and averaged.
- **Valves:** all valves open at boot. **Last-open-valve protection:** a close that would
  leave no valve open is refused unless forced (stops the pump dead-heading). NC/NO set per valve.
- **Readings message** built exactly as in `docs/mqtt-contract.md` §4 (print it with `json`).
- **Serial commands:** `open SV1`, `close SV1`, `close SV1 force`, `zero P1`,
  `cal start` / `cal stop` (pulses, mL, F3/F2 ratio, in − out in mL), `status`, `json`, `help`.
- **Watchdog:** restarts the board if the main loop stops for several seconds.
- Design rule: the node only measures and reports raw values; leak detection and
  calibration happen in the backend.

Setup, flashing and the full command list are in `firmware/README.md`.
