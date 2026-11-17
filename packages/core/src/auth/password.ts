import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const COST = process.env.NODE_ENV === "test" ? 4 : 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a full bcrypt comparison against a throwaway hash so that "unknown email"
 * and "wrong password" take the same time (prevents account enumeration by timing).
 */
export async function burnPasswordCheck(password: string): Promise<false> {
  dummyHash ??= bcrypt.hash(randomBytes(16).toString("hex"), COST);
  await bcrypt.compare(password, await dummyHash);
  return false;
}
