import { NextResponse } from "next/server";
import { Errors, resolveOrgContext, setActiveOrganization } from "@lfm/core";
import { switchOrganizationSchema } from "@lfm/shared";
import { publicRoute, readJson } from "@/lib/api";
import { getAuth } from "@/lib/session";

export const POST = publicRoute(async (req) => {
  const auth = await getAuth();
  if (!auth) throw Errors.unauthenticated();
  const { organizationId } = switchOrganizationSchema.parse(await readJson(req));
  // Only switch into a business the user is an active member of.
  const ctx = await resolveOrgContext(auth.session.user.id, organizationId);
  if (!ctx) throw Errors.notFound("Business");
  await setActiveOrganization(auth.session.sessionId, organizationId);
  return NextResponse.json({ organizationId });
});
