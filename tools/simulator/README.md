# Node simulator (fake node-2)

A .NET console app that pretends to be node-2 with Zone A (F2, F3, P1, SV1). It talks to
the broker **exactly like the ESP32 firmware** (`docs/mqtt-contract.md`), so the backend
and web app can be tested and demonstrated without the rig.

It uses the same MQTT client id as the real board (`sw-node-2`), so **run the simulator
or the real node, never both at once.**

## Set up once

EMQX details go in user-secrets, never in Git. Use node-2's credentials (docs/setup.md):

```powershell
cd tools\simulator
dotnet user-secrets set "Mqtt:Host" "<your-deployment>.emqxsl.com"
dotnet user-secrets set "Mqtt:Username" "node-2"
dotnet user-secrets set "Mqtt:Password" "<node-2 password>"
```

## Run

```powershell
cd tools\simulator
dotnet run
```

It connects, publishes `online`, then sends readings every second and status every
10 s. Every 5 s it prints the true values the dashboard should show.

| Key | Does |
|---|---|
| **L** | Open or shut the drain cock (the leak). F2 goes up a little, F3 drops by the leak size |
| **+ / −** | Leak size up or down by 0.05 L/min (0.05 to 0.60, starts at 0.35) |
| **P** | Pump on or off. Off means no flow and no pressure |
| **O** | Node offline (asks the broker to send the last will now), press again to reconnect |
| **F** | Valve fault: commands are ignored with no ack, so the backend times out after 5 s |
| **I** | The node's own last-open-valve check on or off (on by default, like the firmware) |
| **T** | Stop or start sending timestamps, as if NTP hadn't synced |
| **S** | Show the current state |
| **Q** | Quit cleanly (publishes `offline` first) |

## What it simulates

- **Flow:** about 0.65 L/min through Zone A, ±1 % noise. F3 reads 1.5 % low all the time,
  like two cheap sensors that never agree. That's the offset the baseline calibration
  measures. Pulses are whole numbers at 98 pulses/s per L/min, and the leftover fraction
  carries into the next second, as on the real sensor.
- **Leak:** F2 rises by 0.3 × the leak size and F3 drops by the leak size, so
  inlet − outlet = the leak. P1 drops 10 kPa per L/min of leak.
- **Pressure:** about 60 kPa, sent as the sensor's voltage in mV (0.5 V + kPa / 172.37).
- **SV1:** starts open, as the firmware opens every valve at boot. Closing it is
  **rejected with `last_open_valve`** unless the command has `force: true`, because SV1 is
  the only valve.
- **Duplicate commands** (same `id`) get the same ack again without acting twice.
- **Leak indicator:** it subscribes to `indicator` and prints each message, where the real
  node would switch its red and green LEDs.
- **Offline:** while offline it keeps counting, so `seq` jumps and the `total` counters
  carry on when it comes back, like a real node after a Wi-Fi drop.

## Using a local broker instead of EMQX

```powershell
dotnet run -- --Mqtt:Host=localhost --Mqtt:Port=1883 --Mqtt:UseTls=false
```
