# MQTT contract (node ↔ backend)

**Version 1.5, 10 Nov 2026.** This is the shared contract between the ESP32 firmware
(`firmware/`) and the backend (`backend/`, plus the simulator in `tools/simulator/`).
Both sides must match it exactly. It's written by the software session from §5.4 of
`docs/hardware-brief.md`. **Neither session edits it without telling the user first.**

## 1. Connection

| Item | Value |
|---|---|
| Broker | EMQX Cloud Serverless, TLS on port **8883**, username + password. The server certificate chains to **DigiCert Global Root G2** (the CA the ESP32 must trust) |
| Node client id | `sw-` + the node name: `sw-node-2`, `sw-node-3`, `sw-node-4` (the `nodes.mqtt_client_id` column) |
| Backend client id | `sw-backend-` + a random suffix |
| Keep-alive | **15 s**. The broker publishes the last will about 1.5 × keep-alive after the node disappears |
| Clean session | `true`. The node subscribes to its `cmd` and `indicator` topics again **after every connect** |
| Last will (LWT) | topic `smartwater/{node}/status`, payload `{"node":"node-2","state":"offline"}`, QoS 1, **retained** |

`{node}` is the node name from the database, e.g. `node-2`. All topics are lower case.

Only one client may use a client id at a time. The simulator also connects as
the real node's id (`sw-node-2` by default), so **run the simulator or that real node, never both.**

## 2. Topics

| Topic | Direction | QoS | Retained | When |
|---|---|---|---|---|
| `smartwater/{node}/readings` | node → backend | 1 (0 accepted) | no | every second |
| `smartwater/{node}/status` | node → backend | 1 | **yes** | on connect, then every 10 s; the LWT on disconnect |
| `smartwater/{node}/cmd` | backend → node | 1 | **never** | when an operator operates a valve |
| `smartwater/{node}/ack` | node → backend | 1 | no | once for every `cmd` received |
| `smartwater/{node}/indicator` | backend → node | 1 | **yes** | when a confirmed leak starts or ends, when the backend connects to the broker, and when a node comes online |

The backend subscribes to `smartwater/+/readings`, `smartwater/+/status` and
`smartwater/+/ack`.

## 3. General rules

- Payloads are UTF-8 JSON objects with **snake_case** keys, less than **1024 bytes**. A
  full three-zone node is about 600 bytes, so PubSubClient needs `setBufferSize(1024)`.
- Times are ISO 8601 UTC with milliseconds and a `Z`, e.g. `2026-10-28T09:15:02.004Z`.
- Sensor and valve codes are the database codes, numbered in order along the water path:

  | Where | Flow in | Flow out | Pressure | Valve | Node | GPIO (in / out / pressure / valve) |
  |---|---|---|---|---|---|---|
  | Trunk | `F1` | | | | node-2 | 4 |
  | Zone A | `F2` | `F3` | `P1` | `SV1` | node-2 | 18 / 19 / 32 / 26 |
  | Zone B | `F4` | `F5` | `P2` | `SV2` | node-3 | 16 / 17 / 33 / 25 |
  | Zone C | `F6` | `F7` | `P3` | `SV3` | node-4 | 5 / 6 / 3 / 7 |
  | Return | | `F8` | | | node-2 | 14 |

  One board per zone: node-2 has Zone A plus F1 and F8, node-3 has Zone B, node-4 has
  Zone C. There is no node-1. node-2 and node-3 are ESP32 boards; node-4 is an ESP32-C3
  SuperMini, which has different pins. Every node has a green and a red LED (§9): GPIO 23
  and 13 on node-2 and node-3, GPIO 10 and 4 on node-4. The C3's ADC reads up to about
  2.5 V at the pin, so P3 tops out at about 580 kPa, well above this rig's pressure.
  This **replaces the design document's numbering**
  (F2/F6/P2 for Zone A) that the hardware brief still uses.
- **The receiver ignores keys it doesn't know.** Fields can be added later without
  breaking the other side. Renaming or removing a field is a contract change.
- Numbers are plain JSON numbers. Integers are sent without a decimal point.

## 4. `readings`: once per second

