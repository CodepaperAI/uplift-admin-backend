// One-shot sweep: re-evaluates `isClient` on GMBLocalRankResult rows using the
// current calculateLocalResultMatchConfidence logic. Use after the matcher
// changes so existing scan history reflects the new rules without consuming
// DataForSEO quota or hitting the rank-scan cadence gate.
//
// Usage:
//   bun run src/scripts/backfill-gmb-local-rank-isclient.ts                       # all active GMB connections
//   bun run src/scripts/backfill-gmb-local-rank-isclient.ts --businessId <id>     # one business only
//   bun run src/scripts/backfill-gmb-local-rank-isclient.ts --dry-run             # report changes, don't write
//
// Idempotent: re-running with no schema changes leaves rows untouched.

import { prisma } from "../config/db.config";
import { calculateLocalResultMatchConfidence } from "../services/gmb-local-visibility.service";

type Args = { businessId: string | null; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { businessId: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--businessId") {
      args.businessId = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `[isclient-backfill] starting (businessId=${args.businessId ?? "all"}, dryRun=${args.dryRun})`,
  );

  const where = args.businessId
    ? { businessId: args.businessId, isActive: true }
    : { isActive: true };

  const connections = await prisma.googleMyBusiness.findMany({
    where,
    select: {
      businessId: true,
      businessName: true,
      businessAddress: true,
      businessWebsite: true,
      placeId: true,
      business: {
        select: {
          businessName: true,
          businessAddress: true,
          businessWebsiteUrl: true,
        },
      },
    },
  });

  console.log(`[isclient-backfill] found ${connections.length} GMB connection(s)`);

  const totals = { businesses: 0, resultsScanned: 0, flipped: 0, errors: 0 };

  for (const gmb of connections) {
    totals.businesses += 1;
    const businessName = gmb.businessName ?? gmb.business.businessName;
    const businessAddress = gmb.businessAddress ?? gmb.business.businessAddress;
    const businessWebsite = gmb.businessWebsite ?? gmb.business.businessWebsiteUrl;

    try {
      const results = await prisma.gMBLocalRankResult.findMany({
        where: { scan: { businessId: gmb.businessId, status: "COMPLETE" } },
        select: {
          id: true,
          title: true,
          placeId: true,
          cid: true,
          domain: true,
          url: true,
          address: true,
          isClient: true,
          matchedBy: true,
          matchConfidence: true,
        },
      });

      for (const r of results) {
        totals.resultsScanned += 1;
        const match = calculateLocalResultMatchConfidence({
          result: {
            title: r.title,
            placeId: r.placeId,
            cid: r.cid,
            domain: r.domain,
            url: r.url,
            address: r.address,
          },
          businessName,
          businessAddress,
          businessWebsite,
          placeId: gmb.placeId,
        });
        const newIsClient =
          match.confidence >= 0.75 && match.matchedBy !== "fuzzy_name";

        if (
          newIsClient !== r.isClient ||
          match.matchedBy !== r.matchedBy ||
          match.confidence !== r.matchConfidence
        ) {
          totals.flipped += 1;
          if (!args.dryRun) {
            await prisma.gMBLocalRankResult.update({
              where: { id: r.id },
              data: {
                isClient: newIsClient,
                matchedBy: match.matchedBy,
                matchConfidence: match.confidence,
              },
            });
          }
        }
      }
    } catch (error) {
      totals.errors += 1;
      console.error(
        `[isclient-backfill] businessId=${gmb.businessId} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.log(`[isclient-backfill] done`, totals);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
