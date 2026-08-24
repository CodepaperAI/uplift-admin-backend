import type { Response } from "express";
import Stripe from "stripe";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";

type AgencyOverviewData = {
  agencyName: string;
  agencySlug: string;
  clientCount: number;
  activeSubscriptions: number;
  totalBusinesses: number;
};

type AgencyBusinessItem = {
  id: string;
  businessName: string;
  businessType: string;
  businessWebsiteUrl: string;
  isActive: boolean;
  websiteStatus: string;
  createdAt: Date;
  websiteSubscription: {
    id: string;
    status: string;
    trialStatus: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
  } | null;
};

type AgencyPricingData = {
  id: string;
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  currency: string;
  isActive: boolean;
  stripeMonthlyPriceId: string | null;
  stripeYearlyPriceId: string | null;
  createdAt: Date;
  updatedAt: Date;
} | null;

type UpdatePricingBody = {
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  currency?: string;
};

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2026-03-25.dahlia" as Stripe.LatestApiVersion,
    })
  : null;

async function createAgencyStripePrice(params: {
  agencyId: string;
  agencyName: string;
  interval: "month" | "year";
  amountCents: number;
  currency: string;
}): Promise<string> {
  if (!stripe) {
    throw new Error("Stripe is not configured");
  }

  const price = await stripe.prices.create({
    currency: params.currency,
    unit_amount: params.amountCents,
    recurring: {
      interval: params.interval,
    },
    product_data: {
      name: `${params.agencyName} ${params.interval === "month" ? "Monthly" : "Yearly"} Subscription`,
      metadata: {
        agencyId: params.agencyId,
        billingInterval: params.interval,
      },
    },
    metadata: {
      agencyId: params.agencyId,
      billingInterval: params.interval,
    },
  });

  return price.id;
}

type SettlementRunItem = {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  status: string;
  totalCollectedCents: number;
  totalRefundsCents: number;
  netEligibleCents: number;
  platformShareTotalCents: number;
  agencyShareTotalCents: number;
  currency: string;
  approvedAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
};

type SettlementDetailData = SettlementRunItem & {
  lineItems: {
    id: string;
    businessId: string | null;
    description: string;
    collectedAmountCents: number;
    refundAmountCents: number;
    netAmountCents: number;
    platformShareCents: number;
    agencyShareCents: number;
  }[];
};

type LedgerEntryItem = {
  id: string;
  businessId: string | null;
  entryType: string;
  grossAmountCents: number;
  eligibleAmountCents: number;
  platformShareAmountCents: number;
  agencyShareAmountCents: number;
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  description: string | null;
  createdAt: Date;
};