```json
{
  "node": "node-2",
  "seq": 1842,
  "ts": "2026-10-28T09:15:02.004Z",
  "interval_ms": 1003,
  "flow": [
    {"sensor": "F2", "pulses": 66, "total": 512330},
    {"sensor": "F3", "pulses": 65, "total": 509870}
  ],
  "pressure": [
    {"sensor": "P1", "mv": 851}
  ],
  "valves": [
    {"valve": "SV1", "state": "open"}
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `node` | string | Node name. Must match the topic |
| `seq` | integer ≥ 0 | Message counter. Goes up by 1 per readings message and starts from 0 at boot. A gap means messages were lost; a drop means the node rebooted |
| `ts` | string, **optional** | End of the measuring window, from NTP. **Leave it out** until NTP has synced; the backend then uses the time it received the message |
| `interval_ms` | integer > 0 | Measured length of this window (`millis()` difference), normally about 1000 |
| `flow[].sensor` | string | Flow sensor code |
| `flow[].pulses` | integer ≥ 0 | Pulses counted in this window |
| `flow[].total` | integer ≥ 0 | Cumulative pulses since boot. Never reset while running; starts again from 0 after a reboot |
| `pressure[].sensor` | string | Pressure sensor code |
| `pressure[].mv` | integer | **Sensor** voltage in millivolts, with the resistor divider already undone (12k/22k, so pin mV × 34/22), averaged over the window |
| `valves[].valve` | string | Valve code |
| `valves[].state` | string | `open` or `closed`: the state the node is driving the valve to |

The arrays list every sensor and valve **configured on that node**. An empty array is
allowed.

**How the backend converts** (calibration comes from the `sensors` table, so recalibrating
never needs a reflash):

- flow L/min = `pulses` ÷ (`interval_ms` / 1000) ÷ `k_factor` (default `k_factor` 98)
- pressure kPa = (`mv` / 1000 − `cal_offset`) × `cal_scale` (defaults 0.5 V and
  172.37 kPa/V for the 100 PSI transducer)

**What the backend rejects** (into `rejected_readings`, the rest of the message is still used):

| Reason | When |
|---|---|
| `malformed` | Not JSON, a required field missing or of the wrong type, `node` doesn't match the topic, `interval_ms` ≤ 0 |
| `unknown_sensor` | A sensor code the database doesn't have for this node, or an inactive one |
| `out_of_range` | The converted value is outside the sensor's `min_valid`..`max_valid` |
| `bad_timestamp` | `ts` is more than 5 minutes away from the backend's clock |

## 5. `status`: on connect, every 10 s, and the last will

Online (retained):
```json
{"node":"node-2","state":"online","fw":"0.1.0","mac":"AA:BB:CC:DD:EE:FF",
 "ip":"192.168.43.20","rssi":-61,"uptime_s":3605,"heap":182344,"ntp":true}
```

Offline, published by the broker as the last will (retained):
```json
{"node":"node-2","state":"offline"}
```

| Field | Type | Meaning |
|---|---|---|
| `node` | string | Node name |
| `state` | string | `online` or `offline` |
| `fw` | string | Firmware version, `major.minor.patch` |
| `mac` | string | `WiFi.macAddress()`, upper case with colons |
| `ip` | string | Current IP address |
| `rssi` | integer | Wi-Fi signal strength, dBm |
| `uptime_s` | integer | Seconds since boot |
| `heap` | integer | Free heap, bytes |
| `ntp` | boolean | Whether the clock is synced |

Only `node` and `state` are required. The node publishes the online message **immediately
after every connect**, so the retained offline will is replaced straight away.

**Online/offline in the backend:** any message from a node (readings, status or ack)
counts as a sign of life. The node is marked offline when the last will arrives, or after
`health.heartbeat_timeout_s` (30 s) with no message at all.

## 6. `cmd`: valve command

```json
{"id":"7f3c2a9e-1b4d-4c6e-9f2a-3d5e6f7a8b9c","valve":"SV1","action":"close","force":false}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Command id, a UUID (`valve_commands.correlation_id`). Echoed in the ack |
| `valve` | string | Valve code |
| `action` | string | `open` or `close` |
| `force` | boolean, optional, default `false` | Skip the node's last-open-valve check. The backend sends `true` when its rig-wide interlock has already allowed this close (§8): either other zones stay open, or the operator confirmed **the pump is off** |

## 7. `ack`: reply to every `cmd`, within 5 s

