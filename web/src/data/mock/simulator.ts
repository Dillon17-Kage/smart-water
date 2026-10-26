import type {
  Alert,
  AlertSeverity,
  AlertType,
  LeakEvent,
  MonitoringNode,
  Reading,
  Valve,
  ValveAction,
  ValveCommand,
} from '../../types';
import type { LiveEvent } from '../source';
import * as rig from './rig';

/**
 * In-browser stand-in for the whole backend: the rig's hydraulics, the
 * ESP32 nodes, ingestion, the detection service, the alert service and the
 * control service. It publishes the same events the SignalR hub will.
 *
 * Sensors are found by their position (zone_inlet, zone_outlet, trunk,
 * return), never by code, so the same code works for every rig stage.
 *
 * Hydraulic model (deliberately simple, matching the design document):
 *   - a leak of L L/min in a zone escapes between its inlet and outlet sensors,
 *     so inlet - outlet - flowOffset ~= L; the zone also draws a little more
 *   - the leaking zone's inlet pressure falls, other zones drop slightly
 *   - a closed zone valve stops all flow (and any leak) in that zone; the
 *     surplus goes to the other zones or the bypass
 *   - F1 (trunk) = sum of zone inlets, F5 (return) = sum of zone outlets
 */

const HISTORY_SECONDS = 15 * 60;
const PREFILL_SECONDS = 10 * 60;

interface ZoneDetector {
  aboveSince: number | null;
  belowSince: number | null;
  event: LeakEvent | null;
  alert: Alert | null;
}

const noise = (amplitude: number) => (Math.random() * 2 - 1) * amplitude;
const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const iso = (ms: number) => new Date(ms).toISOString();

export class RigSimulator {
  // --- what the simulator controls (the "real world") ---
  private leaks = new Map<number, number>(); // zoneId -> true leak rate L/min
  private forcedOffline = new Set<number>(); // nodeIds unplugged by the user

  // --- what the backend would store ---
  readonly nodes: MonitoringNode[] = rig.nodes.map((n) => ({ ...n }));
  readonly valves: Valve[] = rig.valves.map((v) => ({ ...v }));
  private history: Reading[] = [];
  private alerts: Alert[] = [];
  private leakEvents: LeakEvent[] = [];
  private commands: ValveCommand[] = [];
  private detectors = new Map<number, ZoneDetector>();

  private nextAlertId = 1;
  private nextEventId = 1;
  private nextCommandId = 1;

