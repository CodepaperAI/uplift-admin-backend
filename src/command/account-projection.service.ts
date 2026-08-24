import type { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";

type CommandDb = typeof prisma | Prisma.TransactionClient;

export function normalizeCommandAccountEmail(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.includes("@") ? normalized : null;
}

async function accountContext(
  db: CommandDb,
  input: {
    email?: string | null;
    userId?: string | null;
    businessId?: string | null;
    assignedToGhlId?: string | null;
  },
) {
  const normalizedEmail = normalizeCommandAccountEmail(input.email);
  const user = input.userId
    ? await db.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, name: true },
      })
    : normalizedEmail
      ? await db.user.findFirst({
          where: { email: { equals: normalizedEmail, mode: "insensitive" } },
          select: { id: true, email: true, name: true },
        })
      : null;
  const business = input.businessId
    ? await db.business.findUnique({
        where: { id: input.businessId },
        select: {
          id: true,
          businessName: true,
          userId: true,
          SalesCustomerAssignment: {
            select: {
              salesperson: {
                select: { CommandRepProfile: { select: { id: true } } },
              },
            },
          },
        },
      })
    : user
      ? await db.business.findFirst({
          where: { userId: user.id },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          select: {
            id: true,
            businessName: true,
            userId: true,
            SalesCustomerAssignment: {
              select: {
                salesperson: {
                  select: { CommandRepProfile: { select: { id: true } } },
                },
              },
            },
          },
        })
      : null;
  const ghlOwner = input.assignedToGhlId
    ? await db.commandRepProfile.findUnique({
        where: { ghlUserId: input.assignedToGhlId },
        select: { id: true },
      })
    : null;

  return {
    normalizedEmail:
      normalizedEmail ?? normalizeCommandAccountEmail(user?.email) ?? null,
    userId: user?.id ?? business?.userId ?? input.userId ?? null,
    businessId: business?.id ?? input.businessId ?? null,
    ownerRepId:
      ghlOwner?.id ??
      business?.SalesCustomerAssignment?.salesperson.CommandRepProfile?.id ??
      null,
    internalName:
      business?.businessName?.trim() || user?.name?.trim() || null,
    fallbackName: normalizedEmail || "Unknown account",
  };
}

export function canMergeCommandAccountIdentity(
  existing: { stripeCustomerId: string | null; ghlContactId: string | null },
  incoming: {
    stripeCustomerId?: string | null;
    ghlContactId?: string | null;
  },
): boolean {
  return !(
    (incoming.stripeCustomerId &&
      existing.stripeCustomerId &&
      incoming.stripeCustomerId !== existing.stripeCustomerId) ||
    (incoming.ghlContactId &&
      existing.ghlContactId &&
      incoming.ghlContactId !== existing.ghlContactId)
  );
}

async function findCommandAccountByProvider(
  db: CommandDb,
  identity: {
    stripeCustomerId?: string | null;
    ghlContactId?: string | null;
  },
) {
  if (identity.stripeCustomerId) {
    const match = await db.commandAccount.findUnique({
      where: { stripeCustomerId: identity.stripeCustomerId },
    });
    if (match) return match;
  }
  if (identity.ghlContactId) {
    const match = await db.commandAccount.findUnique({
      where: { ghlContactId: identity.ghlContactId },
    });
    if (match) return match;
  }
  return null;
}

export async function projectCommandAccount(
  input: {
    stripeCustomerId?: string | null;
    ghlContactId?: string | null;
    name?: string | null;
    email?: string | null;
    userId?: string | null;
    businessId?: string | null;
    assignedToGhlId?: string | null;
  },
  db: CommandDb = prisma,
) {
  if (!input.stripeCustomerId && !input.ghlContactId) return null;
  const context = await accountContext(db, input);
  let normalizedEmail = context.normalizedEmail;
  let existing = await findCommandAccountByProvider(db, input);
  if (
    existing &&
    normalizedEmail &&
    existing.normalizedEmail !== normalizedEmail
  ) {
    const emailOwner = await db.commandAccount.findUnique({
      where: { normalizedEmail },
      select: { id: true },
    });
    if (emailOwner && emailOwner.id !== existing.id) {
      normalizedEmail = existing.normalizedEmail;
    }
  }
  if (!existing && normalizedEmail) {
    const emailMatch = await db.commandAccount.findUnique({
      where: { normalizedEmail },
    });
    if (emailMatch && canMergeCommandAccountIdentity(emailMatch, input)) {
      existing = emailMatch;
    } else if (emailMatch) {
      // Duplicate provider contacts/customers can share an email. Preserve
      // both stable provider identities instead of overwriting the first one.
      normalizedEmail = null;
    }
  }
  const data = {
    name:
      context.internalName || input.name?.trim() || context.fallbackName,
    normalizedEmail,
    stripeCustomerId: input.stripeCustomerId ?? existing?.stripeCustomerId ?? null,
    ghlContactId: input.ghlContactId ?? existing?.ghlContactId ?? null,
    ownerRepId: context.ownerRepId ?? existing?.ownerRepId ?? null,
    userId: context.userId ?? existing?.userId ?? null,
    businessId: context.businessId ?? existing?.businessId ?? null,
  };

  return existing
    ? db.commandAccount.update({ where: { id: existing.id }, data })
    : db.commandAccount.create({ data });
}

export async function projectCommandAccountGhlOwner(
  ghlContactId: string | null | undefined,
  assignedToGhlId: string | null | undefined,
): Promise<void> {
  if (!ghlContactId || !assignedToGhlId) return;
  const rep = await prisma.commandRepProfile.findUnique({
    where: { ghlUserId: assignedToGhlId },
    select: { id: true },
  });
  if (!rep) return;
  await prisma.commandAccount.updateMany({
    where: { ghlContactId },
    data: { ownerRepId: rep.id },
  });
}
