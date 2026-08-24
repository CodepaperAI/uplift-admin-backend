import { writeFileSync } from "fs";
import { mkdir, access } from "fs/promises";
import { constants } from "fs";
import { join } from "path";
import { prisma } from "../config/db.config";
import {
  GMB_RECONNECT_REQUIRED_MESSAGE,
  GMB_TOKEN_ENCRYPTION_CONTEXT,
} from "../services/google-my-business.service";
import { encrypt, isEncrypted } from "../utils/encryption";

async function ensureDir(path: string) {
  try {
    await access(path, constants.F_OK);
  } catch {
    await mkdir(path, { recursive: true });
  }
}

async function migrateGmbTokens() {
  const outDir =
    process.env.BACKFILL_OUTPUT_DIR || join(process.cwd(), "backfill-output", "gmb");
  const dryRun = process.env.DRY_RUN === "true";

  await ensureDir(outDir);

  const rows = await prisma.googleMyBusiness.findMany({
    select: {
      id: true,
      businessId: true,
      accessToken: true,
      refreshToken: true,
      accountId: true,
      locationId: true,
      isActive: true,
      lastSyncError: true,
    },
  });

  const report = {
    totalRows: rows.length,
    encryptedRows: 0,
    skippedRows: 0,
    reconnectRequiredRows: 0,
    erroredRows: 0,
  };

  const reconnectRequiredBusinessIds: string[] = [];
  const failedBusinessIds: string[] = [];

  for (const row of rows) {
    try {
      const nextAccessToken =
        row.accessToken && !isEncrypted(row.accessToken)
          ? encrypt(row.accessToken, GMB_TOKEN_ENCRYPTION_CONTEXT)
          : row.accessToken;
      const nextRefreshToken =
        row.refreshToken && !isEncrypted(row.refreshToken)
          ? encrypt(row.refreshToken, GMB_TOKEN_ENCRYPTION_CONTEXT)
          : row.refreshToken;
      const requiresReconnect = !row.accountId || !row.locationId;

      if (
        nextAccessToken === row.accessToken &&
        nextRefreshToken === row.refreshToken &&
        (!requiresReconnect ||
          (!row.isActive && row.lastSyncError === GMB_RECONNECT_REQUIRED_MESSAGE))
      ) {
        report.skippedRows++;
        continue;
      }

      report.encryptedRows++;

      if (requiresReconnect) {
        report.reconnectRequiredRows++;
        reconnectRequiredBusinessIds.push(row.businessId);
      }

      if (!dryRun) {
        await prisma.googleMyBusiness.update({
          where: { id: row.id },
          data: {
            accessToken: nextAccessToken,
            refreshToken: nextRefreshToken,
            isActive: requiresReconnect ? false : row.isActive,
            lastSyncError: requiresReconnect
              ? row.lastSyncError ?? GMB_RECONNECT_REQUIRED_MESSAGE
              : row.lastSyncError,
          },
        });
      }
    } catch (error) {
      report.erroredRows++;
      failedBusinessIds.push(row.businessId);
      console.error(`Failed to migrate GMB tokens for ${row.businessId}:`, error);
    }
  }

  writeFileSync(
    join(outDir, "gmb_token_migration_report.json"),
    JSON.stringify(
      {
        ...report,
        dryRun,
        reconnectRequiredBusinessIds,
        failedBusinessIds,
      },
      null,
      2
    )
  );

  console.log(JSON.stringify(report, null, 2));
  console.log("Migration report written to:", outDir);

  if (report.erroredRows > 0) {
    process.exitCode = 1;
  }
}

migrateGmbTokens()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
