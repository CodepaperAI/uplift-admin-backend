import type { Request } from "express";

import { prisma } from "../config/db.config";

export type AgencyAssignment = {
  agencyId: string | null;
  agencySlug: string | null;
  ownershipType: "agency_managed" | "uplift_direct";
};

const UPLIFT_DIRECT_SLUG = "uplift-direct";

function normalizeCandidateDomain(rawValue: string): string | null {
  const trimmed = rawValue.trim().toLowerCase();
  if (!trimmed) return null;

  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.host.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function buildDomainCandidates(rawValue: string): string[] {
  const normalized = normalizeCandidateDomain(rawValue);
  if (!normalized) return [];

  const candidates: string[] = [normalized];
  const hostname = normalized.split(":")[0] ?? normalized;

  if (hostname && hostname !== normalized) {
    candidates.push(hostname);
  }

  return Array.from(new Set(candidates));
}

export function extractAgencyDomainFromRequest(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // Agency assignment controls ownership and pricing. Never derive it from
  // Origin, Referer, X-Forwarded-Host, or custom headers supplied by clients.
  // Each agency deployment must pin its public frontend domain in env.
  for (const configured of [
    env.AGENCY_CONTEXT_DOMAIN,
    env.FRONTEND_URL,
    env.NEXT_PUBLIC_APP_URL,
  ]) {
    if (!configured) continue;
    const normalized = normalizeCandidateDomain(configured);
    if (normalized) return normalized;
  }

  // Local/test deployments may use the direct Host header for developer
  // agency fixtures. Production fails closed to the uplift-direct fallback.
  if (env.NODE_ENV === "production") return null;
  const host = req.headers.host;
  return typeof host === "string" ? normalizeCandidateDomain(host) : null;
}

export async function resolveAgencyFromDomain(
  rawDomain: string | null,
): Promise<{ id: string; slug: string } | null> {
  if (!rawDomain) return null;

  const candidates = buildDomainCandidates(rawDomain);
  if (candidates.length === 0) return null;

  const agencyDomain = await prisma.agencyDomain.findFirst({
    where: {
      domain: { in: candidates },
      agency: { isActive: true },
    },
    select: {
      agencyId: true,
      agency: {
        select: {
          slug: true,
        },
      },
    },
    orderBy: {
      isPrimary: "desc",
    },
  });

  if (!agencyDomain) return null;

  return {
    id: agencyDomain.agencyId,
    slug: agencyDomain.agency.slug,
  };
}

export async function getUpliftDirectAgency(): Promise<{ id: string; slug: string } | null> {
  const agency = await prisma.agency.findUnique({
    where: { slug: UPLIFT_DIRECT_SLUG },
    select: { id: true, slug: true, isActive: true },
  });

  if (!agency || !agency.isActive) {
    return null;
  }

  return {
    id: agency.id,
    slug: agency.slug,
  };
}

export async function resolveAgencyAssignmentForRequest(
  req: Request,
): Promise<AgencyAssignment> {
  if (req.agencyId && req.agencySlug) {
    return {
      agencyId: req.agencyId,
      agencySlug: req.agencySlug,
      ownershipType: req.agencySlug === UPLIFT_DIRECT_SLUG ? "uplift_direct" : "agency_managed",
    };
  }

  const resolvedFromRequest = await resolveAgencyFromDomain(extractAgencyDomainFromRequest(req));
  if (resolvedFromRequest) {
    return {
      agencyId: resolvedFromRequest.id,
      agencySlug: resolvedFromRequest.slug,
      ownershipType:
        resolvedFromRequest.slug === UPLIFT_DIRECT_SLUG ? "uplift_direct" : "agency_managed",
    };
  }

  const upliftDirect = await getUpliftDirectAgency();
  if (!upliftDirect) {
    return {
      agencyId: null,
      agencySlug: null,
      ownershipType: "uplift_direct",
    };
  }

  return {
    agencyId: upliftDirect.id,
    agencySlug: upliftDirect.slug,
    ownershipType: "uplift_direct",
  };
}

export async function getAgencyAssignmentForBusiness(
  businessId: string,
): Promise<AgencyAssignment> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      agencyId: true,
      ownershipType: true,
      agency: {
        select: {
          slug: true,
          isActive: true,
        },
      },
    },
  });

  if (business?.agencyId) {
    return {
      agencyId: business.agencyId,
      agencySlug: business.agency?.isActive ? business.agency.slug : null,
      ownershipType:
        business.ownershipType === "agency_managed" ? "agency_managed" : "uplift_direct",
    };
  }

  const upliftDirect = await getUpliftDirectAgency();
  if (!upliftDirect) {
    return {
      agencyId: null,
      agencySlug: null,
      ownershipType: "uplift_direct",
    };
  }

  return {
    agencyId: upliftDirect.id,
    agencySlug: upliftDirect.slug,
    ownershipType: "uplift_direct",
  };
}

export async function syncWebsiteSubscriptionAgencyFields(
  businessId: string,
  overrides?: {
    agencyId?: string | null;
    agencyPricingConfigId?: string | null;
  },
): Promise<void> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      agencyId: true,
    },
  });

  await prisma.websiteSubscription.updateMany({
    where: { businessId },
    data: {
      agencyId: overrides?.agencyId ?? business?.agencyId ?? null,
      agencyPricingConfigId:
        overrides?.agencyPricingConfigId !== undefined
          ? overrides.agencyPricingConfigId
          : undefined,
    },
  });
}

export async function getActiveAgencyPricingConfigId(
  agencyId: string | null,
  planTier: "SEO" | "SEO_SOCIAL" = "SEO",
): Promise<string | null> {
  if (!agencyId) return null;

  const config = await prisma.agencyPricingConfig.findFirst({
    where: {
      agencyId,
      isActive: true,
      planTier,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
    },
  });

  return config?.id ?? null;
}
