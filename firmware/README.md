# Node firmware (Arduino IDE)

Phase 1: one sketch for every ESP32 node; each board differs only in `config.h`.
Wi-Fi and MQTT passwords go in `node/secrets.h`, which Git ignores
(copy `secrets.example.h` to start). The Wi-Fi network must be 2.4 GHz; on a phone hotspot,
turn on "maximise compatibility" or choose the 2.4 GHz band.

| Folder | What it is |
|---|---|
| `bringup/` | Serial-only wiring test: flow pulses, pressure volts, valve click. No Wi-Fi |
| `node/` | The node firmware. `config.h` holds the node name, pin table and timings |

Sensor codes follow `docs/mqtt-contract.md` v1.1. Zone A on node-2 is
F2 (inlet flow, GPIO18), F3 (outlet flow, GPIO19), P1 (inlet pressure, GPIO32),
SV1 (solenoid, GPIO26). The hardware brief still uses the old names F6 and P2.

## Arduino IDE setup (Windows)

1. **File → Preferences → Additional boards manager URLs:**
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
2. **Tools → Board → Boards Manager:** install **esp32 by Espressif Systems** (3.x).
   Not "Arduino ESP32 Boards", which is a different package for Arduino's own boards.
3. **Tools → Board → esp32 → ESP32 Dev Module.** Port: the "USB-SERIAL CH340" COM port.
   Leave the other Tools settings at their defaults.
4. **Tools → Manage Libraries:** install **MQTT** by Joel Gaehwiler (256dpi) and
   **ArduinoJson** by Benoit Blanchon. Only `node/` needs them.

## Flashing

- When the board is on laptop USB, **unplug its 5V (VIN) wire** from the buck converter
  (keep GND connected).
- Close the Serial Monitor first: it holds the COM port.
- If upload stalls at "Connecting…" or says *Wrong boot mode*, put the board into upload
  mode by hand: **hold BOOT, press and release EN, release BOOT**, then upload. When it
  finishes, press EN once to start the sketch. (The node-2 board needs this every time.)

## Serial Monitor

115200 baud, line ending **Newline**. Type `help` in either sketch.

`node.ino` prints one line a second, e.g.
`F2 0.67 L/min | F3 0.66 L/min | P1 0.85 V ~ 60 kPa | SV1 open | MQTT off`
(these conversions use built-in defaults; the backend uses the calibration in the database).

| Command | Does |
|---|---|
| `open SV1` | Open a valve |
| `close SV1` | Close a valve. Refused if it's the last open valve (the pump would dead-head) |
| `close SV1 force` | Close it anyway. **Only with the pump switched off** |
| `zero P1` | Pressure sensor volts now. Pump off, line open: this is the offset for the database |
| `cal start` / `cal stop` | Pulses, mL and the F3/F2 ratio over a hand-timed window (flow-pair calibration, jug test) |
| `status` | Uptime, free heap, flow totals, valve states |
| `json` | The readings message exactly as MQTT will send it |

## Leak indicator LEDs

Wiring: GPIO23 → 220 Ω → green LED → GND, and GPIO13 → 220 Ω → red LED → GND. The leak
decision is made in the backend, which tells the node over MQTT.

| Situation | Green | Red |
|---|---|---|
| Backend says no leak | on | off |
| Backend says confirmed leak | off | on |
| No MQTT connection, or no message from the backend yet | off | off |

## Valve behaviour

- **Every valve opens at boot**, before anything else, so a reset with the pump running
  never leaves the water path closed.
- SV1 is **normally closed**: the coil is energised (and gets warm) the whole time the
  valve is open. That's expected.
- SV1 is switched by a **relay module** (YS-4Relay, on when CH1 is HIGH) with the
  solenoid on the relay's **NC** contact. GPIO26 LOW = relay off = coil powered = valve
  open; GPIO26 HIGH = valve closed. If the ESP32 resets or loses power the valve stays
  open. The driver type is the `ValveDriver` column in `config.h`.
- The node never changes a valve because Wi-Fi, the broker or the backend went away.
