import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type AxisDomainItem,
} from 'recharts';
import { chartTime } from '../lib/format';

/** SVG attributes can't use CSS variables reliably, so read the tokens and follow the theme. */
function readColors() {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string) => style.getPropertyValue(name).trim();
  return {
    trunk: get('--series-trunk'),
    ret: get('--series-return'),
    zoneA: get('--series-zone-a'),
    zoneB: get('--series-zone-b'),
    grid: get('--chart-grid'),
    axis: get('--chart-axis'),
    ink: get('--ink'),
    ink2: get('--ink-2'),
    surface: get('--surface'),
    line: get('--line'),
    critical: get('--critical'),
  };
}

export type ChartColors = ReturnType<typeof readColors>;

export function useChartColors(): ChartColors {
  const [colors, setColors] = useState(readColors);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setColors(readColors());
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return colors;
}

/** Colour for a zone code, following the entity across every chart. */
export function zoneColor(colors: ChartColors, code: string): string {
  return code === 'A' ? colors.zoneA : colors.zoneB;
}

export interface SeriesSpec {
  key: string;
  name: string;
  color: string;
}

export function TimeSeriesChart({
  data,
  series,
  unit,
  height = 220,
  threshold,
  yDomain,
}: {
  data: ({ t: number } & Record<string, number | null>)[];
  series: SeriesSpec[];
  unit: string;
  height?: number;
  threshold?: { value: number; label: string };
  yDomain?: [AxisDomainItem, AxisDomainItem];
}) {
  const colors = useChartColors();
  const ticks = useMemo(() => {
    if (data.length < 2) return undefined;
    const first = data[0].t;
    const last = data[data.length - 1].t;
    const step = 2 * 60_000;
    const out: number[] = [];
    for (let t = Math.ceil(first / step) * step; t <= last; t += step) out.push(t);
    return out;
  }, [data]);

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={colors.grid} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            ticks={ticks}
            tickFormatter={chartTime}
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: colors.line }}
          />
          <YAxis
            stroke={colors.axis}
            tick={{ fill: colors.axis, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={48}
            domain={yDomain ?? ['auto', 'auto']}
            tickFormatter={(v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1))}
          />
          <Tooltip
            labelFormatter={(t) => new Date(Number(t)).toLocaleTimeString()}
            formatter={(value, name) => [typeof value === 'number' ? `${value.toFixed(2)} ${unit}` : '—', name]}
            contentStyle={{
              background: colors.surface,
              border: `1px solid ${colors.line}`,
              borderRadius: 8,
              fontSize: 12,
              color: colors.ink,
            }}
            labelStyle={{ color: colors.ink2, marginBottom: 4 }}
            cursor={{ stroke: colors.axis, strokeWidth: 1, strokeDasharray: '3 3' }}
          />
          {series.length > 1 && (
            <Legend
              verticalAlign="top"
              align="right"
              height={24}
              iconType="plainline"
              wrapperStyle={{ fontSize: 12, color: colors.ink2 }}
              formatter={(value) => <span style={{ color: colors.ink2 }}>{value}</span>}
            />
          )}
          {threshold && (
            <ReferenceLine
              y={threshold.value}
              stroke={colors.critical}
              strokeDasharray="4 4"
              strokeWidth={1}
              label={{ value: threshold.label, position: 'insideTopLeft', fill: colors.ink2, fontSize: 11 }}
            />
          )}
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: colors.surface, strokeWidth: 2 }}
              isAnimationActive={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
