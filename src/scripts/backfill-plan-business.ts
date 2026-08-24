import { writeFileSync } from "fs";
import { join } from "path";
import { prisma } from "../config/db.config";

type BackfillRow = { id: string; userId: string; businessId: string | null };

async function backfillPlanBusiness(): Promise<void> {
  const outDir = process.env.BACKFILL_OUTPUT_DIR || join(process.cwd(), "backfill-output");
  const dryRun = process.env.DRY_RUN === "true";

  const nullPlanRows = await prisma.plan.findMany({
    where: { businessId: null },
    select: { id: true, userId: true, businessId: true },
  });

  if (nullPlanRows.length === 0) {
    console.log("No Plan rows with businessId IS NULL. Nothing to backfill.");
    return;
  }

  const userIds = [...new Set(nullPlanRows.map((r) => r.userId))];
  const primaryByUser = new Map<string, string>();

  for (const uid of userIds) {
    const primary = await prisma.business.findFirst({
      where: { userId: uid, isActive: true, isPrimary: true },
      select: { id: true },
    });
    if (primary) {
      primaryByUser.set(uid, primary.id);
    }
  }

  const toUpdate: BackfillRow[] = [];
  const unresolved: BackfillRow[] = [];

  for (const row of nullPlanRows) {
    const primaryId = primaryByUser.get(row.userId);
    if (primaryId) {
      toUpdate.push({ ...row, businessId: primaryId });
    } else {
      unresolved.push({ ...row, businessId: null });
    }
  }

  console.log(`Plans with null businessId: ${nullPlanRows.length}`);
  console.log(`Will backfill (primary business): ${toUpdate.length}`);
  console.log(`Unresolved (no primary business): ${unresolved.length}`);

  if (!dryRun && toUpdate.length > 0) {
    for (const row of toUpdate) {
      await prisma.plan.update({
        where: { id: row.id },
        data: { businessId: row.businessId },
      });
    }
    console.log(`Updated ${toUpdate.length} rows.`);
  } else if (dryRun) {
    console.log("[DRY_RUN] No updates applied.");
  }

  try {
    const { mkdirSync } = await import("fs");
    mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }

  const csv = (rows: BackfillRow[], headers: string[]) =>
    [headers.join(","), ...rows.map((r) => headers.map((h) => String(r[h as keyof BackfillRow] ?? "")).join(","))].join("\n");

  writeFileSync(join(outDir, "backfill_applied.csv"), csv(toUpdate, ["id", "userId", "businessId"]));
  writeFileSync(join(outDir, "backfill_unresolved.csv"), csv(unresolved, ["id", "userId", "businessId"]));
  console.log("Output written to:", outDir);
}

backfillPlanBusiness()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
