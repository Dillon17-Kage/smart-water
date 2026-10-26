-- =====================================================================
-- Smart Water: IoT water distribution monitoring and leak detection
-- PostgreSQL 16+ schema (runs on Neon)
--
-- Sensor and node numbering follows the approved design document:
--   F1 trunk, F5 return, F2-F4 zone inlets (A-C), F6-F8 zone outlets (A-C)
--   P1 trunk, P2-P4 zone inlets (A-C), P5 return
--   node-1 at the tank, node-2 Zones A+B (SV1, SV2), node-3 Zone C (SV3)
--
-- Based on the ERD in the design document (Fig 8.3), updated for:
--   * per-zone mass balance (flow sensor at the inlet AND outlet of each zone)
--   * a valves table, so the control service knows which node drives which valve
--   * alerts that can come from a leak OR from a node going offline
--
-- Conventions
--   * snake_case names (use EFCore.NamingConventions -> UseSnakeCaseNamingConvention())
--   * text + CHECK constraints instead of Postgres enums (simpler with EF Core)
--   * every timestamp is timestamptz, stored in UTC
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------
CREATE TABLE roles (
    id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL UNIQUE
                CHECK (name IN ('administrator', 'operator', 'technician', 'engineer'))
);

CREATE TABLE users (
    id                  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id             smallint NOT NULL REFERENCES roles(id),
    username            text NOT NULL UNIQUE,
    full_name           text,
    password_hash       text NOT NULL,              -- ASP.NET Core Identity / BCrypt hash, never plain text
    active              boolean NOT NULL DEFAULT true,
    failed_logins       smallint NOT NULL DEFAULT 0, -- login activity diagram: "too many attempts?"
    locked_until        timestamptz,
    last_login_at       timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Configuration: the physical rig
-- ---------------------------------------------------------------------
CREATE TABLE zones (
    id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        text NOT NULL UNIQUE,               -- 'A', 'B', 'C'
    name        text NOT NULL,
    active      boolean NOT NULL DEFAULT true       -- lets Zone C be added later without schema changes
);

CREATE TABLE nodes (
    id                      smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                    text NOT NULL UNIQUE,   -- 'node-1'
    mac_address             macaddr NOT NULL UNIQUE,
    mqtt_client_id          text NOT NULL UNIQUE,
    firmware_version        text,
    heartbeat_interval_s    smallint NOT NULL DEFAULT 10,
    status                  text NOT NULL DEFAULT 'unknown'
                            CHECK (status IN ('online', 'offline', 'unknown', 'maintenance')),
    last_seen               timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now()
);

-- position tells the detection service what a sensor measures:
--   trunk        = network supply leaving the pump  (whole-network reconciliation)
--   return       = water returning to the tank       (whole-network reconciliation)
--   zone_inlet   = flow/pressure entering a zone     (per-zone mass balance)
--   zone_outlet  = flow/pressure leaving a zone      (per-zone mass balance)
CREATE TABLE sensors (
    id              smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code            text NOT NULL UNIQUE,           -- 'F1', 'P1' ... matches the rig labels
    node_id         smallint NOT NULL REFERENCES nodes(id),
    zone_id         smallint REFERENCES zones(id),  -- NULL for trunk / return
    type            text NOT NULL CHECK (type IN ('flow', 'pressure')),
    position        text NOT NULL CHECK (position IN ('trunk', 'return', 'zone_inlet', 'zone_outlet')),
    unit            text NOT NULL,                  -- 'L/min' or 'kPa'
    gpio_pin        smallint,
    -- calibration: flow  -> value = pulses_per_s / k_factor
    --              pressure -> value = (volts - offset) * scale
    --   YF-S401: 5880 pulses/L, so k_factor = 5880 / 60 = 98 (Hz per L/min).
    --   Calibration adjusts each outlet sensor's k_factor so it agrees with its inlet.
    k_factor        double precision,               -- pulses per (L/min), flow only
    cal_offset      double precision NOT NULL DEFAULT 0,
    cal_scale       double precision NOT NULL DEFAULT 1,
    min_valid       double precision NOT NULL,      -- ingestion rejects readings outside this range
    max_valid       double precision NOT NULL,
    active          boolean NOT NULL DEFAULT true,

    CHECK (min_valid < max_valid),
    CHECK (type <> 'flow' OR k_factor IS NOT NULL AND k_factor > 0),
    CHECK ((position IN ('trunk', 'return')) = (zone_id IS NULL)),
    CHECK ((type = 'flow' AND unit = 'L/min') OR (type = 'pressure' AND unit = 'kPa'))
);

-- One inlet + one outlet of each type per zone; one trunk and one return of each type
CREATE UNIQUE INDEX ux_sensors_zone_slot
    ON sensors (zone_id, type, position) WHERE zone_id IS NOT NULL AND active;
CREATE UNIQUE INDEX ux_sensors_network_slot
    ON sensors (type, position) WHERE zone_id IS NULL AND active;

CREATE TABLE valves (
    id              smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code            text NOT NULL UNIQUE,           -- 'SV1'
    node_id         smallint NOT NULL REFERENCES nodes(id),
    zone_id         smallint NOT NULL REFERENCES zones(id),
    gpio_pin        smallint,
    normally_closed boolean NOT NULL DEFAULT true,
    state           text NOT NULL DEFAULT 'unknown'
                    CHECK (state IN ('open', 'closed', 'unknown')),
    state_changed_at timestamptz
);

-- Calibration baselines, recorded with all leak points shut.
-- Mass balance: in a healthy zone inlet - outlet should be ~0, but two cheap
-- hall-effect sensors never agree exactly. flow_offset is that normal mismatch;
-- detection subtracts it before comparing against the threshold.
-- Only one baseline per zone is "current"; old ones are kept for the report.
CREATE TABLE baselines (
    id                      int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    zone_id                 smallint NOT NULL REFERENCES zones(id),
    inlet_flow              double precision NOT NULL,  -- L/min
    outlet_flow             double precision NOT NULL,  -- L/min
    flow_offset             double precision NOT NULL,  -- mean(inlet - outlet) over the baseline window
    flow_offset_stddev      double precision NOT NULL DEFAULT 0,
    inlet_pressure          double precision NOT NULL,  -- kPa
    outlet_pressure         double precision NOT NULL,  -- kPa
    sample_window_s         int NOT NULL,
    recorded_at             timestamptz NOT NULL DEFAULT now(),
    recorded_by             int REFERENCES users(id),
    is_current              boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX ux_baselines_current ON baselines (zone_id) WHERE is_current;

-- Detection thresholds live in the database so they can be tuned from the
-- admin screen without redeploying.
CREATE TABLE settings (
    key         text PRIMARY KEY,
    value       text NOT NULL,
    description text,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  int REFERENCES users(id)
);

-- ---------------------------------------------------------------------
-- Readings: one row per sensor per second
-- ---------------------------------------------------------------------
-- The rig only runs during testing and presentations, so volume is modest:
-- the full 13-sensor rig adds ~47k rows (~5 MB) per hour of running.
-- (sensor_id, recorded_at) is the key, which also stops duplicate MQTT
-- deliveries (QoS 1) and avoids a separate id column and index per row.
CREATE TABLE readings (
    sensor_id       smallint NOT NULL REFERENCES sensors(id),
    recorded_at     timestamptz NOT NULL,           -- timestamp from the node (NTP-synced)
    received_at     timestamptz NOT NULL DEFAULT now(),
    value           double precision NOT NULL,      -- engineering units (L/min or kPa)
    raw_value       double precision,               -- pulse count or sensor volts, for re-calibration
    PRIMARY KEY (sensor_id, recorded_at)
);
CREATE INDEX ix_readings_recorded_at ON readings USING brin (recorded_at);

-- Rejected messages from ingestion (activity diagram 10.3, P6)
CREATE TABLE rejected_readings (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    received_at     timestamptz NOT NULL DEFAULT now(),
    topic           text NOT NULL,
    payload         jsonb NOT NULL,
    reason          text NOT NULL CHECK (reason IN
                    ('unknown_sensor', 'out_of_range', 'bad_timestamp', 'malformed'))
);

-- ---------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------
CREATE TABLE leak_events (
    id                  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    zone_id             smallint REFERENCES zones(id),  -- NULL = network-level loss not yet located
    status              text NOT NULL DEFAULT 'suspected'
                        CHECK (status IN ('suspected', 'confirmed', 'resolved', 'false_alarm')),
    detected_at         timestamptz NOT NULL,           -- residual first went over threshold
    confirmed_at        timestamptz,                    -- confirmation period elapsed
    resolved_at         timestamptz,
    peak_residual       double precision,               -- L/min, worst (inlet - outlet - offset)
    loss_rate           double precision,               -- L/min, current estimate
    volume_lost         double precision NOT NULL DEFAULT 0,  -- litres, integrated over the event
    pressure_drop       double precision,               -- kPa below baseline at the inlet
    baseline_id         int REFERENCES baselines(id),   -- which baseline it was judged against
    notes               text,

    CHECK (confirmed_at IS NULL OR confirmed_at >= detected_at),
    CHECK (resolved_at  IS NULL OR resolved_at  >= detected_at),
    CHECK (status <> 'confirmed' OR confirmed_at IS NOT NULL),
    CHECK (status NOT IN ('resolved', 'false_alarm') OR resolved_at IS NOT NULL)
);
-- At most one open leak per zone (the alert diagram: "matching alert open?")
CREATE UNIQUE INDEX ux_leak_events_open
    ON leak_events (COALESCE(zone_id, 0)) WHERE status IN ('suspected', 'confirmed');
CREATE INDEX ix_leak_events_detected ON leak_events (detected_at DESC);

CREATE TABLE alerts (
    id                  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type                text NOT NULL CHECK (type IN
                        ('leak', 'node_offline', 'sensor_fault', 'valve_failure')),
    severity            text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    status              text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'acknowledged', 'resolved')),
    message             text NOT NULL,
    leak_event_id       int REFERENCES leak_events(id),
    node_id             smallint REFERENCES nodes(id),
    sensor_id           smallint REFERENCES sensors(id),
    valve_id            smallint REFERENCES valves(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    acknowledged_at     timestamptz,
    acknowledged_by     int REFERENCES users(id),
    resolved_at         timestamptz,

    CHECK (type <> 'leak'          OR leak_event_id IS NOT NULL),
    CHECK (type <> 'node_offline'  OR node_id       IS NOT NULL),
    CHECK (type <> 'sensor_fault'  OR sensor_id     IS NOT NULL),
    CHECK (type <> 'valve_failure' OR valve_id      IS NOT NULL),
    CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
    CHECK (status = 'open' OR acknowledged_at IS NOT NULL OR resolved_at IS NOT NULL)
);
CREATE INDEX ix_alerts_open ON alerts (created_at DESC) WHERE status <> 'resolved';

-- Valve commands follow activity diagram 10.6:
--   rejected  = failed a gate (role / node offline / interlock) before sending
--   pending   -> sent -> confirmed | timed_out
CREATE TABLE valve_commands (
    id                  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    valve_id            smallint NOT NULL REFERENCES valves(id),
    user_id             int REFERENCES users(id),       -- NULL = issued automatically by detection
    action              text NOT NULL CHECK (action IN ('open', 'close')),
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'confirmed', 'timed_out', 'rejected')),
    reject_reason       text,
    correlation_id      uuid NOT NULL DEFAULT gen_random_uuid(),  -- echoed back by the node in its ack
    issued_at           timestamptz NOT NULL DEFAULT now(),
    sent_at             timestamptz,
    confirmed_at        timestamptz,

    CHECK ((status = 'rejected') = (reject_reason IS NOT NULL))
);
CREATE UNIQUE INDEX ux_valve_commands_correlation ON valve_commands (correlation_id);
CREATE INDEX ix_valve_commands_valve ON valve_commands (valve_id, issued_at DESC);