  private listeners = new Set<(event: LiveEvent) => void>();
  private controlListeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    for (const zone of rig.zones.filter((z) => z.active)) {
      this.detectors.set(zone.id, { aboveSince: null, belowSince: null, event: null, alert: null });
    }
    // Pre-fill ten minutes of quiet history so the charts aren't empty on first load.
    const now = Date.now();
    for (let t = now - PREFILL_SECONDS * 1000; t < now; t += 1000) {
      this.history.push(...this.measure(t));
    }
    for (const node of this.nodes) node.lastSeen = iso(now);
  }

  // ------------------------------------------------------------------ lifecycle

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  private emit(event: LiveEvent) {
    for (const listener of this.listeners) listener(event);
  }

  // ------------------------------------------------------------------ simulator controls

  onControlsChange(listener: () => void): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }
  private controlsChanged() {
    for (const listener of this.controlListeners) listener();
  }

  getLeak(zoneId: number): number {
    return this.leaks.get(zoneId) ?? 0;
  }
  setLeak(zoneId: number, rate: number) {
    if (rate <= 0) this.leaks.delete(zoneId);
    else this.leaks.set(zoneId, rate);
    this.controlsChanged();
  }
  isNodeUnplugged(nodeId: number): boolean {
    return this.forcedOffline.has(nodeId);
  }
  setNodeUnplugged(nodeId: number, unplugged: boolean) {
    if (unplugged) this.forcedOffline.add(nodeId);
    else this.forcedOffline.delete(nodeId);
    this.controlsChanged();
  }

  // ------------------------------------------------------------------ queries

  getRecentReadings(seconds: number): Reading[] {
    const cutoff = Date.now() - seconds * 1000;
    return this.history.filter((r) => Date.parse(r.recordedAt) >= cutoff);
  }
  getAlerts(): Alert[] {
    return this.alerts.map((a) => ({ ...a }));
  }
  getLeakEvents(): LeakEvent[] {
    return this.leakEvents.map((e) => ({ ...e }));
  }
  getCommands(): ValveCommand[] {
    return this.commands.map((c) => ({ ...c }));
  }

  // ------------------------------------------------------------------ the physical rig

  private valveOpen(zoneId: number): boolean {
    return this.valves.find((v) => v.zoneId === zoneId)?.state !== 'closed';
  }

  private zoneSensors(zoneId: number) {
    const inZone = rig.sensors.filter((s) => s.zoneId === zoneId);
    return {
      inlet: inZone.find((s) => s.type === 'flow' && s.position === 'zone_inlet'),
      outlet: inZone.find((s) => s.type === 'flow' && s.position === 'zone_outlet'),
      pressure: inZone.find((s) => s.type === 'pressure' && s.position === 'zone_inlet'),
    };
  }

  private networkSensor(type: 'flow' | 'pressure', position: 'trunk' | 'return') {
    return rig.sensors.find((s) => s.zoneId === null && s.type === type && s.position === position);
  }

  /** True sensor values at time t, for every sensor on a node that is reporting. */
  private measure(t: number): Reading[] {
    const activeZones = rig.zones.filter((z) => z.active);
    const openZones = activeZones.filter((z) => this.valveOpen(z.id));
    const closedCount = activeZones.length - openZones.length;
    const totalLeak = openZones.reduce((sum, z) => sum + this.getLeak(z.id), 0);
    // Real pumps wander a little.
    const pumpWobble = 1 + 0.02 * Math.sin(t / 47_000);

    const values = new Map<number, number>(); // sensorId -> value
    let trunk = 0;
    let ret = 0;

    for (const zone of activeZones) {
      const base = rig.baselines.find((b) => b.zoneId === zone.id);
      const { inlet, outlet, pressure } = this.zoneSensors(zone.id);
      if (!base) continue;

      if (!this.valveOpen(zone.id)) {
        if (inlet) values.set(inlet.id, Math.max(0, noise(0.01)));
        if (outlet) values.set(outlet.id, Math.max(0, noise(0.01)));
        if (pressure) values.set(pressure.id, Math.max(0, 1 + noise(0.8)));
        continue;
      }

      const leak = this.getLeak(zone.id);
      const otherLeaks = totalLeak - leak;
      const divertBoost = 1 + 0.12 * closedCount; // surplus from closed zones / the bypass
      const trueIn = (base.inletFlow * divertBoost - 0.05 * otherLeaks + 0.25 * leak) * pumpWobble;
      const trueOut = trueIn - leak;
      const inValue = trueIn + noise(0.015);
      const outValue = trueOut - base.flowOffset + noise(0.015);
      const p = base.inletPressure + 4 * closedCount - 15 * leak - 2 * otherLeaks + noise(0.6);

      if (inlet) values.set(inlet.id, Math.max(0, inValue));
      if (outlet) values.set(outlet.id, Math.max(0, outValue));
      if (pressure) values.set(pressure.id, p);
      trunk += inValue;
      ret += outValue;
    }

    const f1 = this.networkSensor('flow', 'trunk');
    const f5 = this.networkSensor('flow', 'return');
    const p1 = this.networkSensor('pressure', 'trunk');
    const p5 = this.networkSensor('pressure', 'return');
    if (f1) values.set(f1.id, trunk + noise(0.015));
    if (f5) values.set(f5.id, ret + noise(0.015));
    if (p1) values.set(p1.id, rig.TRUNK_PRESSURE - 4 * totalLeak + 3 * closedCount + noise(0.5));
    if (p5) values.set(p5.id, rig.RETURN_PRESSURE + noise(0.3));

    const recordedAt = iso(Math.floor(t / 1000) * 1000);
    return rig.sensors
      .filter((s) => !this.forcedOffline.has(s.nodeId) && values.has(s.id))
      .map((s) => ({ sensorId: s.id, recordedAt, value: round(values.get(s.id)!, s.type === 'pressure' ? 1 : 3) }));
  }

  // ------------------------------------------------------------------ one second of backend work

  private tick() {
    const now = Date.now();

    // 1. Nodes publish readings; ingestion stores them.
    const readings = this.measure(now);
    this.history.push(...readings);
    const cutoff = now - HISTORY_SECONDS * 1000;
    while (this.history.length && Date.parse(this.history[0].recordedAt) < cutoff) this.history.shift();
    if (readings.length) this.emit({ type: 'readings', readings });

    // 2. Heartbeats.
    this.checkHeartbeats(now);

    // 3. Detection service.
    for (const [zoneId, detector] of this.detectors) this.detect(zoneId, detector, readings, now);
  }

  private checkHeartbeats(now: number) {
    for (const node of this.nodes) {
      if (!this.forcedOffline.has(node.id)) {
        node.lastSeen = iso(now);
        if (node.status === 'offline') {
          node.status = 'online';
          this.emit({ type: 'node', node: { ...node } });
          const open = this.alerts.find((a) => a.type === 'node_offline' && a.nodeId === node.id && a.status !== 'resolved');
          if (open) this.resolveAlertInternal(open, now);
        }
        continue;
      }
      const silentFor = now - Date.parse(node.lastSeen ?? iso(now));
      if (node.status === 'online' && silentFor > rig.settings.heartbeatTimeoutSeconds * 1000) {
        node.status = 'offline';
        this.emit({ type: 'node', node: { ...node } });
        this.raiseAlert('node_offline', 'warning', `${node.name} stopped reporting (no heartbeat for ${rig.settings.heartbeatTimeoutSeconds} s)`, now, { nodeId: node.id });
      }
    }
  }

  private detect(zoneId: number, d: ZoneDetector, readings: Reading[], now: number) {
    const zone = rig.zones.find((z) => z.id === zoneId)!;
    const base = rig.baselines.find((b) => b.zoneId === zoneId);
    const valve = this.valves.find((v) => v.zoneId === zoneId);
    if (!base) return; // not calibrated yet

    // An isolated zone can't be assessed; keep any open event open until it's reopened.
    if (valve?.state === 'closed') {
      if (d.event) {
        d.event.lossRate = 0;
        this.emit({ type: 'leakEvent', leakEvent: { ...d.event } });
      }
      d.aboveSince = null;
      d.belowSince = null;
      return;
    }

    const { inlet: inSensor, outlet: outSensor, pressure: pSensor } = this.zoneSensors(zoneId);
    const valueOf = (sensorId?: number) => readings.find((r) => r.sensorId === sensorId)?.value;
    const inlet = valueOf(inSensor?.id);
    const outlet = valueOf(outSensor?.id);
    const p = valueOf(pSensor?.id);
    if (inlet === undefined || outlet === undefined) return; // node offline: no data, no verdict

    const residual = inlet - outlet - base.flowOffset;
    const pressureDrop = p === undefined ? 0 : base.inletPressure - p;
    const threshold = rig.settings.residualThreshold;

    if (residual > threshold) {
      d.belowSince = null;
      d.aboveSince ??= now;

      if (!d.event) {
        d.event = {
          id: this.nextEventId++, zoneId, status: 'suspected', detectedAt: iso(now), confirmedAt: null,
          resolvedAt: null, peakResidual: 0, lossRate: 0, volumeLost: 0, pressureDrop: 0,
        };
        this.leakEvents.unshift(d.event);
      }
      const e = d.event;
      e.peakResidual = round(Math.max(e.peakResidual, residual));
      e.lossRate = round(e.lossRate === 0 ? residual : e.lossRate * 0.8 + residual * 0.2);
      e.volumeLost = round(e.volumeLost + residual / 60, 3);
      e.pressureDrop = round(Math.max(0, pressureDrop), 1);

      if (e.status === 'suspected' && now - d.aboveSince >= rig.settings.confirmSeconds * 1000) {
        e.status = 'confirmed';
        e.confirmedAt = iso(now);
        d.alert = this.raiseAlert('leak', 'critical', `Leak in ${zone.name}, about ${e.lossRate.toFixed(1)} L/min`, now, { leakEventId: e.id });
      }
      this.emit({ type: 'leakEvent', leakEvent: { ...e } });
      return;
    }

    d.aboveSince = null;
    if (!d.event) return;
    d.belowSince ??= now;
    if (now - d.belowSince < rig.settings.clearSeconds * 1000) return;

    const e = d.event;
    e.status = e.status === 'suspected' ? 'false_alarm' : 'resolved';
    e.resolvedAt = iso(now);
    e.lossRate = 0;
    this.emit({ type: 'leakEvent', leakEvent: { ...e } });
    if (d.alert) this.resolveAlertInternal(d.alert, now);
    d.event = null;
    d.alert = null;
    d.belowSince = null;
  }

  // ------------------------------------------------------------------ alert service

  private raiseAlert(
    type: AlertType,
    severity: AlertSeverity,
    message: string,
    now: number,
    links: Partial<Pick<Alert, 'leakEventId' | 'nodeId' | 'sensorId' | 'valveId'>>,
  ): Alert {
    const alert: Alert = {
      id: this.nextAlertId++, type, severity, status: 'open', message,
      leakEventId: null, nodeId: null, sensorId: null, valveId: null, ...links,
      createdAt: iso(now), acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null,
    };
    this.alerts.unshift(alert);
    this.emit({ type: 'alert', alert: { ...alert } });
    return alert;
  }

  private resolveAlertInternal(alert: Alert, now: number) {
    alert.status = 'resolved';
    alert.resolvedAt = iso(now);
    this.emit({ type: 'alert', alert: { ...alert } });
  }

  acknowledgeAlert(alertId: number, username: string): Alert {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (!alert) throw new Error('Alert not found');
    if (alert.status === 'open') {
      alert.status = 'acknowledged';
      alert.acknowledgedAt = iso(Date.now());
      alert.acknowledgedBy = username;
      this.emit({ type: 'alert', alert: { ...alert } });
    }
    return { ...alert };
  }

  resolveAlert(alertId: number, username: string): Alert {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (!alert) throw new Error('Alert not found');
    if (alert.type === 'leak') {
      const event = this.leakEvents.find((e) => e.id === alert.leakEventId);
      if (event && (event.status === 'suspected' || event.status === 'confirmed')) {
        throw new Error('The leak is still active. It resolves automatically once the zone balance is back to normal.');
      }
    }
    if (alert.type === 'node_offline') {
      const node = this.nodes.find((n) => n.id === alert.nodeId);
      if (node?.status === 'offline') throw new Error('The node is still offline.');
    }
    if (!alert.acknowledgedAt) {
      alert.acknowledgedAt = iso(Date.now());
      alert.acknowledgedBy = username;
    }
    this.resolveAlertInternal(alert, Date.now());
    return { ...alert };
  }

  // ------------------------------------------------------------------ control service

  sendValveCommand(valveId: number, action: ValveAction, username: string | null): ValveCommand {
    const valve = this.valves.find((v) => v.id === valveId);
    if (!valve) throw new Error('Valve not found');
    const node = this.nodes.find((n) => n.id === valve.nodeId)!;
    const now = Date.now();

    const command: ValveCommand = {
      id: this.nextCommandId++, valveId, issuedBy: username, action, status: 'pending', rejectReason: null,
      correlationId: crypto.randomUUID(), issuedAt: iso(now), sentAt: null, confirmedAt: null,
    };

    // Gates from the valve-control activity diagram.
    // A valve with a close command still in flight counts as closed, so two quick
    // close commands can't slip past the interlock together.
    const closing = (v: Valve) =>
      this.commands.some((c) => c.valveId === v.id && c.action === 'close' && (c.status === 'pending' || c.status === 'sent'));
    const activeZones = rig.zones.filter((z) => z.active);
    const openAfter = activeZones.filter((z) => {
      if (z.id === valve.zoneId) return action === 'open';
      const v = this.valves.find((x) => x.zoneId === z.id);
      return !v || (v.state !== 'closed' && !closing(v)); // a zone with no valve can't be closed
    }).length;
    const minOpen = rig.settings.interlockMinOpenZones;

    if (node.status === 'offline') {
      command.status = 'rejected';
      command.rejectReason = `${node.name} is offline, so the command could not be delivered`;
    } else if (action === 'close' && openAfter < minOpen) {
      command.status = 'rejected';
      command.rejectReason = `Interlock: at least ${minOpen} zone${minOpen === 1 ? '' : 's'} must stay open to protect the pump`;
    }

    this.commands.unshift(command);
    this.emit({ type: 'valveCommand', command: { ...command } });
    if (command.status === 'rejected') return { ...command };

    // pending -> sent -> confirmed | timed_out
    setTimeout(() => {
      command.status = 'sent';
      command.sentAt = iso(Date.now());
      this.emit({ type: 'valveCommand', command: { ...command } });
    }, 300);

    setTimeout(() => {
      if (this.forcedOffline.has(node.id)) {
        command.status = 'timed_out';
        this.emit({ type: 'valveCommand', command: { ...command } });
        this.raiseAlert('valve_failure', 'warning', `${valve.code} did not confirm the ${action} command`, Date.now(), { valveId });
        return;
      }
      command.status = 'confirmed';
      command.confirmedAt = iso(Date.now());
      valve.state = action === 'open' ? 'open' : 'closed';
      this.emit({ type: 'valveCommand', command: { ...command } });
      this.emit({ type: 'valve', valve: { ...valve } });
    }, 1500);

    return { ...command };
  }
}
