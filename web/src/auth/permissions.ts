import type { RoleName } from '../types';

/**
 * Who may do what. From the design document:
 *   administrator - manages users, devices and settings (and can do everything)
 *   operator      - monitors the network and operates valves
 *   technician    - device status and maintenance records
 *   engineer      - historical data and reports
 *
 * The backend must enforce the same rules ([Authorize(Roles = ...)]); hiding a
 * button in the browser is a convenience, not security.
 */
export type Permission =
  | 'dashboard.view'
  | 'network.view'
  | 'alerts.view'
  | 'alerts.acknowledge'
  | 'alerts.resolve'
  | 'valves.view'
  | 'valves.operate';

const grants: Record<RoleName, Permission[]> = {
  administrator: ['dashboard.view', 'network.view', 'alerts.view', 'alerts.acknowledge', 'alerts.resolve', 'valves.view', 'valves.operate'],
  operator: ['dashboard.view', 'network.view', 'alerts.view', 'alerts.acknowledge', 'alerts.resolve', 'valves.view', 'valves.operate'],
  technician: ['dashboard.view', 'network.view', 'alerts.view', 'alerts.acknowledge', 'valves.view'],
  engineer: ['dashboard.view', 'network.view', 'alerts.view'],
};

export function can(role: RoleName | undefined, permission: Permission): boolean {
  return !!role && grants[role].includes(permission);
}

export const roleLabel: Record<RoleName, string> = {
  administrator: 'Administrator',
  operator: 'Operator',
  technician: 'Technician',
  engineer: 'Engineer',
};
