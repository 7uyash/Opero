export const ROLES = ["OWNER", "ADMIN", "MANAGER", "SALESPERSON"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MANAGER: "Manager",
  SALESPERSON: "Salesperson",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  OWNER: "Full control of the business account.",
  ADMIN: "Sets up connections, automation and message templates.",
  MANAGER: "Manages the team and all leads.",
  SALESPERSON: "Works on the leads assigned to them.",
};
