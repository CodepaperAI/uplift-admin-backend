import { writeFileSync } from "fs";
import { join } from "path";
import { prisma } from "../config/db.config";

type AuditRow = Record<string, string | number | null>;

async function runAudit(): Promise<void> {
  const outDir = process.env.AUDIT_OUTPUT_DIR || join(process.cwd(), "audit-output");
  const baseline: Record<string, number | string> = {};
  const affectedRows: {
    plan_null_business: AuditRow[];
    users_multiple_primary: AuditRow[];
    integrations_null_business: AuditRow[];
  } = {
    plan_null_business: [],
    users_multiple_primary: [],
    integrations_null_business: [],
  };

  const planNullBusiness = await prisma.plan.count({
    where: { businessId: null, deletedAt: null },
  });
  baseline["plan_businessId_null_active"] = planNullBusiness;

  const planNullAll = await prisma.plan.count({
    where: { businessId: null },
  });
  baseline["plan_businessId_null_total"] = planNullAll;

  const planRows = await prisma.plan.findMany({
    where: { businessId: null },
    select: { id: true, userId: true, keyword: true, publishDate: true, deletedAt: true, createdAt: true },
  });
  affectedRows.plan_null_business = planRows.map((r) => ({
    id: r.id,
    userId: r.userId,
    keyword: r.keyword,
    publishDate: r.publishDate,
    deletedAt: r.deletedAt ? r.deletedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));

  const primaryCounts = await prisma.business.groupBy({
    by: ["userId"],
    where: { isPrimary: true },
    _count: { id: true },
  });
  const usersWithMultiplePrimary = primaryCounts.filter((g) => g._count.id > 1);
  baseline["users_with_multiple_primary_business"] = usersWithMultiplePrimary.length;

  for (const g of usersWithMultiplePrimary) {
    const businesses = await prisma.business.findMany({
      where: { userId: g.userId, isPrimary: true },
      select: { id: true, userId: true, businessName: true, businessWebsiteUrl: true, isPrimary: true },
    });
    for (const b of businesses) {
      affectedRows.users_multiple_primary.push({
        id: b.id,
        userId: b.userId,
        businessName: b.businessName,
        businessWebsiteUrl: b.businessWebsiteUrl ?? "",
        isPrimary: b.isPrimary ? 1 : 0,
      });
    }
  }

  const publishingIntegrations = await prisma.publishingIntegration.findMany({
    where: { businessId: null },
    select: { id: true, userId: true, platform: true, createdAt: true },
  });
  baseline["publishing_integrations_businessId_null"] = publishingIntegrations.length;
  affectedRows.integrations_null_business = publishingIntegrations.map((r) => ({
    id: r.id,
    userId: r.userId,
    platform: String(r.platform),
    createdAt: r.createdAt.toISOString(),
  }));

  const totalKeywords = await prisma.plan.count({ where: { deletedAt: null } });
  const totalBlogs = await prisma.blog.count();
  baseline["keywords_total_active"] = totalKeywords;
  baseline["blogs_total"] = totalBlogs;

  console.log("=== Pre-migration audit baseline ===\n");
  console.log(JSON.stringify(baseline, null, 2));
  console.log("\n=== Affected row counts ===");
  console.log("Plan.businessId IS NULL:", affectedRows.plan_null_business.length);
  console.log("Users with >1 primary business:", affectedRows.users_multiple_primary.length);
  console.log("PublishingIntegrations businessId IS NULL:", affectedRows.integrations_null_business.length);

  try {
    const { mkdirSync } = await import("fs");
    mkdirSync(outDir, { recursive: true });
  } catch {
    // ignore
  }

  const csvEscape = (v: string | number | null): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const toCsv = (rows: AuditRow[], headers: string[]): string => {
    const headerLine = headers.join(",");
    const dataLines = rows.map((r) => headers.map((h) => csvEscape(r[h] ?? null)).join(","));
    return [headerLine, ...dataLines].join("\n");
  };

  const planHeaders = ["id", "userId", "keyword", "publishDate", "deletedAt", "createdAt"];
  const planCsv = toCsv(affectedRows.plan_null_business, planHeaders);
  writeFileSync(join(outDir, "plan_null_businessId.csv"), planCsv);

  const userHeaders = ["id", "userId", "businessName", "businessWebsiteUrl", "isPrimary"];
  const userCsv = toCsv(affectedRows.users_multiple_primary, userHeaders);
  writeFileSync(join(outDir, "users_multiple_primary.csv"), userCsv);

  const intHeaders = ["id", "userId", "platform", "createdAt"];
  const intCsv = toCsv(affectedRows.integrations_null_business, intHeaders);
  writeFileSync(join(outDir, "integrations_null_businessId.csv"), intCsv);

  writeFileSync(join(outDir, "baseline.json"), JSON.stringify(baseline, null, 2));
  console.log("\nOutput written to:", outDir);
}

runAudit()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
