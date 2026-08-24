import { prisma } from "../config/db.config";
import {
  reconcilePrimaryWorkspace,
  selectPrimaryWorkspaceCandidate,
} from "../services/primary-workspace-reconciliation.service";
import { isPlatformStaffSubscriptionBypassRole } from "../utils/platform-role.utils";

const apply = process.argv.includes("--apply");

const users = await prisma.user.findMany({
  where: { business: { some: {} } },
  select: {
    id: true,
    email: true,
    role: true,
    business: {
      include: { websiteSubscription: { select: { status: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    },
  },
});

const mismatches: Array<{
  userId: string;
  email: string;
  currentPrimaryIds: string[];
  expectedPrimaryId: string | null;
}> = [];

for (const user of users) {
  const expected = selectPrimaryWorkspaceCandidate(
    user.business,
    isPlatformStaffSubscriptionBypassRole(user.role),
  );
  const currentPrimaryIds = user.business
    .filter((business) => business.isPrimary)
    .map((business) => business.id);
  if (
    currentPrimaryIds.length === (expected ? 1 : 0) &&
    currentPrimaryIds[0] === expected?.id
  ) {
    continue;
  }

  mismatches.push({
    userId: user.id,
    email: user.email,
    currentPrimaryIds,
    expectedPrimaryId: expected?.id ?? null,
  });
  if (apply) await reconcilePrimaryWorkspace(user.id);
}

console.info(
  JSON.stringify(
    {
      mode: apply ? "apply" : "dry-run",
      usersScanned: users.length,
      mismatches: mismatches.length,
      records: mismatches,
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