CREATE TABLE maintenance (
    id                  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id             smallint REFERENCES nodes(id),
    sensor_id           smallint REFERENCES sensors(id),
    valve_id            smallint REFERENCES valves(id),
    performed_by        int REFERENCES users(id),
    kind                text NOT NULL CHECK (kind IN
                        ('inspection', 'calibration', 'repair', 'replacement', 'cleaning')),
    description         text NOT NULL,
    performed_at        timestamptz NOT NULL DEFAULT now(),

    CHECK (num_nonnulls(node_id, sensor_id, valve_id) >= 1)
);

-- ---------------------------------------------------------------------
-- Views used by the detection service and the dashboard
-- ---------------------------------------------------------------------

-- Latest value of every sensor (dashboard tiles, schematic view)
CREATE VIEW v_latest_readings AS
SELECT DISTINCT ON (s.id)
       s.id AS sensor_id, s.code, s.type, s.position, s.unit,
       z.code AS zone_code, r.value, r.recorded_at
FROM sensors s
LEFT JOIN zones z ON z.id = s.zone_id
LEFT JOIN readings r ON r.sensor_id = s.id
WHERE s.active
ORDER BY s.id, r.recorded_at DESC;

-- Per-zone mass balance per second: residual = inlet - outlet - baseline offset.
-- A sustained positive residual means water is leaving the zone somewhere else.
CREATE VIEW v_zone_balance AS
SELECT z.id   AS zone_id,
       z.code AS zone_code,
       fi.recorded_at,
       fi.value AS inlet_flow,
       fo.value AS outlet_flow,
       pi.value AS inlet_pressure,
       fi.value - fo.value - COALESCE(b.flow_offset, 0) AS residual_flow,
       pi.value - b.inlet_pressure                       AS pressure_vs_baseline
FROM zones z
JOIN sensors sfi ON sfi.zone_id = z.id AND sfi.type = 'flow'     AND sfi.position = 'zone_inlet'  AND sfi.active
JOIN sensors sfo ON sfo.zone_id = z.id AND sfo.type = 'flow'     AND sfo.position = 'zone_outlet' AND sfo.active
LEFT JOIN sensors spi ON spi.zone_id = z.id AND spi.type = 'pressure' AND spi.position = 'zone_inlet' AND spi.active
JOIN readings fi ON fi.sensor_id = sfi.id
JOIN readings fo ON fo.sensor_id = sfo.id AND fo.recorded_at = fi.recorded_at
LEFT JOIN readings pi ON pi.sensor_id = spi.id AND pi.recorded_at = fi.recorded_at
LEFT JOIN baselines b ON b.zone_id = z.id AND b.is_current
WHERE z.active;

COMMIT;
