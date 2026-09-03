import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "../config/db.config";
import { ZernioClient } from "./zernio/zernio.client";

export const PUBLIC_STATUS_COMPONENTS = [
  "dashboard-authentication",
  "ai-content-generation",
  "blog-website-publishing",
  "social-media-publishing",
  "google-business-profile",
  "scheduled-automations",
] as const;

export type PublicStatusComponent = (typeof PUBLIC_STATUS_COMPONENTS)[number];

export type PublicStatusProbeResult = {
  component: PublicStatusComponent;
  ok: boolean;
  checkedAt: string;
};

type Dependencies = {
  prisma: PrismaClient;
  fetchImpl: typeof fetch;
  now: () => Date;
  zernioClient: Pick<ZernioClient, "listAccounts">;
};

type CachedResult = { expiresAt: number; result: PublicStatusProbeResult };
const cache = new Map<PublicStatusComponent, CachedResult>();
const CACHE_MS = 120_000;

function hoursBefore(now: Date, hours: number): Date {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function ratioIsSystemic(failed: number, total: number, minimum = 5): boolean {
  return total >= minimum && failed / total >= 0.6;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(7_000) });
}

async function checkAi(deps: Dependencies, now: Date): Promise<boolean> {
  const key = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!key) return false;

  const [provider, total, failed, stuck] = await Promise.all([
    fetchWithTimeout(deps.fetchImpl, "https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    }),
    deps.prisma.blogGenerationRun.count({
      where: { createdAt: { gte: hoursBefore(now, 6) }, status: { not: "RUNNING" } },
    }),
    deps.prisma.blogGenerationRun.count({
      where: { createdAt: { gte: hoursBefore(now, 6) }, status: "FAILED" },
    }),
    deps.prisma.blogGenerationRun.count({
      where: {
        status: "RUNNING",
        createdAt: { gte: hoursBefore(now, 24) },
        updatedAt: { lt: hoursBefore(now, 1) },
      },
    }),
  ]);

  return provider.ok && stuck < 2 && !ratioIsSystemic(failed, total);
}

async function checkDashboardAuthentication(deps: Dependencies): Promise<boolean> {
  const frontendUrl = (
    process.env.STATUS_DASHBOARD_URL ??
    process.env.FRONTEND_URL ??
    "https://dashboard.upliftai.co"
  ).replace(/\/+$/, "");
  const backendUrl = (
    process.env.STATUS_CORE_API_URL ??
    process.env.CORE_BACKEND_URL ??
    "https://api.upliftai.co"
  ).replace(/\/+$/, "");
  const [dashboard, session] = await Promise.all([
    fetchWithTimeout(deps.fetchImpl, `${frontendUrl}/sign-in`, {
      method: "GET",
      headers: { Accept: "text/html" },
    }),
    fetchWithTimeout(deps.fetchImpl, `${backendUrl}/api/auth/get-session`, {
      method: "GET",
      headers: { Accept: "application/json" },
    }),
  ]);
  return dashboard.ok && session.ok;
}

async function checkBlogPublishing(deps: Dependencies, now: Date): Promise<boolean> {
  const since = hoursBefore(now, 24);
  const [published, failed, stuck] = await Promise.all([
    deps.prisma.publishedBlog.count({
      where: { createdAt: { gte: since }, status: { in: ["PUBLISHED", "UPDATED"] } },
    }),
    deps.prisma.publishedBlog.count({
      where: { createdAt: { gte: since }, status: "FAILED" },
    }),
    deps.prisma.publishedBlog.count({
      where: {
        status: "PUBLISHING",
        createdAt: { gte: hoursBefore(now, 24 * 7) },
        publishingStartedAt: { lt: hoursBefore(now, 1) },
      },
    }),
  ]);
  // Customer-owned publishing destinations can reject a post even while the
  // platform is healthy. A successful delivery in the same window proves the
  // publishing path is available, so only call a platform outage when there
  // are repeated failures, no successes, or work is genuinely stuck.
  return stuck < 2 && (published > 0 || !ratioIsSystemic(failed, published + failed));
}

