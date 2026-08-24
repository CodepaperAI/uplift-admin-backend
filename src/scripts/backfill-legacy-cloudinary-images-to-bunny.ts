import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Prisma } from "@prisma/client";

import { prisma } from "../config/db.config";
import {
  type ImageUploadReceipt,
  uploadImageBufferWithMetadata,
} from "../lib/image-storage";
import { fetchPublicResource } from "../services/social-creative/safe-fetch";

const PRODUCTION_APPROVAL = "APPLY_BUNNY_IMAGE_BACKFILL";
const CLOUDINARY_URL = /https:\/\/res\.cloudinary\.com\/[^"'\s<>)\\]+/g;

type Target = {
  table: string;
  column: string;
  kind: "text" | "jsonb";
};

type TargetRow = {
  id: string;
  value: string;
};

const TARGETS: Target[] = [
  { table: "Blog", column: "analytics", kind: "jsonb" },
  { table: "Blog", column: "content", kind: "text" },
  { table: "Blog", column: "featured_media", kind: "text" },
  { table: "blog_generation_run", column: "metadata", kind: "jsonb" },
  { table: "social_creative_asset", column: "imageUrl", kind: "text" },
  {
    table: "social_creative_asset",
    column: "providerArtifactUrl",
    kind: "text",
  },
];

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function applyRequested(): boolean {
  return process.argv.includes("--apply");
}

function manifestPath(): string {
  const argument = process.argv.find((value) => value.startsWith("--manifest="));
  const requested = argument?.slice("--manifest=".length).trim();
  return resolve(
    process.cwd(),
    requested || `.tmp/bunny-image-backfill-${Date.now()}.json`,
  );
}

function assertWriteApproval(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const hostname = new URL(databaseUrl).hostname;
  if (!hostname.endsWith("neon.tech")) return;
  if (process.env.BUNNY_LEGACY_BACKFILL_PRODUCTION_CONFIRMED !== "true") {
    throw new Error(
      "BUNNY_LEGACY_BACKFILL_PRODUCTION_CONFIRMED=true is required",
    );
  }
  if (process.env.BUNNY_LEGACY_BACKFILL_APPROVAL !== PRODUCTION_APPROVAL) {
    throw new Error(
      `BUNNY_LEGACY_BACKFILL_APPROVAL must equal ${PRODUCTION_APPROVAL}`,
    );
  }
}

async function readTargetRows(target: Target): Promise<TargetRow[]> {
  const table = quoteIdentifier(target.table);
  const column = quoteIdentifier(target.column);
  return prisma.$queryRawUnsafe<TargetRow[]>(
    `SELECT id::text AS id, CAST(${column} AS text) AS value ` +
      `FROM ${table} WHERE CAST(${column} AS text) LIKE '%res.cloudinary.com%' ` +
      "ORDER BY id",
  );
}

function urlsIn(value: string): string[] {
  return [...new Set(value.match(CLOUDINARY_URL) ?? [])];
}

async function copyToBunny(url: string): Promise<ImageUploadReceipt> {
  const remote = await fetchPublicResource(url.replaceAll("&amp;", "&"), {
    maxBytes: 25 * 1024 * 1024,
    allowedContentTypes: ["image/"],
  });
  const urlDigest = createHash("sha256").update(url).digest("hex");
  return uploadImageBufferWithMetadata(remote.buffer, remote.contentType, {
    folder: `legacy/cloudinary/${urlDigest.slice(0, 2)}`,
    publicId: urlDigest,
  });
}

async function updateTargetRow(input: {
  database: Pick<Prisma.TransactionClient, "$executeRawUnsafe">;
  target: Target;
  row: TargetRow;
  replacements: Map<string, ImageUploadReceipt>;
}): Promise<void> {
  let nextValue = input.row.value;
  for (const sourceUrl of urlsIn(input.row.value)) {
    const receipt = input.replacements.get(sourceUrl);
    if (!receipt) throw new Error("Missing prepared Bunny image replacement");
    nextValue = nextValue.replaceAll(sourceUrl, receipt.url);
  }
  const table = quoteIdentifier(input.target.table);
  const column = quoteIdentifier(input.target.column);
  const valueExpression = input.target.kind === "jsonb" ? "$1::jsonb" : "$1";
  await input.database.$executeRawUnsafe(
    `UPDATE ${table} SET ${column} = ${valueExpression} WHERE id = $2`,
    nextValue,
    input.row.id,
  );
}

async function updateSocialStorageReceipts(
  database: Pick<Prisma.TransactionClient, "$executeRawUnsafe">,
  replacements: Map<string, ImageUploadReceipt>,
): Promise<void> {
  for (const receipt of replacements.values()) {
    await database.$executeRawUnsafe(
      'UPDATE "social_creative_asset" SET ' +
        '"cloudinaryPublicId" = NULL, "cloudinaryAccount" = NULL, ' +
        '"uploadMetadata" = COALESCE("uploadMetadata", \'{}\'::jsonb) || ' +
        "jsonb_build_object(" +
        "'provider', 'bunny', " +
        "'objectKey', $1::text, " +
        "'storageZone', $2::text, " +
        "'checksumSha256', $3::text, " +
        "'bytes', $4::int, " +
        "'format', $5::text) " +
        'WHERE "imageUrl" = $6 OR "providerArtifactUrl" = $6',
      receipt.objectKey,
      receipt.storageZone,
      receipt.checksumSha256,
      receipt.bytes,
      receipt.format,
      receipt.url,
    );
  }
}

async function main(): Promise<void> {
  const rowsByTarget = await Promise.all(
    TARGETS.map(async (target) => ({ target, rows: await readTargetRows(target) })),
  );
  const uniqueUrls = new Set(
    rowsByTarget.flatMap(({ rows }) => rows.flatMap((row) => urlsIn(row.value))),
  );
  const summary = {
    mode: applyRequested() ? "apply" : "dry-run",
    rows: rowsByTarget.reduce((total, item) => total + item.rows.length, 0),
    uniqueImages: uniqueUrls.size,
    targets: rowsByTarget
      .filter((item) => item.rows.length > 0)
      .map((item) => ({
        table: item.target.table,
        column: item.target.column,
        rows: item.rows.length,
      })),
  };
  if (!applyRequested() || uniqueUrls.size === 0) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  assertWriteApproval();
  const replacements = new Map<string, ImageUploadReceipt>();
  for (const url of [...uniqueUrls].sort()) {
    replacements.set(url, await copyToBunny(url));
  }
  const outputManifest = manifestPath();
  await mkdir(dirname(outputManifest), { recursive: true });
  await writeFile(
    outputManifest,
    JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        databaseHost: new URL(process.env.DATABASE_URL!).hostname,
        replacements: [...replacements].map(([sourceUrl, receipt]) => ({
          sourceUrl,
          bunnyUrl: receipt.url,
          objectKey: receipt.objectKey,
          checksumSha256: receipt.checksumSha256,
          bytes: receipt.bytes,
          format: receipt.format,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await prisma.$transaction(async (transaction) => {
    for (const item of rowsByTarget) {
      for (const row of item.rows) {
        await updateTargetRow({
          database: transaction,
          target: item.target,
          row,
          replacements,
        });
      }
    }
    await updateSocialStorageReceipts(transaction, replacements);
  });
  console.log(
    JSON.stringify(
      {
        ...summary,
        migratedImages: replacements.size,
        rollbackManifest: outputManifest,
      },
      null,
      2,
    ),
  );
}

await main().finally(() => prisma.$disconnect());
