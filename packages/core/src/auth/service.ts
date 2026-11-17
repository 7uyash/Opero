import { prisma, isUniqueViolation } from "@lfm/db";
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from "@lfm/shared";
import { AppError, Errors } from "../errors";
import { audit } from "../audit/audit";
import { burnPasswordCheck, hashPassword, verifyPassword } from "./password";
import { createSession, type SessionMeta } from "./sessions";

/** Creates a user, their organization and the owner membership atomically, then opens a session. */
export async function registerOwner(raw: RegisterInput, meta: SessionMeta = {}) {
  const input = registerSchema.parse(raw);
  const passwordHash = await hashPassword(input.password);

  try {
    const { user, org } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email: input.email, name: input.name, passwordHash },
      });
      const org = await tx.organization.create({
        data: {
          name: input.businessName,
          email: input.businessEmail,
          businessType: input.businessType || null,
          website: input.website ?? null,
          timezone: input.timezone,
          workingHours: defaultWorkingHours(),
        },
      });
      await tx.organizationMember.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          role: "OWNER",
          status: "ACTIVE",
          // Owners take leads by default in small teams; can be switched off in settings.
          receivesLeads: true,
          isFallbackManager: true,
        },
      });
      await tx.assignmentCursor.create({ data: { organizationId: org.id } });
      await tx.leadSource.create({ data: { organizationId: org.id, type: "MANUAL", label: "Manual entry" } });
      await audit(
        {
          organizationId: org.id,
          actorUserId: user.id,
          action: "organization.created",
          targetType: "organization",
          targetId: org.id,
          ip: meta.ip,
        },
        tx,
      );
      return { user, org };
    });

    const session = await createSession(user.id, org.id, meta);
    return { userId: user.id, organizationId: org.id, session };
  } catch (err) {
    if (isUniqueViolation(err, "email")) {
      throw Errors.conflict("An account with this email already exists. Try signing in instead.", {
        email: "This email is already registered",
      });
    }
    throw err;
  }
}

export async function login(raw: LoginInput, meta: SessionMeta = {}) {
  const input = loginSchema.parse(raw);
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const ok = user ? await verifyPassword(input.password, user.passwordHash) : await burnPasswordCheck(input.password);

  if (!user || !ok) {
    await audit({ actorUserId: user?.id, action: "auth.login_failed", ip: meta.ip });
    throw new AppError("INVALID_CREDENTIALS", "Incorrect email or password.", 401);
  }

  const membership = await prisma.organizationMember.findFirst({
    where: { userId: user.id, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
  const session = await createSession(user.id, membership?.organizationId ?? null, meta);
  await audit({ organizationId: membership?.organizationId, actorUserId: user.id, action: "auth.login", ip: meta.ip });
  return { userId: user.id, organizationId: membership?.organizationId ?? null, session };
}

/** Mon–Fri 09:00–18:00 in the organization's timezone. */
export function defaultWorkingHours() {
  const day = [{ start: "09:00", end: "18:00" }];
  return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: [], sun: [] };
}
