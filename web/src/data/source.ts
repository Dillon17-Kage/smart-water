import type {
  Alert,
  LeakEvent,
  MonitoringNode,
  Reading,
  Rig,
  User,
  Valve,
  ValveAction,
  ValveCommand,
} from '../types';

/**
 * Everything the web app needs from the backend.
 *
 * Two implementations exist:
 *   - mock: an in-browser simulator of the two-zone rig (src/data/mock)
 *   - api:  the ASP.NET Core Web API + SignalR hub (src/data/api)
 *
 * Pages never import either one directly; they go through this interface,
 * so switching from the simulator to the real backend is one setting
 * (VITE_DATA_SOURCE in .env).
 */
export interface DataSource {
  readonly kind: 'mock' | 'api';

  /** Throws LoginError with a user-facing message on failure. */
  login(username: string, password: string): Promise<{ user: User; token: string }>;
  /** Restore a session saved in sessionStorage. */
  resume(token: string): void;
  logout(): void;

  getRig(): Promise<Rig>;
  /** Readings for every sensor over the last `seconds`, oldest first. */
  getRecentReadings(seconds: number): Promise<Reading[]>;
  getAlerts(): Promise<Alert[]>;
  getLeakEvents(): Promise<LeakEvent[]>;
  getValveCommands(): Promise<ValveCommand[]>;

  acknowledgeAlert(alertId: number): Promise<Alert>;
  resolveAlert(alertId: number): Promise<Alert>;
  /** Resolves with the command as recorded. A rejected command is not an error. */
  sendValveCommand(valveId: number, action: ValveAction): Promise<ValveCommand>;

  /** Subscribe to live pushes. Returns an unsubscribe function. */
  connect(onEvent: (event: LiveEvent) => void, onStatus: (status: ConnectionStatus) => void): () => void;
}

/** Messages pushed by the SignalR hub (or the simulator). */
export type LiveEvent =
  | { type: 'readings'; readings: Reading[] }
  | { type: 'node'; node: MonitoringNode }
  | { type: 'valve'; valve: Valve }
  | { type: 'valveCommand'; command: ValveCommand }
  | { type: 'alert'; alert: Alert }
  | { type: 'leakEvent'; leakEvent: LeakEvent };

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'disconnected';

export class LoginError extends Error {}
