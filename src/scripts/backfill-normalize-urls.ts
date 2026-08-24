import { prisma } from "../config/db.config";
import { normalizeWebsiteUrl } from "../utils/url-normalizer";

const DRY_RUN = process.env.DRY_RUN !== "false";

async function backfillQuickScrapeBusiness(): Promise<{ updated: number; skipped: number; errors: number }> {
  const rows = await prisma.quickScrapeBusiness.findMany({
    select: { id: true, userId: true, businessWebsiteUrl: true },
  });
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  for (const row of rows) {
    const normalized = normalizeWebsiteUrl(row.businessWebsiteUrl);
    if (normalized === row.businessWebsiteUrl || !normalized) {
      skipped++;
      continue;
    }
    try {
      if (!DRY_RUN) {
        await prisma.quickScrapeBusiness.update({
          where: { id: row.id },
          data: { businessWebsiteUrl: normalized },
        });
      }
      updated++;
    } catch (e) {
      errors++;
      console.warn(`QuickScrapeBusiness ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { updated, skipped, errors };
}

async function backfillBusiness(): Promise<{ updated: number; skipped: number; errors: number }> {
  const rows = await prisma.business.findMany({
    select: { id: true, userId: true, businessWebsiteUrl: true },
  });
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  for (const row of rows) {
    const normalized = normalizeWebsiteUrl(row.businessWebsiteUrl);
    if (normalized === row.businessWebsiteUrl || !normalized) {
      skipped++;
      continue;
    }
    try {
      if (!DRY_RUN) {
        await prisma.business.update({
          where: { id: row.id },
          data: { businessWebsiteUrl: normalized },
        });
      }
      updated++;
    } catch (e) {
      errors++;
      console.warn(`Business ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { updated, skipped, errors };
}

async function main(): Promise<void> {
  console.log(`Backfill normalize URLs (DRY_RUN=${DRY_RUN})`);
  const qs = await backfillQuickScrapeBusiness();
  console.log(`QuickScrapeBusiness: updated=${qs.updated}, skipped=${qs.skipped}, errors=${qs.errors}`);
  const biz = await backfillBusiness();
  console.log(`Business: updated=${biz.updated}, skipped=${biz.skipped}, errors=${biz.errors}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
