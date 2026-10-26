import { CheckCircle2, Clock, Lock, Unlock, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { TimeSeriesChart, useChartColors, zoneColor } from '../components/charts';
import { Card, Chip, cx, PageHeader, StatTile, useNow, ZoneStatusChip } from '../components/ui';
import { fmt, formatAgo } from '../lib/format';
import { frameResidual, freshValues, isFresh, networkFlows, networkSensors, zoneBalance, zoneSensors, zoneStatus } from '../lib/rig';
import { useLiveData } from '../state/LiveDataContext';
import type { Rig, Zone } from '../types';

const windows = [5, 10, 15] as const;

export function DashboardPage() {
  const live = useLiveData();
  const rig = live.rig as Rig;
  const colors = useChartColors();
  const now = useNow();
  const [minutes, setMinutes] = useState<(typeof windows)[number]>(10);

  const net = networkSensors(rig);
  const value = (id?: number) => (id && isFresh(live.latest[id], now) ? live.latest[id].value : null);
  const flows = networkFlows(rig, freshValues(live.latest, now));
  const trunk = flows.supply;
  const ret = flows.ret;
  const sourceHint = flows.measured ? '' : ' (sum of zones)';
  const activeZones = rig.zones.filter((z) => z.active);
  const openZones = activeZones.filter((z) => live.valves.find((v) => v.zoneId === z.id)?.state !== 'closed');
  const expectedOffset = openZones.reduce((sum, z) => sum + (rig.baselines.find((b) => b.zoneId === z.id)?.flowOffset ?? 0), 0);
  const unaccounted = trunk !== null && ret !== null ? trunk - ret - expectedOffset : null;
  const openAlerts = live.alerts.filter((a) => a.status === 'open').length;
  const nodesOnline = live.nodes.filter((n) => n.status === 'online').length;

  // At most 900 frames: cheap enough to rebuild every second without memoising.
  const frames = live.frames.filter((f) => f.t >= now - minutes * 60_000);
  const flowData = frames.map((f) => {
    const n = networkFlows(rig, f.values);
    return { t: f.t, trunk: n.supply, ret: n.ret };
  });
  const residualData = frames.map((f) => {
    const row: { t: number } & Record<string, number | null> = { t: f.t };
    for (const z of activeZones) row[z.code] = frameResidual(rig, z.id, f);
    return row;
  });
  const pressureData = frames.map((f) => {
    const row: { t: number } & Record<string, number | null> = { t: f.t };
    for (const z of activeZones) {
      const p = zoneSensors(rig, z.id).pressure;
      row[z.code] = p ? (f.values[p.id] ?? null) : null;
    }
    return row;
  });

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Live flow and pressure at every measuring point, updated every second.">
        <div className="flex rounded-lg border border-line bg-surface p-0.5 text-sm" role="group" aria-label="Chart time range">
          {windows.map((w) => (
            <button
              key={w}
              onClick={() => setMinutes(w)}
              aria-pressed={minutes === w}
              className={cx('rounded-md px-3 py-1', minutes === w ? 'bg-accent-soft font-medium text-accent' : 'text-ink-2 hover:text-ink')}
            >
              {w} min
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile label={flows.supplyLabel} value={fmt(trunk)} unit="L/min" hint={`Into the network${sourceHint}`} />
        <StatTile label={flows.returnLabel} value={fmt(ret)} unit="L/min" hint={`Back to the tank${sourceHint}`} />
        <StatTile
          label="Unaccounted water"
          value={fmt(unaccounted)}
          unit="L/min"
          tone={unaccounted !== null && unaccounted > rig.settings.residualThreshold ? 'critical' : undefined}
          hint="Supply − return − sensor offsets"
        />
        <StatTile label="Open alerts" value={openAlerts} tone={openAlerts > 0 ? 'critical' : 'good'} hint={openAlerts ? 'Need attention' : 'All clear'} />
        <StatTile
          label="Nodes online"
          value={`${nodesOnline} / ${live.nodes.length}`}
          tone={nodesOnline < live.nodes.length ? 'serious' : 'good'}
          hint={net.pressure ? `Trunk pressure ${fmt(value(net.pressure.id), 0)} kPa` : nodesOnline < live.nodes.length ? 'Check the offline node' : 'All reporting'}
        />
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {rig.zones.map((zone) => (
          <ZoneCard key={zone.id} zone={zone} />
        ))}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="Network flow: supply vs return">
          <TimeSeriesChart
            data={flowData}
            unit="L/min"
            series={[
              { key: 'trunk', name: flows.supplyLabel, color: colors.trunk },
              { key: 'ret', name: flows.returnLabel, color: colors.ret },
            ]}
          />
          <p className="mt-2 text-xs text-ink-3">The gap between the lines is water that went in and didn't come back.</p>
        </Card>
        <Card title="Zone balance (inlet − outlet − offset)">
          <TimeSeriesChart
            data={residualData}
            unit="L/min"
            threshold={{ value: rig.settings.residualThreshold, label: `Leak threshold ${rig.settings.residualThreshold} L/min` }}
            yDomain={[-0.2, (max: number) => Math.max(1, Math.ceil(max * 2) / 2)]}
            series={activeZones.map((z) => ({ key: z.code, name: z.name, color: zoneColor(colors, z.code) }))}
          />
          <p className="mt-2 text-xs text-ink-3">
            Near zero is normal. Above the threshold for {rig.settings.confirmSeconds} s confirms a leak in that zone.
          </p>
        </Card>
        <Card title="Zone inlet pressure">
          <TimeSeriesChart
            data={pressureData}
            unit="kPa"
            series={activeZones.map((z) => ({ key: z.code, name: z.name, color: zoneColor(colors, z.code) }))}
          />
          <p className="mt-2 text-xs text-ink-3">A leaking zone loses pressure while its flow rises.</p>
        </Card>
        <SensorTable />
      </div>
    </>
  );
}

function ZoneCard({ zone }: { zone: Zone }) {
  const live = useLiveData();
  const rig = live.rig as Rig;
  useNow();
  const status = zoneStatus(rig, zone, live.valves, live.nodes, live.leakEvents);
  // An isolated zone has no flow, so its balance and pressure delta mean nothing.
  const balance = zone.active ? zoneBalance(rig, zone.id, live.latest) : null;
  const isolated = status === 'isolated';
  const baseline = rig.baselines.find((b) => b.zoneId === zone.id);
  const valve = live.valves.find((v) => v.zoneId === zone.id);
  const threshold = rig.settings.residualThreshold;

  if (!zone.active) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-ink-2">{zone.name}</h3>
          <ZoneStatusChip status="inactive" />
        </div>
        <p className="mt-3 text-sm text-ink-3">Set up in the database but switched off. It appears here once it's activated.</p>
      </div>
    );
  }

  const residual = isolated ? null : (balance?.residual ?? null);
  const meter = residual === null ? 0 : Math.min(100, Math.max(0, (residual / (threshold * 3)) * 100));
  const thresholdAt = 100 / 3;

  return (
    <div
      className={cx(
        'rounded-xl border bg-surface p-4',
        status === 'leak' ? 'border-critical/60' : status === 'suspected' ? 'border-warning' : 'border-line',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">{zone.name}</h3>
        <ZoneStatusChip status={status} />
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-ink-3">Inlet</dt>
          <dd className="font-medium tabular">{fmt(balance?.inletFlow)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Outlet</dt>
          <dd className="font-medium tabular">{fmt(balance?.outletFlow)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-3">Pressure</dt>
          <dd className="font-medium tabular">
            {fmt(balance?.inletPressure, 0)}
            <span className="ml-0.5 text-xs font-normal text-ink-3">kPa</span>
          </dd>
        </div>
      </dl>

      <div className="mt-3">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-ink-2">Balance</span>
          <span className={cx('font-medium tabular', residual !== null && residual > threshold ? 'text-critical-ink' : 'text-ink')}>
            {fmt(residual)} L/min
          </span>
        </div>
        <div className="relative mt-1.5 h-1.5 rounded-full bg-surface-2" aria-hidden>
          <div
            className={cx('h-full rounded-full transition-all', residual !== null && residual > threshold ? 'bg-critical' : 'bg-good')}
            style={{ width: `${meter}%` }}
          />
          <div className="absolute -top-1 h-3.5 w-0.5 bg-ink-3" style={{ left: `${thresholdAt}%` }} title={`Threshold ${threshold} L/min`} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-ink-2">
        {valve && (
          <Chip tone={valve.state === 'closed' ? 'neutral' : 'accent'} icon={valve.state === 'closed' ? Lock : Unlock}>
            {valve.code} {valve.state}
          </Chip>
        )}
        {isolated && <span>Valve closed: no flow, detection paused</span>}
        {baseline && balance && !isolated && (
          <span className="tabular">
            Pressure {balance.pressureDelta >= 0 ? '+' : ''}
            {fmt(balance.pressureDelta, 1)} kPa vs baseline
          </span>
        )}
      </div>
    </div>
  );
}

function SensorTable() {
  const live = useLiveData();
  const rig = live.rig as Rig;
  const now = useNow();
  const positionLabel = { trunk: 'Supply', return: 'Return', zone_inlet: 'Inlet', zone_outlet: 'Outlet' };

  return (
    <Card title="Sensors">
      <div className="-mx-4 -my-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-3">
              <th className="px-4 py-2 font-medium">Sensor</th>
              <th className="px-2 py-2 font-medium">Where</th>
              <th className="px-2 py-2 text-right font-medium">Value</th>
              <th className="px-2 py-2 font-medium">Node</th>
              <th className="px-4 py-2 font-medium">Last reading</th>
            </tr>
          </thead>
          <tbody>
            {rig.sensors.map((s) => {
              const reading = live.latest[s.id];
              const fresh = isFresh(reading, now);
              const ago = reading ? formatAgo(reading.recordedAt, now) : 'never';
              const node = live.nodes.find((n) => n.id === s.nodeId);
              const zone = rig.zones.find((z) => z.id === s.zoneId);
              return (
                <tr key={s.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 font-medium">{s.code}</td>
                  <td className="px-2 py-2 text-ink-2">
                    {zone ? `${zone.name} ${positionLabel[s.position].toLowerCase()}` : positionLabel[s.position]}
                  </td>
                  <td className={cx('px-2 py-2 text-right tabular', !fresh && 'text-ink-3')}>
                    {reading ? fmt(reading.value, s.type === 'pressure' ? 0 : 2) : '—'}
                    <span className="ml-1 text-xs text-ink-3">{s.unit}</span>
                  </td>
                  <td className="px-2 py-2 text-ink-2">{node?.name}</td>
                  <td className="px-4 py-2">
                    {fresh ? (
                      <span className="inline-flex items-center gap-1 text-good-ink">
                        <CheckCircle2 size={13} aria-hidden /> {ago}
                      </span>
                    ) : node?.status === 'offline' ? (
                      <span className="inline-flex items-center gap-1 text-serious-ink">
                        <WifiOff size={13} aria-hidden /> Node offline
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-warning-ink">
                        <Clock size={13} aria-hidden /> {ago}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
