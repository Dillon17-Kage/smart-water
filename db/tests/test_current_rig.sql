-- Smoke test for the rig as built now (002_seed.sql only: Zone A on node-2).
-- 60 s of readings with a 0.4 L/min leak opening in Zone A at t = 30 s.
-- Runs in a transaction and rolls back.
\set ON_ERROR_STOP 1
BEGIN;

-- Baseline (drain cock shut): the two sensors read 0.03 L/min apart normally.
INSERT INTO baselines (zone_id, inlet_flow, outlet_flow, flow_offset, inlet_pressure, outlet_pressure, sample_window_s)
SELECT id, 0.70, 0.67, 0.03, 60, 50, 60 FROM zones WHERE code = 'A';

INSERT INTO readings (sensor_id, recorded_at, value)
SELECT s.id, timestamptz '2026-10-22 08:00:00+00' + t * interval '1 second',
       CASE s.code
         WHEN 'F2' THEN 0.70 + CASE WHEN t >= 30 THEN 0.10 ELSE 0 END   -- leaking zone draws a little more
         WHEN 'F6' THEN 0.67 + CASE WHEN t >= 30 THEN 0.10 - 0.40 ELSE 0 END  -- 0.4 L/min leaves via the drain cock
         WHEN 'P2' THEN 60 - CASE WHEN t >= 30 THEN 8 ELSE 0 END
       END
FROM generate_series(0, 59) t, sensors s;

\echo '--- Zone A residual before (t<30) and after (t>=30): expect 0.000 then 0.400'
SELECT zone_code,
       recorded_at >= '2026-10-22 08:00:30+00' AS after_leak,
       round(avg(residual_flow)::numeric, 3)        AS avg_residual_lpm,
       round(avg(pressure_vs_baseline)::numeric, 1) AS avg_dp_kpa
FROM v_zone_balance GROUP BY 1, 2 ORDER BY 1, 2;

\echo '--- only active zones appear in the balance view: expect A only'
SELECT DISTINCT zone_code FROM v_zone_balance;

\echo '--- interlock setting for the one-zone rig: expect 0'
SELECT value FROM settings WHERE key = 'valve.interlock_min_open_zones';

ROLLBACK;
