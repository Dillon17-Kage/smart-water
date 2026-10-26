import type { Frame } from '../state/LiveDataContext';
import type { LeakEvent, MonitoringNode, Reading, Rig, Sensor, Valve, Zone, ZoneBalance } from '../types';

/** A reading older than this is shown as stale. */
export const STALE_MS = 5000;

export function sensorByCode(rig: Rig, code: string): Sensor | undefined {
  return rig.sensors.find((s) => s.code === code);
}

export interface ZoneSensors {
  inlet?: Sensor;
  outlet?: Sensor;
  pressure?: Sensor;
}

export function zoneSensors(rig: Rig, zoneId: number): ZoneSensors {
  const inZone = rig.sensors.filter((s) => s.zoneId === zoneId);
  return {
    inlet: inZone.find((s) => s.type === 'flow' && s.position === 'zone_inlet'),
    outlet: inZone.find((s) => s.type === 'flow' && s.position === 'zone_outlet'),
    pressure: inZone.find((s) => s.type === 'pressure'),
  };
}

export function networkSensors(rig: Rig) {
  return {
    trunk: rig.sensors.find((s) => s.type === 'flow' && s.position === 'trunk'), // F1
    ret: rig.sensors.find((s) => s.type === 'flow' && s.position === 'return'), // F5
    pressure: rig.sensors.find((s) => s.type === 'pressure' && s.position === 'trunk'), // P1
    returnPressure: rig.sensors.find((s) => s.type === 'pressure' && s.position === 'return'), // P5
  };
}

/**
 * Network supply and return. Uses F1 and F5 when node-1 is fitted; until then
 * they are the sum of the zone inlets and outlets, which is the same water.
 */
export function networkFlows(rig: Rig, values: Record<number, number | undefined>) {
  const net = networkSensors(rig);
  const zoneIds = rig.zones.filter((z) => z.active).map((z) => z.id);
  const sum = (position: 'zone_inlet' | 'zone_outlet') => {
    let total = 0;
    for (const zoneId of zoneIds) {
      const sensor = zoneSensors(rig, zoneId)[position === 'zone_inlet' ? 'inlet' : 'outlet'];
      const v = sensor ? values[sensor.id] : undefined;
      if (v === undefined) return null;
      total += v;
    }
    return zoneIds.length ? total : null;
  };
  const measured = (id?: number) => (id === undefined ? null : (values[id] ?? null));
  return {
    supply: net.trunk ? measured(net.trunk.id) : sum('zone_inlet'),
    ret: net.ret ? measured(net.ret.id) : sum('zone_outlet'),
    supplyLabel: net.trunk ? `Supply (${net.trunk.code})` : 'Supply',
    returnLabel: net.ret ? `Return (${net.ret.code})` : 'Return',
    measured: !!(net.trunk && net.ret),
  };
}

/** Latest fresh value of every sensor, by sensor id. */
export function freshValues(latest: Record<number, Reading>, now = Date.now()): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [id, reading] of Object.entries(latest)) if (isFresh(reading, now)) out[Number(id)] = reading.value;
  return out;
}

export function isFresh(reading: Reading | undefined, now = Date.now()): reading is Reading {
  return !!reading && now - Date.parse(reading.recordedAt) < STALE_MS;
}

/** Same arithmetic as the v_zone_balance view. Null when a sensor is missing or stale. */
export function zoneBalance(rig: Rig, zoneId: number, latest: Record<number, Reading>): ZoneBalance | null {
  const { inlet, outlet, pressure } = zoneSensors(rig, zoneId);
  const baseline = rig.baselines.find((b) => b.zoneId === zoneId);
  if (!inlet || !outlet || !baseline) return null;
  const i = latest[inlet.id];
  const o = latest[outlet.id];
  if (!isFresh(i) || !isFresh(o)) return null;
  const p = pressure ? latest[pressure.id] : undefined;
  const pValue = isFresh(p) ? p.value : NaN;
  return {
    zoneId,
    inletFlow: i.value,
    outletFlow: o.value,
    residual: i.value - o.value - baseline.flowOffset,
    inletPressure: pValue,
    pressureDelta: pValue - baseline.inletPressure,
  };
}

/** Residual for one zone at one historical second (for charts). */
export function frameResidual(rig: Rig, zoneId: number, frame: Frame): number | null {
  const { inlet, outlet } = zoneSensors(rig, zoneId);
  const baseline = rig.baselines.find((b) => b.zoneId === zoneId);
  if (!inlet || !outlet || !baseline) return null;
  const i = frame.values[inlet.id];
  const o = frame.values[outlet.id];
  if (i === undefined || o === undefined) return null;
  return i - o - baseline.flowOffset;
}

export type ZoneStatus = 'normal' | 'suspected' | 'leak' | 'isolated' | 'offline' | 'inactive';

export function openLeakFor(zoneId: number, leakEvents: LeakEvent[]): LeakEvent | undefined {
  return leakEvents.find((e) => e.zoneId === zoneId && (e.status === 'suspected' || e.status === 'confirmed'));
}

export function zoneStatus(
  rig: Rig,
  zone: Zone,
  valves: Valve[],
  nodes: MonitoringNode[],
  leakEvents: LeakEvent[],
): ZoneStatus {
  if (!zone.active) return 'inactive';
  const leak = openLeakFor(zone.id, leakEvents);
  const valve = valves.find((v) => v.zoneId === zone.id);
  if (valve?.state === 'closed') return 'isolated';
  if (leak?.status === 'confirmed') return 'leak';
  if (leak?.status === 'suspected') return 'suspected';
  const { inlet } = zoneSensors(rig, zone.id);
  const node = nodes.find((n) => n.id === inlet?.nodeId);
  if (node?.status === 'offline') return 'offline';
  return 'normal';
}
