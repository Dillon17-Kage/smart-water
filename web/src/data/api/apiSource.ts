import { HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import type { Alert, LeakEvent, MonitoringNode, Reading, Rig, User, Valve, ValveCommand } from '../../types';
import { LoginError, type DataSource } from '../source';

/**
 * Talks to the ASP.NET Core backend. The endpoints below are the contract the
 * backend has to implement (also listed in README.md):
 *
 *   POST /api/auth/login                  { username, password } -> { user, token }
 *                                          401/423 -> { message }
 *   GET  /api/rig                         -> Rig
 *   GET  /api/readings/recent?seconds=N   -> Reading[]
 *   GET  /api/alerts                      -> Alert[]
 *   GET  /api/leak-events                 -> LeakEvent[]
 *   GET  /api/valve-commands              -> ValveCommand[]
 *   POST /api/alerts/{id}/acknowledge     -> Alert
 *   POST /api/alerts/{id}/resolve         -> Alert
 *   POST /api/valves/{id}/commands        { action: 'open'|'close' } -> ValveCommand
 *
 * SignalR hub at /hubs/live (JWT passed as access_token), server -> client:
 *   Readings(Reading[])  NodeChanged(Node)  ValveChanged(Valve)
 *   ValveCommandChanged(ValveCommand)  AlertChanged(Alert)  LeakEventChanged(LeakEvent)
 */
export function createApiSource(baseUrl: string): DataSource {
  let token: string | null = null;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.message ?? `Request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
  }

  return {
    kind: 'api',

    async login(username, password) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }).catch(() => {
        throw new LoginError('Cannot reach the server. Check that the API is running.');
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new LoginError(body?.message ?? 'Incorrect username or password.');
      token = body.token;
      return body as { user: User; token: string };
    },

    resume(saved) {
      token = saved;
    },
    logout() {
      token = null;
    },

    getRig: () => request<Rig>('/api/rig'),
    getRecentReadings: (seconds) => request<Reading[]>(`/api/readings/recent?seconds=${seconds}`),
    getAlerts: () => request<Alert[]>('/api/alerts'),
    getLeakEvents: () => request<LeakEvent[]>('/api/leak-events'),
    getValveCommands: () => request<ValveCommand[]>('/api/valve-commands'),
    acknowledgeAlert: (id) => request<Alert>(`/api/alerts/${id}/acknowledge`, { method: 'POST' }),
    resolveAlert: (id) => request<Alert>(`/api/alerts/${id}/resolve`, { method: 'POST' }),
    sendValveCommand: (valveId, action) =>
      request<ValveCommand>(`/api/valves/${valveId}/commands`, { method: 'POST', body: JSON.stringify({ action }) }),

    connect(onEvent, onStatus) {
      const connection = new HubConnectionBuilder()
        .withUrl(`${baseUrl}/hubs/live`, { accessTokenFactory: () => token ?? '' })
        .withAutomaticReconnect()
        .configureLogging(LogLevel.Warning)
        .build();

      connection.on('Readings', (readings: Reading[]) => onEvent({ type: 'readings', readings }));
      connection.on('NodeChanged', (node: MonitoringNode) => onEvent({ type: 'node', node }));
      connection.on('ValveChanged', (valve: Valve) => onEvent({ type: 'valve', valve }));
      connection.on('ValveCommandChanged', (command: ValveCommand) => onEvent({ type: 'valveCommand', command }));
      connection.on('AlertChanged', (alert: Alert) => onEvent({ type: 'alert', alert }));
      connection.on('LeakEventChanged', (leakEvent: LeakEvent) => onEvent({ type: 'leakEvent', leakEvent }));

      connection.onreconnecting(() => onStatus('reconnecting'));
      connection.onreconnected(() => onStatus('live'));
      connection.onclose(() => onStatus('disconnected'));

      onStatus('connecting');
      connection
        .start()
        .then(() => onStatus('live'))
        .catch(() => onStatus('disconnected'));

      return () => {
        if (connection.state !== HubConnectionState.Disconnected) void connection.stop();
      };
    },
  };
}
