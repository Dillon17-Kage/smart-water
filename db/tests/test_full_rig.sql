-- Smoke test: simulates 60 s of readings with a 0.8 L/min leak opening in
-- Zone B at t = 30 s, with the whole rig loaded (002 + all db/rig scripts), then checks the mass-balance view finds it and that the
-- constraints reject bad data. Runs in a transaction and rolls back.
\set ON_ERROR_STOP 1
BEGIN;

-- Baselines (all leak points shut). Zone A's sensors read 0.05 L/min apart normally.
INSERT INTO baselines (zone_id, inlet_flow, outlet_flow, flow_offset, inlet_pressure, outlet_pressure, sample_window_s)
SELECT id, 2.0, 1.95, 0.05, 80, 70, 300 FROM zones WHERE code = 'A';
INSERT INTO baselines (zone_id, inlet_flow, outlet_flow, flow_offset, inlet_pressure, outlet_pressure, sample_window_s)
SELECT id, 2.0, 2.0, 0.0, 80, 70, 300 FROM zones WHERE code = 'B';
INSERT INTO baselines (zone_id, inlet_flow, outlet_flow, flow_offset, inlet_pressure, outlet_pressure, sample_window_s)
SELECT id, 2.0, 2.0, 0.0, 80, 70, 300 FROM zones WHERE code = 'C';

-- 60 seconds of readings
INSERT INTO readings (sensor_id, recorded_at, value)
SELECT s.id, ts,
       CASE s.code
         -- design document numbering: F1 trunk, F5 return, F2-F4 inlets, F6-F8 outlets
         WHEN 'F1' THEN 6.0 + CASE WHEN t >= 30 THEN 0.8 ELSE 0 END
         WHEN 'F5' THEN 6.0 - 0.05
         WHEN 'F2' THEN 2.0
         WHEN 'F6' THEN 1.95
         WHEN 'F3' THEN 2.0 + CASE WHEN t >= 30 THEN 0.8 ELSE 0 END
         WHEN 'F7' THEN 2.0
         WHEN 'F4' THEN 2.0
         WHEN 'F8' THEN 2.0
         WHEN 'P1' THEN 90
         WHEN 'P2' THEN 80
         WHEN 'P3' THEN 80 - CASE WHEN t >= 30 THEN 6 ELSE 0 END
         WHEN 'P4' THEN 80
         WHEN 'P5' THEN 20
       END
FROM generate_series(0, 59) t,
     LATERAL (SELECT timestamptz '2026-10-13 08:00:00+00' + t * interval '1 second') g(ts),
     sensors s;

\echo '--- whole network: F1 - F5 before and after (expect 0.05 then 0.85)'
SELECT f1.recorded_at >= '2026-10-13 08:00:30+00' AS after_leak,
       round(avg(f1.value - f5.value)::numeric, 3) AS trunk_minus_return
FROM readings f1
JOIN sensors s1 ON s1.id = f1.sensor_id AND s1.code = 'F1'
JOIN readings f5 ON f5.recorded_at = f1.recorded_at
JOIN sensors s5 ON s5.id = f5.sensor_id AND s5.code = 'F5'
GROUP BY 1 ORDER BY 1;

\echo '--- residual per zone, before (t<30) and after (t>=30): expect only B to jump to 0.800'
SELECT zone_code,
       recorded_at >= '2026-10-13 08:00:30+00' AS after_leak,
       round(avg(residual_flow)::numeric, 3)         AS avg_residual_lpm,
       round(avg(pressure_vs_baseline)::numeric, 1)  AS avg_dp_kpa
FROM v_zone_balance GROUP BY 1, 2 ORDER BY 1, 2;

\echo '--- record the leak, alert and an operator closing SV2'
INSERT INTO users (role_id, username, password_hash)
SELECT id, 'op1', 'x' FROM roles WHERE name = 'operator';
INSERT INTO leak_events (zone_id, status, detected_at, confirmed_at, peak_residual, loss_rate)
SELECT id, 'confirmed', '2026-10-13 08:00:30+00', '2026-10-13 08:00:40+00', 0.8, 0.8 FROM zones WHERE code = 'B';
INSERT INTO alerts (type, severity, message, leak_event_id)
SELECT 'leak', 'critical', 'Leak in Zone B, ~0.8 L/min', id FROM leak_events;
INSERT INTO valve_commands (valve_id, user_id, action)
SELECT v.id, u.id, 'close' FROM valves v, users u WHERE v.code = 'SV2' AND u.username = 'op1';
SELECT z.code zone, l.status, a.type, a.severity, vc.action, vc.status cmd_status
FROM leak_events l JOIN zones z ON z.id = l.zone_id JOIN alerts a ON a.leak_event_id = l.id,
     valve_commands vc;

\echo '--- constraint checks (each should fail)'
\set ON_ERROR_STOP 0
SAVEPOINT s;
INSERT INTO readings (sensor_id, recorded_at, value)
  SELECT id, '2026-10-13 08:00:00+00', 1 FROM sensors WHERE code = 'F1';   -- duplicate MQTT delivery
ROLLBACK TO s;
INSERT INTO leak_events (zone_id, detected_at)
  SELECT id, now() FROM zones WHERE code = 'B';                              -- second open leak in same zone
ROLLBACK TO s;
INSERT INTO alerts (type, severity, message) VALUES ('leak', 'critical', 'no event'); -- leak alert with no event
ROLLBACK TO s;
INSERT INTO sensors (code, node_id, zone_id, type, position, unit, k_factor, min_valid, max_valid)
  SELECT 'F9', 2, z.id, 'flow', 'zone_inlet', 'L/min', 98, 0, 10 FROM zones z WHERE code = 'A'; -- 2nd inlet in zone A
ROLLBACK TO s;
INSERT INTO valve_commands (valve_id, action, status) VALUES (1, 'open', 'rejected'); -- rejected with no reason
ROLLBACK TO s;
INSERT INTO roles (name) VALUES ('superuser');                              -- unknown role
ROLLBACK TO s;
INSERT INTO sensors (code, node_id, zone_id, type, position, unit, k_factor, min_valid, max_valid)
  SELECT 'F9', 1, NULL, 'flow', 'trunk', 'L/min', 98, 0, 10;                 -- second trunk flow sensor
ROLLBACK TO s;

ROLLBACK;
