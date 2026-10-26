import type { Baseline, DetectionSettings, MonitoringNode, RoleName, Sensor, Valve, Zone } from '../../types';

/**
 * The rig as seeded in db/002_seed.sql and the db/rig/ scripts, numbered as in
 * the design document:
 *   F1 trunk, F5 return, F2-F4 zone inlets (A-C), F6-F8 zone outlets (A-C)
 *   P1 trunk, P2-P4 zone inlets (A-C), P5 return
 *   node-1 at the tank, node-2 Zones A+B (SV1, SV2), node-3 Zone C (SV3)
 *
 * VITE_SIM_STAGE picks how much of it exists, so the simulator matches the bench:
 *   zone-a    (default) Zone A only: F2, F6, P2, SV1 on node-2, bypass protects the pump
 *   two-zone  + Zone B: F3, F7, P3, SV2 on node-2
 *   full      + Zone C on node-3, + node-1 with F1, F5, P1, P5; valve interlock on
 */
export type RigStage = 'zone-a' | 'two-zone' | 'full';

const requested = import.meta.env.VITE_SIM_STAGE;
export const stage: RigStage = requested === 'two-zone' || requested === 'full' ? requested : 'zone-a';

const rank: Record<RigStage, number> = { 'zone-a': 0, 'two-zone': 1, full: 2 };
const builtBy = (needed: RigStage) => rank[stage] >= rank[needed];

export const zones: Zone[] = [
  { id: 1, code: 'A', name: 'Zone A', active: true },
  { id: 2, code: 'B', name: 'Zone B', active: builtBy('two-zone') },
  { id: 3, code: 'C', name: 'Zone C', active: builtBy('full') },
];

const allNodes: (MonitoringNode & { stage: RigStage })[] = [
  { id: 1, name: 'node-1', macAddress: '02:00:00:00:00:01', mqttClientId: 'sw-node-1', status: 'online', lastSeen: null, stage: 'full' },
  { id: 2, name: 'node-2', macAddress: '02:00:00:00:00:02', mqttClientId: 'sw-node-2', status: 'online', lastSeen: null, stage: 'zone-a' },
  { id: 3, name: 'node-3', macAddress: '02:00:00:00:00:03', mqttClientId: 'sw-node-3', status: 'online', lastSeen: null, stage: 'full' },
];
export const nodes: MonitoringNode[] = allNodes.filter((n) => builtBy(n.stage)).map(({ stage: _s, ...n }) => n);

type SensorDef = Sensor & { stage: RigStage };
const flow = (id: number, code: string, nodeId: number, zoneId: number | null, position: Sensor['position'], s: RigStage): SensorDef => ({
  id, code, nodeId, zoneId, type: 'flow', position, unit: 'L/min', minValid: 0, maxValid: 10, stage: s,
});
const pressure = (id: number, code: string, nodeId: number, zoneId: number | null, position: Sensor['position'], s: RigStage): SensorDef => ({
  id, code, nodeId, zoneId, type: 'pressure', position, unit: 'kPa', minValid: -20, maxValid: 700, stage: s,
});

const allSensors: SensorDef[] = [
  flow(1, 'F1', 1, null, 'trunk', 'full'),
  flow(2, 'F2', 2, 1, 'zone_inlet', 'zone-a'),
  flow(3, 'F3', 2, 2, 'zone_inlet', 'two-zone'),
  flow(4, 'F4', 3, 3, 'zone_inlet', 'full'),
  flow(5, 'F5', 1, null, 'return', 'full'),
  flow(6, 'F6', 2, 1, 'zone_outlet', 'zone-a'),
  flow(7, 'F7', 2, 2, 'zone_outlet', 'two-zone'),
  flow(8, 'F8', 3, 3, 'zone_outlet', 'full'),
  pressure(9, 'P1', 1, null, 'trunk', 'full'),
  pressure(10, 'P2', 2, 1, 'zone_inlet', 'zone-a'),
  pressure(11, 'P3', 2, 2, 'zone_inlet', 'two-zone'),
  pressure(12, 'P4', 3, 3, 'zone_inlet', 'full'),
  pressure(13, 'P5', 1, null, 'return', 'full'),
];
export const sensors: Sensor[] = allSensors.filter((s) => builtBy(s.stage)).map(({ stage: _s, ...s }) => s);

const allValves: (Valve & { stage: RigStage })[] = [
  { id: 1, code: 'SV1', nodeId: 2, zoneId: 1, state: 'open', stage: 'zone-a' },
  { id: 2, code: 'SV2', nodeId: 2, zoneId: 2, state: 'open', stage: 'two-zone' },
  { id: 3, code: 'SV3', nodeId: 3, zoneId: 3, state: 'open', stage: 'full' },
];
export const valves: Valve[] = allValves.filter((v) => builtBy(v.stage)).map(({ stage: _s, ...v }) => v);

// Realistic for YF-S401 sensors at ~0.7 L/min per zone and ~60 kPa at the zone inlets.
const allBaselines: Baseline[] = [
  { zoneId: 1, inletFlow: 0.7, outletFlow: 0.67, flowOffset: 0.03, inletPressure: 60 },
  { zoneId: 2, inletFlow: 0.68, outletFlow: 0.66, flowOffset: 0.02, inletPressure: 58 },
  { zoneId: 3, inletFlow: 0.66, outletFlow: 0.62, flowOffset: 0.04, inletPressure: 57 },
];
export const baselines: Baseline[] = allBaselines.filter((b) => zones.find((z) => z.id === b.zoneId)?.active);

/** Same values as the settings table in db/002_seed.sql. */
export const settings: DetectionSettings = {
  residualThreshold: 0.3,
  confirmSeconds: 10,
  clearSeconds: 10,
  heartbeatTimeoutSeconds: 30,
  // 0 while the bypass protects the pump; db/rig/20_zone_c.sql sets it to 1.
  interlockMinOpenZones: builtBy('full') ? 1 : 0,
};

export const TRUNK_PRESSURE = 70;
export const RETURN_PRESSURE = 4;

/** Demo accounts, one per role. Password for all: smartwater */
export const demoUsers: { id: number; username: string; fullName: string; role: RoleName }[] = [
  { id: 1, username: 'admin', fullName: 'System Administrator', role: 'administrator' },
  { id: 2, username: 'operator', fullName: 'Network Operator', role: 'operator' },
  { id: 3, username: 'tech', fullName: 'Field Technician', role: 'technician' },
  { id: 4, username: 'engineer', fullName: 'Network Engineer', role: 'engineer' },
];
export const DEMO_PASSWORD = 'smartwater';
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;
