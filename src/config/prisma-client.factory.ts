import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readFileSync } from "node:fs";

const enableQueryLogging =
  process.env.PRISMA_QUERY_LOGGING === "true" ||
  process.env.PRISMA_QUERY_LOG === "true";

const defaultLog: Prisma.LogLevel[] = enableQueryLogging
  ? ["error", "query", "info"]
  : ["error", "warn"];

function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

function poolMax(connectionString: string): number {
  const configured = Number.parseInt(process.env.PRISMA_POOL_MAX ?? "", 10);
  if (Number.isInteger(configured) && configured >= 1 && configured <= 100) {
    return configured;
  }
  try {
    const legacy = Number.parseInt(
      new URL(connectionString).searchParams.get("connection_limit") ?? "",
      10,
    );
    if (Number.isInteger(legacy) && legacy >= 1 && legacy <= 100) return legacy;
  } catch {
    // The database driver will report a malformed connection string generically.
  }
  return 10;
}

export function createPrismaClient(options?: {
  log?: Prisma.LogLevel[];
}): PrismaClient {
  const connectionString = databaseUrl();
  const caCertificatePath = process.env.DATABASE_CA_CERT_PATH?.trim();
  const ssl = caCertificatePath
    ? {
        ca: readFileSync(caCertificatePath, "utf8"),
        rejectUnauthorized: true,
      }
    : undefined;
  const adapter = new PrismaPg({
    connectionString,
    max: poolMax(connectionString),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 300_000,
    ...(ssl ? { ssl } : {}),
  });
  return new PrismaClient({ adapter, log: options?.log ?? defaultLog });
}
