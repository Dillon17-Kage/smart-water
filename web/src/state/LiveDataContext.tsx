import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import { dataSource } from '../data';
import type { ConnectionStatus, LiveEvent } from '../data/source';
import type { Alert, LeakEvent, MonitoringNode, Reading, Rig, Valve, ValveAction, ValveCommand } from '../types';

/** One second of readings: { t: epoch ms, values: sensorId -> value }. */
export interface Frame {
  t: number;
  values: Record<number, number>;
}

const HISTORY_SECONDS = 15 * 60;

interface State {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  connection: ConnectionStatus;
  rig: Rig | null;
  nodes: MonitoringNode[];
  valves: Valve[];
  latest: Record<number, Reading>; // sensorId -> newest reading
  frames: Frame[]; // oldest first
  alerts: Alert[]; // newest first
  leakEvents: LeakEvent[]; // newest first
  commands: ValveCommand[]; // newest first
}

type Action =
  | { type: 'loaded'; rig: Rig; readings: Reading[]; alerts: Alert[]; leakEvents: LeakEvent[]; commands: ValveCommand[] }
  | { type: 'failed'; error: string }
  | { type: 'connection'; status: ConnectionStatus }
  | { type: 'reset' }
  | LiveEvent;

const initial: State = {
  status: 'loading', error: null, connection: 'connecting', rig: null, nodes: [], valves: [],
  latest: {}, frames: [], alerts: [], leakEvents: [], commands: [],
};

const commandRank: Record<ValveCommand['status'], number> = { pending: 0, sent: 1, confirmed: 2, timed_out: 2, rejected: 2 };

function upsert<T extends { id: number }>(list: T[], item: T): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return [item, ...list];
  const copy = list.slice();
  copy[index] = item;
  return copy;
}

function addReadings(state: Pick<State, 'latest' | 'frames'>, readings: Reading[]) {
  const latest = { ...state.latest };
  const frames = state.frames.slice();
  for (const r of readings) {
    const t = Date.parse(r.recordedAt);
    if (!latest[r.sensorId] || Date.parse(latest[r.sensorId].recordedAt) <= t) latest[r.sensorId] = r;
    const last = frames[frames.length - 1];
    if (last && last.t === t) frames[frames.length - 1] = { t, values: { ...last.values, [r.sensorId]: r.value } };
    else if (!last || last.t < t) frames.push({ t, values: { [r.sensorId]: r.value } });
    // Late or duplicate deliveries for an older second are ignored for the charts.
  }
  const cutoff = Date.now() - HISTORY_SECONDS * 1000;
  while (frames.length && frames[0].t < cutoff) frames.shift();
  return { latest, frames };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loaded':
      return {
        ...state,
        status: 'ready',
        error: null,
        rig: action.rig,
        nodes: action.rig.nodes,
        valves: action.rig.valves,
        alerts: action.alerts,
        leakEvents: action.leakEvents,
        commands: action.commands,
        ...addReadings({ latest: {}, frames: [] }, action.readings),
      };
    case 'failed':
      return { ...state, status: 'error', error: action.error };
    case 'connection':
      return { ...state, connection: action.status };
    case 'reset':
      return initial;
    case 'readings':
      return state.status === 'ready' ? { ...state, ...addReadings(state, action.readings) } : state;
    case 'node':
      return { ...state, nodes: upsert(state.nodes, action.node) };
    case 'valve':
      return { ...state, valves: upsert(state.valves, action.valve) };
    case 'valveCommand': {
      // The HTTP response and the SignalR push can arrive in either order;
      // never let an older status overwrite a newer one.
      const existing = state.commands.find((c) => c.id === action.command.id);
      if (existing && commandRank[existing.status] > commandRank[action.command.status]) return state;
      return { ...state, commands: upsert(state.commands, action.command) };
    }
    case 'alert':
      return { ...state, alerts: upsert(state.alerts, action.alert) };
    case 'leakEvent':
      return { ...state, leakEvents: upsert(state.leakEvents, action.leakEvent) };
  }
}

interface LiveDataValue extends State {
  reload: () => void;
  acknowledgeAlert: (id: number) => Promise<void>;
  resolveAlert: (id: number) => Promise<void>;
  sendValveCommand: (valveId: number, action: ValveAction) => Promise<ValveCommand>;
}

const LiveDataContext = createContext<LiveDataValue | null>(null);

export function LiveDataProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);

  const load = useCallback(async (isCancelled: () => boolean) => {
    dispatch({ type: 'reset' });
    try {
      const [rig, readings, alerts, leakEvents, commands] = await Promise.all([
        dataSource.getRig(),
        dataSource.getRecentReadings(HISTORY_SECONDS),
        dataSource.getAlerts(),
        dataSource.getLeakEvents(),
        dataSource.getValveCommands(),
      ]);
      if (!isCancelled()) dispatch({ type: 'loaded', rig, readings, alerts, leakEvents, commands });
    } catch (error) {
      if (!isCancelled()) dispatch({ type: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    const disconnect = dataSource.connect(
      (event) => !cancelled && dispatch(event),
      (status) => !cancelled && dispatch({ type: 'connection', status }),
    );
    return () => {
      cancelled = true;
      disconnect();
    };
  }, [load]);

  const value = useMemo<LiveDataValue>(
    () => ({
      ...state,
      reload: () => void load(() => false),
      acknowledgeAlert: async (id) => dispatch({ type: 'alert', alert: await dataSource.acknowledgeAlert(id) }),
      resolveAlert: async (id) => dispatch({ type: 'alert', alert: await dataSource.resolveAlert(id) }),
      sendValveCommand: async (valveId, action) => {
        const command = await dataSource.sendValveCommand(valveId, action);
        dispatch({ type: 'valveCommand', command });
        return command;
      },
    }),
    [state, load],
  );

  return <LiveDataContext.Provider value={value}>{children}</LiveDataContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLiveData(): LiveDataValue {
  const value = useContext(LiveDataContext);
  if (!value) throw new Error('useLiveData must be used inside LiveDataProvider');
  return value;
}
