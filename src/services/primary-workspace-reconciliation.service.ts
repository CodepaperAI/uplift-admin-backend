import type { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { isPlatformStaffSubscriptionBypassRole } from "../utils/platform-role.utils";
import {
  resolveWebsiteWorkspaceAccess,
  type WebsiteWorkspaceAccessInput,
} from "../utils/website-workspace-access.utils";

type PrimaryCandidate = WebsiteWorkspaceAccessInput & {
  id: string;
  isPrimary: boolean;
};

/**
 * Serialize primary-workspace mutations for one account. The PostgreSQL
 * advisory transaction lock releases automatically on commit or rollback.
 */
export async function lockPrimaryWorkspaceSelection(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
): Promise<void> {
  const key = `workspace-primary:${userId}`;
  // Project only a supported integer column; Prisma's pg adapter cannot
  // deserialize PostgreSQL's `void` return type from the lock function.
  await tx.$queryRaw`
    SELECT 1::int AS "acquired"
    FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))
  `;
}

export function selectPrimaryWorkspaceCandidate(
  websites: PrimaryCandidate[],
  hasAdminAccess = false,
): PrimaryCandidate | null {
  const accessible = websites.filter(
    (website) =>
      resolveWebsiteWorkspaceAccess(website, { hasAdminAccess })
        .canAccessWorkspace,
  );
  return accessible.find((website) => website.isPrimary) ?? accessible[0] ?? null;
}

/**
 * Enforces the product-selection invariant after billing lifecycle changes:
 * exactly one accessible workspace is primary, or none when the account has
 * no accessible workspace. Inactive/canceled records remain owned records for
 * billing and recovery, but are never left as the product primary.
 */
export async function reconcilePrimaryWorkspace(userId: string): Promise<{
  selectedBusinessId: string | null;
  changed: boolean;
}> {
  const result = await prisma.$transaction(async (tx) => {
    await lockPrimaryWorkspaceSelection(tx, userId);
    const [owner, websites] = await Promise.all([
      tx.user.findUnique({ where: { id: userId }, select: { role: true } }),
      tx.business.findMany({
        where: { userId },
        include: { websiteSubscription: { select: { status: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);
    const selected = selectPrimaryWorkspaceCandidate(
      websites,
      owner ? isPlatformStaffSubscriptionBypassRole(owner.role) : false,
    );
    const alreadyConsistent = websites.every(
      (website) => website.isPrimary === (website.id === selected?.id),
    );
    if (alreadyConsistent) {
      return { selectedBusinessId: selected?.id ?? null, changed: false };
    }

    await tx.business.updateMany({
      where: { userId, isPrimary: true },
      data: { isPrimary: false },
    });
    if (selected) {
      await tx.business.update({
        where: { id: selected.id },
        data: { isPrimary: true },
      });
    }
    return { selectedBusinessId: selected?.id ?? null, changed: true };
  });

  if (result.changed) {
    console.info("[workspace-primary] selection reconciled", {
      userId,
      selectedBusinessId: result.selectedBusinessId,
    });
  }
  return result;
}

export async function reconcilePrimaryWorkspaceSafely(
  userId: string,
): Promise<void> {
  try {
    await reconcilePrimaryWorkspace(userId);
  } catch (error) {
    // Billing provider state has already changed by the time most callers run.
    // Record the repair failure without converting a successful Stripe action
    // into a misleading client failure; webhook/reconciliation retries can
    // safely execute this idempotent repair again.
    console.error("[workspace-primary] reconciliation failed", {
      userId,
      error,
    });
  }
}
