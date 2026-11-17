import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, resolveOrgContext, validateSession, type OrgContext, type ValidatedSession } from "@lfm/core";
import { prisma } from "@lfm/db";

export type Auth = { session: ValidatedSession; ctx: OrgContext | null };

export async function setSessionCookie(token: string, expiresAt: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** Current session + organization context, memoized per request. */
export const getAuth = cache(async (): Promise<Auth | null> => {
  const session = await validateSession(await readSessionToken());
  if (!session) return null;
  const ctx = await resolveOrgContext(session.user.id, session.activeOrganizationId);
  return { session, ctx };
});

/** For server components/pages: redirect to login when not signed in or without an organization. */
export async function requireAuth(): Promise<{ session: ValidatedSession; ctx: OrgContext }> {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  if (!auth.ctx) redirect("/login?error=no-organization");
  return { session: auth.session, ctx: auth.ctx };
}

export const getOrganization = cache(async (organizationId: string) =>
  prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
);
