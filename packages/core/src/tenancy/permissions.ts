import type { Role } from "@lfm/shared";

/** Every action that needs authorization. Keep in sync with docs/PLAN.md §8. */
export const PERMISSIONS = {
  "org:update": ["OWNER"],
  "org:delete": ["OWNER"],
  "data:export": ["OWNER"],
  "integrations:manage": ["OWNER", "ADMIN"],
  "automation:configure": ["OWNER", "ADMIN"],
  "automation:activate": ["OWNER", "ADMIN"],
  "templates:manage": ["OWNER", "ADMIN"],
  "templates:approve": ["OWNER", "ADMIN"],
  "members:view": ["OWNER", "ADMIN", "MANAGER", "SALESPERSON"],
  "members:manage": ["OWNER", "ADMIN", "MANAGER"],
  "leads:view_all": ["OWNER", "ADMIN", "MANAGER"],
  "leads:view_assigned": ["OWNER", "ADMIN", "MANAGER", "SALESPERSON"],
  "leads:create": ["OWNER", "ADMIN", "MANAGER", "SALESPERSON"],
  "leads:update": ["OWNER", "ADMIN", "MANAGER", "SALESPERSON"],
  "leads:assign": ["OWNER", "ADMIN", "MANAGER"],
  "leads:delete": ["OWNER", "ADMIN"],
  "messages:send": ["OWNER", "ADMIN", "MANAGER", "SALESPERSON"],
  "followups:manage": ["OWNER", "ADMIN", "MANAGER", "SALESPERSON"],
  "executions:view": ["OWNER", "ADMIN", "MANAGER"],
  "executions:retry": ["OWNER", "ADMIN"],
  "dashboard:view_team": ["OWNER", "ADMIN", "MANAGER"],
  "audit:view": ["OWNER", "ADMIN"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/** Roles a member with the given role may grant or manage. OWNER can never be granted through the UI. */
export function manageableRoles(actor: Role): Role[] {
  switch (actor) {
    case "OWNER":
    case "ADMIN":
      return ["ADMIN", "MANAGER", "SALESPERSON"];
    case "MANAGER":
      return ["SALESPERSON"];
    default:
      return [];
  }
}
