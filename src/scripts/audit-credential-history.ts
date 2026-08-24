import crypto from "node:crypto";
import { prisma } from "../config/db.config";

function normalizeSite(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  try {
    return new URL(
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`,
    ).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function fingerprint(value: string | null): string | null {
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function credentialVersion(value: string | null): string {
  if (!value) return "none";
  if (value.startsWith("hmac-sha256:v2:")) return "api-v2-hmac";
  if (value.startsWith("hmac-sha256:wp:v2:")) return "wordpress-v2-hmac";
  if (/^[a-f0-9]{64}$/i.test(value)) return "api-v1-sha256";
  if (value.startsWith("wp_key_v2_")) return "wordpress-v2";
  if (value.startsWith("wp_key_")) return "wordpress-legacy";
  if (value.startsWith("uai_secret_v2:wordpress-integration-key:")) {
    return "wordpress-v2-encrypted";
  }
  return "unknown";
}

function externalHost(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function assertProductionReadAcknowledged(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_URL is missing or invalid");
  }

  const looksProduction =
    process.env.NODE_ENV === "production" ||
    host.includes("neon.tech") ||
    host.includes("uplift");
  if (
    looksProduction &&
    process.env.SECURITY_AUDIT_PRODUCTION_READ_CONFIRMED !== "true"
  ) {
    throw new Error(
      "Set SECURITY_AUDIT_PRODUCTION_READ_CONFIRMED=true for a production read",
    );
  }
}

async function main(): Promise<void> {
  assertProductionReadAcknowledged();
  const sites = [...new Set(process.argv.slice(2).map(normalizeSite).filter(Boolean))];
  if (sites.length === 0) {
    throw new Error(
      "Provide one or more site hostnames, for example: bun run src/scripts/audit-credential-history.ts example.com",
    );
  }

  const businesses = await prisma.business.findMany({
    where: {
      OR: sites.map((site) => ({
        businessWebsiteUrl: { contains: site, mode: "insensitive" as const },
      })),
    },
    select: {
      id: true,
      businessName: true,
      businessWebsiteUrl: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const results = await Promise.all(
    businesses.map(async (business) => {
      const [apiTokens, wordpressIntegrations] = await Promise.all([
        prisma.apiToken.findMany({
          where: { businessId: business.id },
          select: {
            id: true,
            name: true,
            token: true,
            tokenPrefix: true,
            permissions: true,
            allowedOrigins: true,
            connectedSiteUrlAtCreation: true,
            connectedBusinessNameAtCreation: true,
            isActive: true,
            expiresAt: true,
            lastUsedAt: true,
            revokedAt: true,
            revocationReason: true,
            rotatedFromTokenId: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { createdAt: "asc" },
        }),
        prisma.publishingIntegration.findMany({
          where: { businessId: business.id, platform: "WORDPRESS" },
          select: {
            id: true,
            isActive: true,
            isVerified: true,
            wordpressUrl: true,
            wordpressIntegrationKey: true,
            wordpressIntegrationKeyDigest: true,
            wordpressPreviousKeyDigest: true,
            wordpressIntegrationKeyFirstCreatedAt: true,
            wordpressIntegrationKeyCreatedAt: true,
            wordpressIntegrationKeyLastUsedAt: true,
            wordpressIntegrationKeyRevokedAt: true,
            wordpressIntegrationKeyRotationCount: true,
            pluginVersion: true,
            lastSyncAt: true,
            lastErrorAt: true,
            errorCount: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { publishedBlogs: true } },
            publishedBlogs: {
              select: {
                id: true,
                blogId: true,
                status: true,
                externalPostId: true,
                externalPostUrl: true,
                publishedAt: true,
                createdAt: true,
                updatedAt: true,
                blog: { select: { title: true, slug: true } },
              },
              orderBy: { createdAt: "desc" },
              take: 10,
            },
          },
          orderBy: { createdAt: "asc" },
        }),
      ]);

      return {
        business,
        apiTokens: apiTokens.map(({ token, ...item }) => ({
          ...item,
          credentialVersion: credentialVersion(token),
          storedDigestFingerprint: fingerprint(token),
          siteHostAtCreation: normalizeSite(item.connectedSiteUrlAtCreation ?? "") || null,
        })),
        wordpressIntegrations: wordpressIntegrations.map(
          ({ wordpressIntegrationKey, wordpressIntegrationKeyDigest, wordpressPreviousKeyDigest, _count, ...integration }) => ({
            ...integration,
            totalPublishedBlogRecords: _count.publishedBlogs,
            credentialVersion: credentialVersion(
              wordpressIntegrationKey ?? wordpressIntegrationKeyDigest,
            ),
            encryptedCredentialFingerprint: fingerprint(wordpressIntegrationKey),
            digestFingerprint: fingerprint(wordpressIntegrationKeyDigest),
            previousDigestFingerprint: fingerprint(wordpressPreviousKeyDigest),
            configuredSiteHost: normalizeSite(integration.wordpressUrl ?? "") || null,
            publishedExternalHosts: [
              ...new Set(
                integration.publishedBlogs
                  .map((published) => externalHost(published.externalPostUrl))
                  .filter((host): host is string => Boolean(host)),
              ),
            ],
          }),
        ),
      };
    }),
  );

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        requestedSites: sites,
        matchedBusinessCount: businesses.length,
        results,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(
      "Credential history audit failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
