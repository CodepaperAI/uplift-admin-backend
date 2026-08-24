// One-shot deploy-time sweep: populates the phase 1 ranking-foundations
// tables (GMBBusinessHours, GMBSpecialHours, GMBCategory, GMBAttribute) for
// every business that has a GoogleMyBusiness snapshot but no structured rows
// yet.
//
// Usage:
//   bun run src/scripts/backfill-gmb-structured-data.ts            # skip already-backfilled
//   bun run src/scripts/backfill-gmb-structured-data.ts --force    # rebuild every business
//   bun run src/scripts/backfill-gmb-structured-data.ts --limit 10 # cap for dry runs
//
// Safe to re-run; the per-business function deletes prior rows inside a
// transaction before inserting.

import { backfillStructuredDataForBusiness } from "../lib/gmb-hours-backfill";
import { prisma } from "../config/db.config";

type Args = { force: boolean; limit: number | null };

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, limit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--force") args.force = true;
    else if (a === "--limit") {
      const next = argv[i + 1];
      const n = next ? Number.parseInt(next, 10) : NaN;
      if (Number.isFinite(n) && n > 0) args.limit = n;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[gmb-backfill-sweep] starting (force=${args.force}, limit=${args.limit ?? "none"})`,
  );

  const connections = await prisma.googleMyBusiness.findMany({
    where: { isActive: true },
    select: { businessId: true },
    take: args.limit ?? undefined,
  });

  console.log(`[gmb-backfill-sweep] found ${connections.length} active GMB connections`);

  const totals = {
    processed: 0,
    skipped: 0,
    hoursWritten: 0,
    specialHoursWritten: 0,
    categoriesWritten: 0,
    attributesWritten: 0,
    errors: 0,
  };

  for (const { businessId } of connections) {
    try {
      const summary = await backfillStructuredDataForBusiness(businessId, {
        force: args.force,
      });
      if (summary.skipped) {
        totals.skipped += 1;
        if (totals.skipped <= 3) {
          console.log(`[gmb-backfill-sweep] ${businessId} skipped (${summary.skipped})`);
        }
      } else {
        totals.processed += 1;
        totals.hoursWritten += summary.hoursWritten;
        totals.specialHoursWritten += summary.specialHoursWritten;
        totals.categoriesWritten += summary.categoriesWritten;
        totals.attributesWritten += summary.attributesWritten;
        totals.errors += summary.errors.length;
        console.log(
          `[gmb-backfill-sweep] ${businessId} ok: ${summary.hoursWritten}h ${summary.specialHoursWritten}sh ${summary.categoriesWritten}c ${summary.attributesWritten}a (parse_errors=${summary.errors.length})`,
        );
      }
    } catch (err) {
      totals.errors += 1;
      console.error(`[gmb-backfill-sweep] ${businessId} FAILED:`, err);
    }
  }

  console.log("");
  console.log("[gmb-backfill-sweep] done");
  console.log(JSON.stringify(totals, null, 2));
}

main()
  .catch((err) => {
    console.error("[gmb-backfill-sweep] fatal:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
