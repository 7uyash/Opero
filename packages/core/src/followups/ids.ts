import { randomBytes } from "node:crypto";

/** Short sortable-enough unique id for run identifiers (time prefix + randomness). */
export function createId(): string {
  return `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}