type PaginatedLedgerData = {
  entries: LedgerEntryItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export async function getAgencyOverview(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const agencyId: string | undefined = req.agencyId;

  if (!agencyId) {
    sendError(res, "Agency ID is required", 400);
    return;
  }

  try {
    const agency = await prisma.agency.findUnique({
      where: { id: agencyId },
      select: { name: true, slug: true },
    });

    if (!agency) {
      sendError(res, "Agency not found", 404);
      return;
    }

    const totalBusinesses: number = await prisma.business.count({
      where: { agencyId },
    });

    const clientCount: number = await prisma.business.count({
      where: { agencyId, isActive: true },
    });

    const activeSubscriptions: number = await prisma.websiteSubscription.count({
      where: {
        business: { agencyId },
        status: "active",
      },
    });

    const data: AgencyOverviewData = {
      agencyName: agency.name,
      agencySlug: agency.slug,
      clientCount,
      activeSubscriptions,
      totalBusinesses,
    };

    sendSuccess(res, data, "Agency overview fetched");
  } catch {
    sendError(res, "Failed to fetch agency overview", 500);
  }
}

export async function listAgencyBusinesses(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const agencyId: string | undefined = req.agencyId;

  if (!agencyId) {
    sendError(res, "Agency ID is required", 400);
    return;
  }

  try {
    const businesses = await prisma.business.findMany({
      where: { agencyId },
      include: {
        websiteSubscription: {
          select: {
            id: true,
            status: true,
            trialStatus: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const data: AgencyBusinessItem[] = businesses.map((b) => ({
      id: b.id,
      businessName: b.businessName,
      businessType: b.businessType,
      businessWebsiteUrl: b.businessWebsiteUrl,
      isActive: b.isActive,
      websiteStatus: b.websiteStatus,
      createdAt: b.createdAt,
      websiteSubscription: b.websiteSubscription
        ? {
            id: b.websiteSubscription.id,
            status: b.websiteSubscription.status,
            trialStatus: b.websiteSubscription.trialStatus,
            currentPeriodStart: b.websiteSubscription.currentPeriodStart,
            currentPeriodEnd: b.websiteSubscription.currentPeriodEnd,
          }
        : null,
    }));

    sendSuccess(res, data, "Agency businesses fetched");
  } catch {
    sendError(res, "Failed to fetch agency businesses", 500);
  }
}

export async function getAgencyPricing(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const agencyId: string | undefined = req.agencyId;

  if (!agencyId) {
    sendError(res, "Agency ID is required", 400);
    return;
  }

  try {
    const config = await prisma.agencyPricingConfig.findFirst({
      where: { agencyId, isActive: true },
      orderBy: { createdAt: "desc" },
    });

    const data: AgencyPricingData = config
      ? {
          id: config.id,
          monthlyPriceCents: config.monthlyPriceCents,
          yearlyPriceCents: config.yearlyPriceCents,
          currency: config.currency,
          isActive: config.isActive,
          stripeMonthlyPriceId: config.stripeMonthlyPriceId,
          stripeYearlyPriceId: config.stripeYearlyPriceId,
          createdAt: config.createdAt,
          updatedAt: config.updatedAt,
        }
      : null;

    sendSuccess(res, data, "Agency pricing fetched");
  } catch {
    sendError(res, "Failed to fetch agency pricing", 500);
  }
}

export async function updateAgencyPricing(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const agencyId: string | undefined = req.agencyId;
  const authUserId: string | undefined = req.authUserId;

  if (!agencyId) {
    sendError(res, "Agency ID is required", 400);
    return;
  }

  if (!authUserId) {
    sendError(res, "Unauthorized", 401);
    return;
  }

  const body: UpdatePricingBody = req.body;

	  if (
	    typeof body.monthlyPriceCents !== "number" ||
	    typeof body.yearlyPriceCents !== "number"
	  ) {
    sendError(res, "monthlyPriceCents and yearlyPriceCents are required", 400);
    return;
  }

	  if (body.monthlyPriceCents <= 0 || body.yearlyPriceCents <= 0) {
	    sendError(res, "Price values must be greater than zero", 400);
	    return;
	  }

	  try {
      const agency = await prisma.agency.findUnique({
        where: { id: agencyId },
        select: { name: true },
      });

      if (!agency) {
        sendError(res, "Agency not found", 404);
        return;
      }

      const currency = (body.currency ?? "usd").toLowerCase();
      const [stripeMonthlyPriceId, stripeYearlyPriceId] = await Promise.all([
        createAgencyStripePrice({
          agencyId,
          agencyName: agency.name,
          interval: "month",
          amountCents: body.monthlyPriceCents,
          currency,
        }),
        createAgencyStripePrice({
          agencyId,
          agencyName: agency.name,
          interval: "year",
          amountCents: body.yearlyPriceCents,
          currency,
        }),
      ]);

	    const newConfig = await prisma.$transaction(async (tx) => {
        await tx.agencyPricingConfig.updateMany({
          where: { agencyId, isActive: true },
          data: { isActive: false },
        });

        return await tx.agencyPricingConfig.create({
          data: {
            agencyId,
            monthlyPriceCents: body.monthlyPriceCents,
            yearlyPriceCents: body.yearlyPriceCents,
            currency,
            isActive: true,
            stripeMonthlyPriceId,
            stripeYearlyPriceId,
          },
        });
      });

	    await prisma.adminAuditLog.create({
	      data: {
        adminUserId: authUserId,
        action: "UPDATE_AGENCY_PRICING",
        targetType: "AgencyPricingConfig",
        targetId: newConfig.id,
        details: {
          agencyId,
	          monthlyPriceCents: body.monthlyPriceCents,
	          yearlyPriceCents: body.yearlyPriceCents,
	          currency,
            stripeMonthlyPriceId,
            stripeYearlyPriceId,
	        },
	      },
	    });

    const data: AgencyPricingData = {
      id: newConfig.id,
      monthlyPriceCents: newConfig.monthlyPriceCents,
      yearlyPriceCents: newConfig.yearlyPriceCents,
      currency: newConfig.currency,
      isActive: newConfig.isActive,
      stripeMonthlyPriceId: newConfig.stripeMonthlyPriceId,
      stripeYearlyPriceId: newConfig.stripeYearlyPriceId,
      createdAt: newConfig.createdAt,
      updatedAt: newConfig.updatedAt,
    };

    sendSuccess(res, data, "Agency pricing updated");
  } catch {
    sendError(res, "Failed to update agency pricing", 500);
  }
}

export async function getAgencySettlements(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const agencyId: string | undefined = req.agencyId;

  if (!agencyId) {
    sendError(res, "Agency ID is required", 400);
    return;
  }

  try {
    const runs = await prisma.agencySettlementRun.findMany({
      where: { agencyId },
      orderBy: { periodStart: "desc" },
    });

    const data: SettlementRunItem[] = runs.map((r) => ({
      id: r.id,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      status: r.status,
      totalCollectedCents: r.totalCollectedCents,
      totalRefundsCents: r.totalRefundsCents,
      netEligibleCents: r.netEligibleCents,
      platformShareTotalCents: r.platformShareTotalCents,
      agencyShareTotalCents: r.agencyShareTotalCents,
      currency: r.currency,
      approvedAt: r.approvedAt,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
    }));

    sendSuccess(res, data, "Agency settlements fetched");
  } catch {
    sendError(res, "Failed to fetch agency settlements", 500);
  }
}

export async function getAgencySettlementDetail(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const agencyId: string | undefined = req.agencyId;
  const runId: string = String(req.params["runId"] ?? "");

  if (!agencyId) {
    sendError(res, "Agency ID is required", 400);
    return;
  }

  if (!runId) {
    sendError(res, "Settlement run ID is required", 400);
    return;
  }

  try {
    const run = await prisma.agencySettlementRun.findUnique({
      where: { id: runId },
      include: {
        lineItems: {
          select: {
            id: true,
            businessId: true,
            description: true,
            collectedAmountCents: true,
            refundAmountCents: true,
            netAmountCents: true,
            platformShareCents: true,
            agencyShareCents: true,
          },
        },
      },
    });

    if (!run) {
      sendError(res, "Settlement run not found", 404);
      return;
    }

    if (run.agencyId !== agencyId) {
      sendError(res, "Forbidden: settlement does not belong to your agency", 403);
      return;
    }

    const data: SettlementDetailData = {
      id: run.id,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      status: run.status,
      totalCollectedCents: run.totalCollectedCents,
      totalRefundsCents: run.totalRefundsCents,
      netEligibleCents: run.netEligibleCents,
      platformShareTotalCents: run.platformShareTotalCents,
      agencyShareTotalCents: run.agencyShareTotalCents,
      currency: run.currency,
      approvedAt: run.approvedAt,
      paidAt: run.paidAt,
      createdAt: run.createdAt,
      lineItems: run.lineItems,
    };

    sendSuccess(res, data, "Settlement detail fetched");
  } catch {
    sendError(res, "Failed to fetch settlement detail", 500);
  }
}

export async function getAgencyLedger(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const agencyId: string | undefined = req.agencyId;

  if (!agencyId) {
    sendError(res, "Agency ID is required", 400);
    return;
  }

  const page: number = Math.max(1, parseInt(req.query["page"] as string, 10) || 1);
  const limit: number = Math.min(
    100,
    Math.max(1, parseInt(req.query["limit"] as string, 10) || 20),
  );
  const skip: number = (page - 1) * limit;

  try {
    const [entries, total] = await Promise.all([
      prisma.agencyRevenueLedger.findMany({
        where: { agencyId },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.agencyRevenueLedger.count({
        where: { agencyId },
      }),
    ]);

    const mapped: LedgerEntryItem[] = entries.map((e) => ({
      id: e.id,
      businessId: e.businessId,
      entryType: e.entryType,
      grossAmountCents: e.grossAmountCents,
      eligibleAmountCents: e.eligibleAmountCents,
      platformShareAmountCents: e.platformShareAmountCents,
      agencyShareAmountCents: e.agencyShareAmountCents,
      currency: e.currency,
      periodStart: e.periodStart,
      periodEnd: e.periodEnd,
      description: e.description,
      createdAt: e.createdAt,
    }));

    const totalPages: number = Math.ceil(total / limit);

    const data: PaginatedLedgerData = {
      entries: mapped,
      total,
      page,
      limit,
      totalPages,
    };

    sendSuccess(res, data, "Agency ledger fetched");
  } catch {
    sendError(res, "Failed to fetch agency ledger", 500);
  }
}
