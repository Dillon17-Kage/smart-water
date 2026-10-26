import { can } from '../../auth/permissions';
import type { User } from '../../types';
import { LoginError, type DataSource } from '../source';
import * as rig from './rig';
import { RigSimulator } from './simulator';

/** One simulator per browser tab, shared by every page. */
export const simulator = new RigSimulator();

interface LoginState {
  failed: number;
  lockedUntil: number | null;
}

const delay = <T>(value: T, ms = 150) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

export function createMockSource(): DataSource {
  const loginState = new Map<string, LoginState>();
  let current: User | null = null;

  const userFromToken = (token: string): User | null => {
    const username = token.replace(/^mock-token:/, '');
    const found = rig.demoUsers.find((u) => u.username === username);
    return found ? { id: found.id, username: found.username, fullName: found.fullName, role: found.role } : null;
  };

  const requireUser = (): User => {
    if (!current) throw new Error('Not signed in');
    return current;
  };

  return {
    kind: 'mock',

    // Follows the login activity diagram: unknown user, locked account,
    // wrong password (count it, lock after too many), success (reset counter).
    async login(username, password) {
      await delay(null, 400);
      const name = username.trim().toLowerCase();
      const found = rig.demoUsers.find((u) => u.username === name);
      if (!found) throw new LoginError('Incorrect username or password.');

      const state = loginState.get(name) ?? { failed: 0, lockedUntil: null };
      if (state.lockedUntil && state.lockedUntil > Date.now()) {
        const minutes = Math.ceil((state.lockedUntil - Date.now()) / 60000);
        throw new LoginError(`This account is locked after too many failed attempts. Try again in ${minutes} min.`);
      }
      if (password !== rig.DEMO_PASSWORD) {
        state.failed += 1;
        if (state.failed >= rig.MAX_FAILED_LOGINS) {
          state.lockedUntil = Date.now() + rig.LOCKOUT_MINUTES * 60000;
          state.failed = 0;
          loginState.set(name, state);
          throw new LoginError(`Too many failed attempts. The account is locked for ${rig.LOCKOUT_MINUTES} minutes.`);
        }
        loginState.set(name, state);
        const left = rig.MAX_FAILED_LOGINS - state.failed;
        throw new LoginError(`Incorrect username or password. ${left} attempt${left === 1 ? '' : 's'} left before the account locks.`);
      }

      loginState.delete(name);
      current = { id: found.id, username: found.username, fullName: found.fullName, role: found.role };
      return { user: current, token: `mock-token:${found.username}` };
    },

    resume(token) {
      current = userFromToken(token);
    },

    logout() {
      current = null;
    },

    async getRig() {
      return delay({
        zones: rig.zones,
        nodes: simulator.nodes.map((n) => ({ ...n })),
        sensors: rig.sensors,
        valves: simulator.valves.map((v) => ({ ...v })),
        baselines: rig.baselines,
        settings: rig.settings,
      });
    },

    async getRecentReadings(seconds) {
      return delay(simulator.getRecentReadings(seconds));
    },
    async getAlerts() {
      return delay(simulator.getAlerts());
    },
    async getLeakEvents() {
      return delay(simulator.getLeakEvents());
    },
    async getValveCommands() {
      return delay(simulator.getCommands());
    },

    async acknowledgeAlert(alertId) {
      const user = requireUser();
      if (!can(user.role, 'alerts.acknowledge')) throw new Error('Your role cannot acknowledge alerts.');
      return delay(simulator.acknowledgeAlert(alertId, user.username));
    },
    async resolveAlert(alertId) {
      const user = requireUser();
      if (!can(user.role, 'alerts.resolve')) throw new Error('Your role cannot resolve alerts.');
      return delay(simulator.resolveAlert(alertId, user.username));
    },
    async sendValveCommand(valveId, action) {
      const user = requireUser();
      if (!can(user.role, 'valves.operate')) throw new Error('Your role cannot operate valves.');
      return delay(simulator.sendValveCommand(valveId, action, user.username), 100);
    },

    connect(onEvent, onStatus) {
      onStatus('connecting');
      const timer = setTimeout(() => onStatus('live'), 300);
      const unsubscribe = simulator.subscribe(onEvent);
      return () => {
        clearTimeout(timer);
        unsubscribe();
        onStatus('disconnected');
      };
    },
  };
}
