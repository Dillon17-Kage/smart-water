// Types that mirror the PostgreSQL schema (001_schema.sql).
// Column names are snake_case in the database; the ASP.NET Core API
// serialises them as camelCase JSON, which is what these types describe.
// Timestamps are ISO 8601 strings in UTC.

export type RoleName = 'administrator' | 'operator' | 'technician' | 'engineer';

export interface User {
  id: number;
  username: string;
  fullName: string | null;
  role: RoleName;
}

export interface Zone {
  id: number;
  code: string; // 'A' | 'B' | 'C'
  name: string;
  active: boolean;
}

export type NodeStatus = 'online' | 'offline';

export interface MonitoringNode {
  id: number;
  name: string; // node-1, node-2 ...
  macAddress: string;
  mqttClientId: string;
  status: NodeStatus;
  lastSeen: string | null;
}

export type SensorType = 'flow' | 'pressure';
export type SensorPosition = 'trunk' | 'return' | 'zone_inlet' | 'zone_outlet';

export interface Sensor {
  id: number;
  code: string; // F1 trunk, F5 return, F2-F4 inlets, F6-F8 outlets, P1-P5
  nodeId: number;
  zoneId: number | null; // null for trunk / return
  type: SensorType;
  position: SensorPosition;
  unit: 'L/min' | 'kPa';
  minValid: number;
  maxValid: number;
}

export type ValveState = 'open' | 'closed' | 'unknown';

export interface Valve {
  id: number;
  code: string; // SV1-SV3
  nodeId: number;
  zoneId: number;
  state: ValveState;
}

export interface Baseline {
  zoneId: number;
  inletFlow: number;
  outletFlow: number;
  flowOffset: number; // normal inlet - outlet mismatch of the two sensors
  inletPressure: number;
}

/** Thresholds from the `settings` table. */
export interface DetectionSettings {
  residualThreshold: number; // L/min
  confirmSeconds: number;
  clearSeconds: number;
  heartbeatTimeoutSeconds: number;
  /** A close command is refused if it would leave fewer open zones than this (0 = interlock off). */
  interlockMinOpenZones: number;
}

export interface Reading {
  sensorId: number;
  recordedAt: string;
  value: number;
}

export type LeakStatus = 'suspected' | 'confirmed' | 'resolved' | 'false_alarm';

export interface LeakEvent {
  id: number;
  zoneId: number | null;
  status: LeakStatus;
  detectedAt: string;
  confirmedAt: string | null;
  resolvedAt: string | null;
  peakResidual: number;
  lossRate: number; // L/min
  volumeLost: number; // litres
  pressureDrop: number; // kPa against baseline
}

export type AlertType = 'leak' | 'node_offline' | 'sensor_fault' | 'valve_failure';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export interface Alert {
  id: number;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  leakEventId: number | null;
  nodeId: number | null;
  sensorId: number | null;
  valveId: number | null;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null; // username
  resolvedAt: string | null;
}

export type ValveAction = 'open' | 'close';
export type CommandStatus = 'pending' | 'sent' | 'confirmed' | 'timed_out' | 'rejected';

export interface ValveCommand {
  id: number;
  valveId: number;
  issuedBy: string | null; // username, null = issued automatically
  action: ValveAction;
  status: CommandStatus;
  rejectReason: string | null;
  correlationId: string;
  issuedAt: string;
  sentAt: string | null;
  confirmedAt: string | null;
}

/** Everything that describes the physical rig, loaded once after login. */
export interface Rig {
  zones: Zone[];
  nodes: MonitoringNode[];
  sensors: Sensor[];
  valves: Valve[];
  baselines: Baseline[];
  settings: DetectionSettings;
}

/** Per-zone mass balance at one moment (the v_zone_balance view). */
export interface ZoneBalance {
  zoneId: number;
  inletFlow: number;
  outletFlow: number;
  residual: number; // inlet - outlet - flowOffset
  inletPressure: number;
  pressureDelta: number; // against baseline
}
