import { writeFileSync } from "fs";
import { mkdir, access } from "fs/promises";
import { constants } from "fs";
import { join } from "path";
import { prisma } from "../config/db.config";

type AuditRow = Record<string, string | number | null>;

async function ensureDir(path: string) {
  try {
    await access(path, constants.F_OK);
  } catch {
    await mkdir(path, { recursive: true });
  }
}

function toCsv(rows: AuditRow[], headers: string[]): string {
  const escape = (value: string | number | null) => {
    if (value === null || value === undefined) {
      return "";
    }

    const text = String(value);
    if (text.includes(",") || text.includes('"') || text.includes("\n")) {
      return `"${text.replace(/"/g, '""')}"`;
    }

    return text;
  };

  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escape(row[header] ?? null)).join(",")),
  ].join("\n");
}

async function hasLegacyUserIdColumn(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'GoogleMyBusiness'
        AND column_name = 'userId'
    ) AS "exists"
  `);

  return Boolean(rows[0]?.exists);
}

async function runAudit() {
  const outDir =
    process.env.AUDIT_OUTPUT_DIR || join(process.cwd(), "audit-output", "gmb");
  await ensureDir(outDir);

  const legacySchema = await hasLegacyUserIdColumn();

  const mappablePosts = legacySchema
    ? await prisma.$queryRawUnsafe<Array<AuditRow>>(`
        SELECT p."id", p."gmbId", g."id" AS "targetGmbId"
        FROM "GMBPost" p
        JOIN "GoogleMyBusiness" g
          ON p."gmbId" = g."userId"
        LEFT JOIN "GoogleMyBusiness" current_g
          ON p."gmbId" = current_g."id"
        WHERE current_g."id" IS NULL
      `)
    : [];

  const unresolvedPosts = legacySchema
    ? await prisma.$queryRawUnsafe<Array<AuditRow>>(`
        SELECT p."id", p."gmbId"
        FROM "GMBPost" p
        LEFT JOIN "GoogleMyBusiness" g_id
          ON p."gmbId" = g_id."id"
        LEFT JOIN "GoogleMyBusiness" g_user
          ON p."gmbId" = g_user."userId"
        WHERE g_id."id" IS NULL
          AND g_user."id" IS NULL
      `)
    : await prisma.$queryRawUnsafe<Array<AuditRow>>(`
        SELECT p."id", p."gmbId"
        FROM "GMBPost" p
        LEFT JOIN "GoogleMyBusiness" g
          ON p."gmbId" = g."id"
        WHERE g."id" IS NULL
      `);

  const mappableReviews = legacySchema
    ? await prisma.$queryRawUnsafe<Array<AuditRow>>(`
        SELECT r."id", r."reviewId", r."gmbId", g."id" AS "targetGmbId"
        FROM "GMBReview" r
        JOIN "GoogleMyBusiness" g
          ON r."gmbId" = g."userId"
        LEFT JOIN "GoogleMyBusiness" current_g
          ON r."gmbId" = current_g."id"
        WHERE current_g."id" IS NULL
      `)
    : [];

  const unresolvedReviews = legacySchema
    ? await prisma.$queryRawUnsafe<Array<AuditRow>>(`
        SELECT r."id", r."reviewId", r."gmbId"
        FROM "GMBReview" r
        LEFT JOIN "GoogleMyBusiness" g_id
          ON r."gmbId" = g_id."id"
        LEFT JOIN "GoogleMyBusiness" g_user
          ON r."gmbId" = g_user."userId"
        WHERE g_id."id" IS NULL
          AND g_user."id" IS NULL
      `)
    : await prisma.$queryRawUnsafe<Array<AuditRow>>(`
        SELECT r."id", r."reviewId", r."gmbId"
        FROM "GMBReview" r
        LEFT JOIN "GoogleMyBusiness" g
          ON r."gmbId" = g."id"
        WHERE g."id" IS NULL
      `);

  const report = {
    schema: legacySchema ? "legacy-user-scoped" : "business-scoped",
    mappablePostRows: mappablePosts.length,
    unresolvedPostRows: unresolvedPosts.length,
    mappableReviewRows: mappableReviews.length,
    unresolvedReviewRows: unresolvedReviews.length,
  };

  writeFileSync(join(outDir, "gmb_migration_audit.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    join(outDir, "gmb_posts_mappable.csv"),
    toCsv(mappablePosts, ["id", "gmbId", "targetGmbId"])
  );
  writeFileSync(
    join(outDir, "gmb_posts_unresolved.csv"),
    toCsv(unresolvedPosts, ["id", "gmbId"])
  );
  writeFileSync(
    join(outDir, "gmb_reviews_mappable.csv"),
    toCsv(mappableReviews, ["id", "reviewId", "gmbId", "targetGmbId"])
  );
  writeFileSync(
    join(outDir, "gmb_reviews_unresolved.csv"),
    toCsv(unresolvedReviews, ["id", "reviewId", "gmbId"])
  );

  console.log(JSON.stringify(report, null, 2));
  console.log("Audit written to:", outDir);
}

runAudit()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
