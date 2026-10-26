import { CommandResult } from '../components/CommandResult';
import { Card, cx, PageHeader, useNow, zoneStatusInfo } from '../components/ui';
import { useValveControl } from '../components/ValveControl';
import { fmt, formatDuration } from '../lib/format';
import { isFresh, networkSensors, openLeakFor, zoneBalance, zoneSensors, zoneStatus, type ZoneStatus } from '../lib/rig';
import { useAuth } from '../state/AuthContext';
import { useLiveData } from '../state/LiveDataContext';
import type { Rig, Sensor, Valve } from '../types';

// Schematic geometry (SVG user units)
const ROW_Y = [95, 235, 375];
const MANIFOLD_X = 330;
const VALVE_X = 380;
const INLET_X = 440;
const PRESSURE_X = 495;
const ZONE_X = 560;
const ZONE_W = 200;
const OUTLET_X = 815;
const COLLECTOR_X = 880;
const RETURN_Y = 432;

const zoneFill: Record<ZoneStatus, string> = {
  normal: 'fill-good-soft stroke-good',
  suspected: 'fill-warning-soft stroke-warning',
  leak: 'fill-critical-soft stroke-critical',
  isolated: 'fill-neutral-soft stroke-line-strong',
  offline: 'fill-serious-soft stroke-serious',
  inactive: 'fill-surface stroke-line-strong',
};