```json
{"id":"7f3c2a9e-1b4d-4c6e-9f2a-3d5e6f7a8b9c","valve":"SV1","result":"done","state":"closed","reason":null}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The `id` from the command. If the command had no readable `id`, send `""` |
| `valve` | string | The `valve` from the command, `""` if missing |
| `result` | string | `done` or `rejected` |
| `state` | string | The valve's state **after** handling the command: `open` or `closed`. For `unknown_valve` send `"unknown"` |
| `reason` | string or `null` | `null` when `done`. When `rejected`, one of the codes below |

| `reason` | When |
|---|---|
| `unknown_valve` | The node has no valve with that code |
| `bad_command` | Not JSON, `id` missing, or `action` isn't `open`/`close` |
| `last_open_valve` | `action` is `close`, `force` isn't `true`, and closing would leave **no valve open on this node** (the pump would dead-head). The check can be switched off in `config.h`, default on |

Rules:

- **Already in that state:** opening an open valve (or closing a closed one) is `done`,
  with no change. The last-open-valve check doesn't apply, because nothing gets closed.
- **Duplicates:** QoS 1 can deliver the same command twice. The node remembers the last
  10 ids. For a repeated id it sends the same ack again and doesn't act twice.
- **Timeout:** if no ack arrives within `valve.confirm_timeout_s` (5 s), the backend
  marks the command `timed_out`.
- The valve state in the next readings message must agree with the ack.

## 8. Valve safety: who checks what

| Layer | Check |
|---|---|
| Web app | Before a close that would leave no zone open, it asks the operator to confirm the pump is **off**, then sends `force: true` to the backend |
| Backend | Refuses a close that would leave fewer open zones than `valve.interlock_min_open_zones` (1), unless the operator confirmed the pump is off. A valve with a close command still waiting for its ack counts as closed, so two closes at once can't both pass. Also refuses commands when the node is offline. A refusal is recorded as a `rejected` command and never sent to the node. Every close it does send carries `force: true` |
| Node | Last-open-valve check on its own valves (§7). It never changes a valve because the broker or backend disappeared, and opens every valve at boot |

Each node has one valve, so the node can't see the other zones and its own check would
refuse every close. Only the backend sees the whole rig, so it decides and sends
`force: true`. The node's check still stops a close that reaches the broker some other
way, e.g. from an MQTT test client that leaves `force` out.

## 9. `indicator`: leak state for the node's LEDs

The leak decision is made in the backend, so a node can't work it out by itself. This
message tells it what to show.

```json
{"leak":true}
```

| Field | Type | Meaning |
|---|---|---|
| `leak` | boolean | `true` while any zone served by this node has a **confirmed** leak. A suspected leak doesn't count. Back to `false` when the leak is resolved |

A node serves a zone if it has one of that zone's sensors or valves, so each node's LEDs
show **its own zone only**: a leak in Zone B turns node-3 red and leaves node-2 and node-4
green. The web app shows the whole rig. F1 and F8 have no zone, so they don't affect this.

The message is **retained**, so the node gets the current state straight after it
subscribes. If the backend misses a change because the broker was unreachable, it publishes
the correct state again when it reconnects.

| Node LEDs | When |
|---|---|
| Green | `leak` is `false` |
| Red | `leak` is `true` |
| Both off | No MQTT connection, or no `indicator` message received yet |

The LEDs only report. The node never moves a valve because of this message.

## 10. Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 1 Nov 2026 | First version, from hardware brief §5.4 |
| 1.1 | 1 Nov 2026 | Sensors renumbered along the water path: Zone A is now F2 (in), **F3** (out), **P1** (pressure). Message format unchanged |
| 1.2 | 1 Nov 2026 | Broker moved from HiveMQ Cloud Serverless (retired, no new clusters) to EMQX Cloud Serverless. Only §1 changed: host and TLS root CA. Topics and messages unchanged |
| 1.3 | 5 Nov 2026 | New retained `indicator` topic (backend → node) so a node can show the confirmed leak state on a red and a green LED. Existing messages unchanged |
| 1.4 | 5 Nov 2026 | F1 and F8 moved from node-1 to node-2 (GPIO 4 and 14). There is no node-1 on the rig being built. Pressure divider corrected to 12k/22k (pin mV × 34/22). Message format unchanged |
| 1.5 | 10 Nov 2026 | One board per zone: Zone B moves to node-3, Zone C to node-4. node-4 is an ESP32-C3, so Zone C's pins change to F6 GPIO 5, F7 6, P3 3, SV3 7 (LEDs 10 and 4). Because each node now has one valve, the backend sends `force: true` whenever its rig-wide interlock allows the close (§6, §8). Message format unchanged |
