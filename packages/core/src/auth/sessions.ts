import { prisma, type Db } from "@lfm/db";
import { hashToken, randomToken } from "../crypto/tokens";

export const SESSION_COOKIE = "lfm_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Extend the expiry at most once per this interval to avoid a write on every request. */
const ROLLING_REFRESH_MS = 24 * 60 * 60 * 1000;

export type SessionMeta = { ip?: string | null; userAgent?: string | null };

export async function createSession(
  userId: string,
  activeOrganizationId: string | null,
  meta: SessionMeta = {},
  db: Db = prisma,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      activeOrganizationId,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    },
  });
  return { token, expiresAt };
}

export type ValidatedSession = {
  sessionId: string;
  expiresAt: Date;
  refreshed: boolean;
  user: { id: string; email: string; name: string };
  activeOrganizationId: string | null;
};

/** Looks up a session by its cookie token. Returns null when missing, expired or revoked. */
export async function validateSession(token: string | undefined | null, db: Db = prisma): Promise<ValidatedSession | null> {
  if (!token || token.length > 200) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, name: true } } },
  });
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  let expiresAt = session.expiresAt;
  let refreshed = false;
  if (now - session.lastSeenAt.getTime() > ROLLING_REFRESH_MS) {
    expiresAt = new Date(now + SESSION_TTL_MS);
    refreshed = true;
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now), expiresAt } });
  }
  return {
    sessionId: session.id,
    expiresAt,
    refreshed,
    user: session.user,
    activeOrganizationId: session.activeOrganizationId,
  };
}

export async function revokeSession(token: string, db: Db = prisma): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function revokeAllUserSessions(userId: string, db: Db = prisma): Promise<void> {
  await db.session.deleteMany({ where: { userId } });
}

export async function setActiveOrganization(sessionId: string, organizationId: string, db: Db = prisma) {
  await db.session.update({ where: { id: sessionId }, data: { activeOrganizationId: organizationId } });
}