export function NetworkPage() {
  const live = useLiveData();
  const rig = live.rig as Rig;
  const { can } = useAuth();
  const now = useNow();
  const control = useValveControl();
  const canOperate = can('valves.operate');
  const net = networkSensors(rig);

  const reading = (sensor?: Sensor) => (sensor && isFresh(live.latest[sensor.id], now) ? live.latest[sensor.id].value : null);
  const flowing = (sensor?: Sensor) => (reading(sensor) ?? 0) > 0.1;
  // Until F1/F5 are fitted, show the trunk and return as flowing if any zone is.
  const activeZoneSensors = rig.zones.filter((z) => z.active).map((z) => zoneSensors(rig, z.id));
  const supplyFlowing = net.trunk ? flowing(net.trunk) : activeZoneSensors.some((z) => flowing(z.inlet));
  const returnFlowing = net.ret ? flowing(net.ret) : activeZoneSensors.some((z) => flowing(z.outlet));

  return (
    <>
      <PageHeader
        title="Network"
        subtitle={
          canOperate
            ? 'Live schematic of the rig. Click a valve to open or close it.'
            : 'Live schematic of the rig, from the tank through each zone and back.'
        }
      />
      <CommandResult result={control.result} onClose={control.clearResult} />

      <Card>
        <div className="-mx-4 -my-4 overflow-x-auto">
          <svg viewBox="0 0 960 470" className="min-w-[680px] w-full" role="img" aria-label="Water network schematic">
            {/* --- tank and pump --- */}
            <rect x={30} y={170} width={100} height={130} rx={8} className="fill-accent-soft stroke-accent" strokeWidth={2} />
            <rect x={32} y={215} width={96} height={83} rx={6} className="fill-accent opacity-25" />
            <text x={80} y={200} textAnchor="middle" className="fill-ink text-[14px] font-semibold">
              Tank
            </text>
            <Pipe d={`M130 235 H168`} flow={supplyFlowing} />
            <circle cx={190} cy={235} r={22} className="fill-surface stroke-ink-2" strokeWidth={2} />
            <path d="M182 223 L202 235 L182 247 Z" className="fill-ink-2" />
            <text x={190} y={280} textAnchor="middle" className="fill-ink-2 text-[12px]">
              Pump
            </text>

            {/* --- trunk to manifold --- */}
            <Pipe d={`M212 235 H${MANIFOLD_X}`} flow={supplyFlowing} />
            <SensorGlyph x={255} y={235} sensor={net.trunk} value={reading(net.trunk)} />
            <SensorGlyph x={300} y={235} sensor={net.pressure} value={reading(net.pressure)} labelBelow />
            <Pipe d={`M${MANIFOLD_X} ${ROW_Y[0]} V${ROW_Y[2]}`} flow={false} dashed={false} />

            {/* --- zones --- */}
            {rig.zones.map((zone, index) => {
              const y = ROW_Y[index] ?? ROW_Y[ROW_Y.length - 1];
              const sensors = zoneSensors(rig, zone.id);
              const valve = live.valves.find((v) => v.zoneId === zone.id);
              const status = zoneStatus(rig, zone, live.valves, live.nodes, live.leakEvents);
              const balance = zone.active ? zoneBalance(rig, zone.id, live.latest) : null;
              const inFlow = zone.active && flowing(sensors.inlet);
              const outFlow = zone.active && flowing(sensors.outlet);
              const inactive = !zone.active;
              return (
                <g key={zone.id} className={cx(inactive && 'opacity-50')}>
                  <Pipe d={`M${MANIFOLD_X} ${y} H${ZONE_X}`} flow={inFlow} dashed={inactive} />
                  <Pipe d={`M${ZONE_X + ZONE_W} ${y} H${COLLECTOR_X}`} flow={outFlow} dashed={inactive} />

                  {valve ? (
                    <ValveGlyph x={VALVE_X} y={y} valve={valve} interactive={canOperate} onActivate={() => control.request(valve)} />
                  ) : (
                    zone.active && (
                      <text x={VALVE_X} y={y - 16} textAnchor="middle" className="fill-ink-3 text-[11px]">
                        no valve
                      </text>
                    )
                  )}
                  <SensorGlyph x={INLET_X} y={y} sensor={sensors.inlet} value={reading(sensors.inlet)} />
                  <SensorGlyph x={PRESSURE_X} y={y} sensor={sensors.pressure} value={reading(sensors.pressure)} />
                  <SensorGlyph x={OUTLET_X} y={y} sensor={sensors.outlet} value={reading(sensors.outlet)} />

                  <rect
                    x={ZONE_X}
                    y={y - 40}
                    width={ZONE_W}
                    height={80}
                    rx={10}
                    strokeWidth={status === 'leak' ? 3 : 2}
                    strokeDasharray={inactive ? '6 5' : undefined}
                    className={zoneFill[status]}
                  />
                  <text x={ZONE_X + 14} y={y - 16} className="fill-ink text-[14px] font-semibold">
                    {zone.name}
                  </text>
                  <text x={ZONE_X + 14} y={y + 2} className="fill-ink-2 text-[12px]">
                    {zoneStatusInfo[status].label}
                  </text>
                  {balance && status !== 'isolated' && (
                    <text x={ZONE_X + 14} y={y + 20} className="fill-ink-2 text-[12px] tabular">
                      Balance {fmt(balance.residual)} L/min
                    </text>
                  )}
                  {/* one leak point per zone (drain cock / needle valve), between its inlet and outlet sensors */}
                  <g>
                    <path
                      d={`M${ZONE_X + ZONE_W - 38} ${y + 6} q-7 10 0 16 q7 -6 0 -16 Z`}
                      className={status === 'leak' || status === 'suspected' ? 'fill-critical' : 'fill-line-strong'}
                    />
                    <text x={ZONE_X + ZONE_W - 38} y={y - 4} textAnchor="middle" className="fill-ink-3 text-[9px]">
                      L{index + 1}
                    </text>
                  </g>
                  {status === 'leak' && (
                    <circle cx={ZONE_X + ZONE_W - 38} cy={y + 46} r={4} className="fill-critical">
                      <animate attributeName="cy" from={y + 40} to={y + 62} dur="1s" repeatCount="indefinite" />
                      <animate attributeName="opacity" from="1" to="0" dur="1s" repeatCount="indefinite" />
                    </circle>
                  )}
                </g>
              );
            })}

            {/* --- return to tank --- */}
            <Pipe d={`M${COLLECTOR_X} ${ROW_Y[0]} V${RETURN_Y} H80 V300`} flow={returnFlowing} />
            <SensorGlyph x={500} y={RETURN_Y} sensor={net.ret} value={reading(net.ret)} labelBelow />
            <SensorGlyph x={440} y={RETURN_Y} sensor={net.returnPressure} value={reading(net.returnPressure)} labelBelow />
          </svg>
        </div>
      </Card>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-2">
        <Legend shape="circle" label="Flow sensor (L/min)" />
        <Legend shape="square" label="Pressure sensor (kPa)" />
        <Legend shape="valve" label="Solenoid valve" />
        <span className="inline-flex items-center gap-1.5">
          <svg width="28" height="8" aria-hidden>
            <line x1="0" y1="4" x2="28" y2="4" className="pipe-flow stroke-accent" strokeWidth={3} />
          </svg>
          Water flowing
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="14" aria-hidden>
            <path d="M5 1 q-6 8 0 12 q6 -4 0 -12 Z" className="fill-line-strong" />
          </svg>
          Leak point
        </span>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        {rig.zones
          .filter((z) => z.active)
          .map((zone) => {
            const event = openLeakFor(zone.id, live.leakEvents);
            const balance = zoneBalance(rig, zone.id, live.latest);
            return (
              <Card key={zone.id} title={zone.name}>
                <dl className="grid grid-cols-2 gap-y-2 text-sm">
                  <dt className="text-ink-2">Balance</dt>
                  <dd className="text-right tabular">{fmt(balance?.residual)} L/min</dd>
                  <dt className="text-ink-2">Pressure vs baseline</dt>
                  <dd className="text-right tabular">{fmt(balance?.pressureDelta, 1)} kPa</dd>
                  <dt className="text-ink-2">Leak</dt>
                  <dd className="text-right">
                    {event ? (
                      <span className={event.status === 'confirmed' ? 'font-medium text-critical-ink' : 'font-medium text-warning-ink'}>
                        {event.status === 'confirmed' ? 'Confirmed' : 'Suspected'}, {formatDuration(event.detectedAt)}
                      </span>
                    ) : (
                      <span className="text-good-ink">None</span>
                    )}
                  </dd>
                </dl>
              </Card>
            );
          })}
      </div>
      {control.dialog}
    </>
  );
}