async function checkSocialPublishing(deps: Dependencies, now: Date): Promise<boolean> {
  const profile = await deps.prisma.socialPublisherProfile.findFirst({
    where: {
      status: "READY",
      externalProfileId: { not: null },
      accounts: { some: { isActive: true } },
    },
    orderBy: { lastSyncedAt: "desc" },
    select: { externalProfileId: true },
  });
  if (!profile?.externalProfileId) return false;

  const since = hoursBefore(now, 24);
  const [remoteAccounts, published, failedAttempts, stuck] = await Promise.all([
    deps.zernioClient.listAccounts(profile.externalProfileId),
    deps.prisma.socialPublishAttempt.count({
      where: { createdAt: { gte: since }, status: "PUBLISHED" },
    }),
    deps.prisma.socialPublishAttempt.findMany({
      where: {
        createdAt: { gte: since },
        status: "FAILED",
      },
      select: { lastErrorCode: true, lastErrorMessage: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    deps.prisma.socialPublishAttempt.count({
      where: {
        status: "SUBMITTING",
        createdAt: { gte: hoursBefore(now, 24) },
        updatedAt: { lt: hoursBefore(now, 1) },
      },
    }),
  ]);
  const systemicFailures = failedAttempts.filter((attempt) => {
    const details = [attempt.lastErrorCode, attempt.lastErrorMessage]
      .filter(Boolean)
      .join(" ");
    return !isCustomerConnectionError(details);
  }).length;
  return (
    remoteAccounts.length > 0 &&
    stuck < 2 &&
    !ratioIsSystemic(systemicFailures, published + systemicFailures)
  );
}

function isCustomerConnectionError(message: string | null): boolean {
  return Boolean(
    message &&
      /invalid[_ -]?grant|token|oauth|reauth|reconnect|permission|unauthoriz|forbidden/i.test(
        message,
      ),
  );
}

async function checkGoogleBusinessProfile(deps: Dependencies, now: Date): Promise<boolean> {
  const [connections, published, failed] = await Promise.all([
    deps.prisma.googleMyBusiness.findMany({
      where: { isActive: true, isDemo: false },
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: { lastSyncAt: true, lastSyncError: true },
    }),
    deps.prisma.gMBPost.count({
      where: { createdAt: { gte: hoursBefore(now, 24 * 7) }, status: "PUBLISHED" },
    }),
    deps.prisma.gMBPost.count({
      where: { createdAt: { gte: hoursBefore(now, 24 * 7) }, status: "FAILED" },
    }),
  ]);
  if (connections.length === 0) return false;

  const freshConnections = connections.filter(
    (item) => item.lastSyncAt && item.lastSyncAt >= hoursBefore(now, 72),
  ).length;
  const systemicSyncErrors = connections.filter(
    (item) => item.lastSyncError && !isCustomerConnectionError(item.lastSyncError),
  ).length;
  const connectionFailureIsSystemic =
    connections.length >= 5 && systemicSyncErrors / connections.length >= 0.6;
  const publishingFailureIsSystemic = ratioIsSystemic(failed, published + failed);
  return freshConnections > 0 && !connectionFailureIsSystemic && !publishingFailureIsSystemic;
}

function buildInngestSigningKeyHash(signingKey: string): string {
  const prefix = signingKey.match(/^signkey-[\w]+-/)?.[0] ?? "";
  const raw = signingKey.replace(/^signkey-[\w]+-/, "");
  return `${prefix}${createHash("sha256").update(raw, "hex").digest("hex")}`;
}

async function checkScheduledAutomations(deps: Dependencies): Promise<boolean> {
  const signingKey = process.env.INNGEST_SIGNING_KEY?.trim() ?? "";
  if (!signingKey) return false;
  const baseUrl = (
    process.env.INNGEST_BASE_URL ??
    process.env.INNGEST_API_BASE_URL ??
    "https://api.inngest.com"
  ).replace(/\/+$/, "");
  const response = await fetchWithTimeout(
    deps.fetchImpl,
    `${baseUrl}/fn/register`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${buildInngestSigningKeyHash(signingKey)}`,
        Accept: "application/json",
      },
    },
  );
  // The self-hosted server exposes registration as POST-only. A signed GET
  // reaching it therefore returns 405; a dead proxy/upstream returns 5xx.
  // This is a read-only end-to-end liveness check and never enqueues work.
  return response.ok || response.status === 405;
}

async function execute(component: PublicStatusComponent, deps: Dependencies): Promise<boolean> {
  const now = deps.now();
  if (component === "dashboard-authentication") return checkDashboardAuthentication(deps);
  if (component === "ai-content-generation") return checkAi(deps, now);
  if (component === "blog-website-publishing") return checkBlogPublishing(deps, now);
  if (component === "social-media-publishing") return checkSocialPublishing(deps, now);
  if (component === "google-business-profile") return checkGoogleBusinessProfile(deps, now);
  return checkScheduledAutomations(deps);
}

export function isPublicStatusComponent(value: string): value is PublicStatusComponent {
  return (PUBLIC_STATUS_COMPONENTS as readonly string[]).includes(value);
}

export async function runPublicStatusProbe(
  component: PublicStatusComponent,
  overrides: Partial<Dependencies> = {},
): Promise<PublicStatusProbeResult> {
  const cached = cache.get(component);
  if (!overrides.now && cached && cached.expiresAt > Date.now()) return cached.result;

  const deps: Dependencies = {
    prisma,
    fetchImpl: fetch,
    now: () => new Date(),
    zernioClient: {
      listAccounts: (profileId: string) => new ZernioClient().listAccounts(profileId),
    },
    ...overrides,
  };
  const checkedAt = deps.now().toISOString();
  let ok = false;
  try {
    ok = await execute(component, deps);
  } catch (error) {
    console.error(`[Public status probe] ${component} failed`, error);
  }
  const result = { component, ok, checkedAt };
  if (!overrides.now) {
    // Let Uptime Kuma retries perform a fresh upstream check. Caching a single
    // failed probe makes every retry replay the same transient failure and can
    // incorrectly promote a brief provider blip into a confirmed outage.
    if (result.ok) cache.set(component, { expiresAt: Date.now() + CACHE_MS, result });
    else cache.delete(component);
  }
  return result;
}