function Pipe({ d, flow, dashed }: { d: string; flow: boolean; dashed?: boolean }) {
  return (
    <>
      <path d={d} fill="none" className="stroke-line-strong" strokeWidth={9} strokeLinejoin="round" strokeDasharray={dashed ? '10 8' : undefined} />
      {flow && <path d={d} fill="none" className="pipe-flow stroke-accent" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />}
    </>
  );
}

function SensorGlyph({ x, y, sensor, value, labelBelow }: { x: number; y: number; sensor?: Sensor; value: number | null; labelBelow?: boolean }) {
  if (!sensor) return null;
  const stale = value === null;
  const isPressure = sensor.type === 'pressure';
  const text = stale ? 'no data' : `${value.toFixed(isPressure ? 0 : 2)} ${sensor.unit}`;
  return (
    <g>
      <title>{`${sensor.code}: ${text}`}</title>
      {isPressure ? (
        <rect x={x - 13} y={y - 13} width={26} height={26} rx={5} className="fill-surface stroke-ink-2" strokeWidth={1.5} strokeDasharray={stale ? '3 3' : undefined} />
      ) : (
        <circle cx={x} cy={y} r={14} className="fill-surface stroke-ink-2" strokeWidth={1.5} strokeDasharray={stale ? '3 3' : undefined} />
      )}
      <text x={x} y={y + 4} textAnchor="middle" className="fill-ink text-[11px] font-semibold">
        {sensor.code}
      </text>
      <text
        x={x}
        y={labelBelow ? y + 32 : y - 22}
        textAnchor="middle"
        className={cx('text-[11px] tabular', stale ? 'fill-serious-ink' : 'fill-ink-2')}
      >
        {text}
      </text>
    </g>
  );
}

function ValveGlyph({ x, y, valve, interactive, onActivate }: { x: number; y: number; valve: Valve; interactive: boolean; onActivate: () => void }) {
  const closed = valve.state === 'closed';
  return (
    <g
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `${valve.code} is ${valve.state}. Activate to ${closed ? 'open' : 'close'} it.` : undefined}
      onClick={interactive ? onActivate : undefined}
      onKeyDown={interactive ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onActivate()) : undefined}
      className={cx(interactive && 'cursor-pointer outline-none [&:focus-visible>rect]:stroke-accent')}
    >
      <title>{`${valve.code}: ${valve.state}`}</title>
      <rect x={x - 20} y={y - 20} width={40} height={40} rx={6} className="fill-transparent stroke-transparent" strokeWidth={2} />
      <path
        d={`M${x - 13} ${y - 10} L${x + 13} ${y + 10} L${x + 13} ${y - 10} L${x - 13} ${y + 10} Z`}
        className={closed ? 'fill-ink-2 stroke-ink-2' : 'fill-accent stroke-accent'}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <text x={x} y={y - 22} textAnchor="middle" className="fill-ink text-[11px] font-semibold">
        {valve.code}
      </text>
      <text x={x} y={y + 30} textAnchor="middle" className={cx('text-[11px]', closed ? 'fill-ink-2 font-semibold' : 'fill-accent')}>
        {closed ? 'CLOSED' : 'open'}
      </text>
    </g>
  );
}

function Legend({ shape, label }: { shape: 'circle' | 'square' | 'valve'; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="16" height="16" aria-hidden>
        {shape === 'circle' && <circle cx="8" cy="8" r="6.5" className="fill-surface stroke-ink-2" strokeWidth={1.5} />}
        {shape === 'square' && <rect x="1.5" y="1.5" width="13" height="13" rx="3" className="fill-surface stroke-ink-2" strokeWidth={1.5} />}
        {shape === 'valve' && <path d="M2 3 L14 13 L14 3 L2 13 Z" className="fill-accent" />}
      </svg>
      {label}
    </span>
  );
}
