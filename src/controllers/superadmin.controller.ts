import type { Response } from "express";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import { getActiveAgencyPricingConfigId } from "../utils/agency-context.utils";
import { USER_INPUT_LIMITS } from "../config/user-input-limits";

type AuditLogAction =
  | "agency.create"
  | "agency.update"
  | "agency.domain.add"
  | "agency.domain.remove"
  | "business.reassign"
  | "revenue_share.create"
  | "sales_record.create"
  | "settlement.approve"
  | "settlement.paid"
  | "settlement.failed";

type AuditLogTargetType =
  | "Agency"
  | "AgencyDomain"
  | "Business"
  | "AgencyRevenueShareRule"
  | "SuperAdminSalesRecord"
  | "AgencySettlementRun";

interface CreateAgencyBody {
  name: string;
  slug: string;
  domains?: string[];
}

interface UpdateAgencyBody {
  name?: string;
  isActive?: boolean;
}

interface AddAgencyDomainBody {
  domain: string;
  isPrimary?: boolean;
}

interface ReassignBusinessBody {
  targetAgencyId: string;
}

interface CreateRevenueShareRuleBody {
  platformSharePercent: number;
  agencySharePercent: number;
}

interface CreateSalesRecordBody {
  salespersonName?: string;
  amountUsd?: number | string;
  amountCents?: number | string;
  note?: string;
  recordedAt?: string;
}

interface MarkSettlementPaidBody {
  payoutReference?: string;
}

interface MarkSettlementFailedBody {
  failureReason: string;
}

interface AuditLogQueryParams {
  page?: string;
  limit?: string;
  action?: string;
  targetType?: string;
}

function parseSalesAmountCents(body: CreateSalesRecordBody): number | null {
  if (body.amountCents !== undefined && body.amountCents !== null) {
    const cents = Number(body.amountCents);
    return Number.isFinite(cents) ? Math.round(cents) : null;
  }

  if (body.amountUsd !== undefined && body.amountUsd !== null) {
    const dollars = Number(body.amountUsd);
    return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
  }

  return null;
}

function parseSalesRecordedAt(value: string | undefined): Date {
  if (!value) {
    return new Date();
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T12:00:00.000Z`
    : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function serializeSalesRecord<
  T extends {
    amountCents: number;
    recordedAt: Date;
    createdAt: Date;
    updatedAt: Date;
  },
>(record: T): Omit<T, "recordedAt" | "createdAt" | "updatedAt"> & {
  amountUsd: number;
  recordedAt: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    ...record,
    amountUsd: record.amountCents / 100,
    recordedAt: record.recordedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function writeAuditLog(
  adminUserId: string,
  action: AuditLogAction,
  targetType: AuditLogTargetType,
  targetId: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await prisma.adminAuditLog.create({
    data: {
      adminUserId,
      action,
      targetType,
      targetId,
      details: details !== undefined ? JSON.parse(JSON.stringify(details)) : undefined,
    },
  });
}

export async function listAgencies(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const agencies = await prisma.agency.findMany({
      include: {
        _count: {
          select: {
            domains: true,
            businesses: true,
            memberships: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    sendSuccess(res, agencies, "Agencies retrieved");
  } catch (error: unknown) {
    sendError(res, "Failed to list agencies", 500, error);
  }
}

export async function getAgencyDetail(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { agencyId } = req.params as { agencyId: string };

    const agency = await prisma.agency.findUnique({
      where: { id: agencyId },
      include: {
        domains: true,
        memberships: {
          include: {
            user: {
              select: { id: true, name: true, email: true, role: true },
            },
          },
        },
        pricingConfigs: true,
        revenueShareRules: { orderBy: { createdAt: "desc" } },
        payoutAccount: true,
      },
    });

    if (!agency) {
      sendError(res, "Agency not found", 404);
      return;
    }

    sendSuccess(res, agency, "Agency detail retrieved");
  } catch (error: unknown) {
    sendError(res, "Failed to get agency detail", 500, error);
  }
}

export async function createAgency(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { name, slug, domains } = req.body as CreateAgencyBody;

    if (!name || !slug) {
      sendError(res, "name and slug are required", 400);
      return;
    }

    const existing = await prisma.agency.findUnique({ where: { slug } });
    if (existing) {
      sendError(res, "Agency slug already exists", 409);
      return;
    }

    const agency = await prisma.agency.create({
      data: {
        name,
        slug,
        domains:
          domains && domains.length > 0
            ? {
                create: domains.map((domain: string, idx: number) => ({
                  domain,
                  isPrimary: idx === 0,
                })),
              }
            : undefined,
      },
      include: { domains: true },
    });

    await writeAuditLog(adminUserId, "agency.create", "Agency", agency.id, {
      name,
      slug,
      domainCount: domains?.length ?? 0,
    });

    sendSuccess(res, agency, "Agency created", 201);
  } catch (error: unknown) {
    sendError(res, "Failed to create agency", 500, error);
  }
}

export async function updateAgency(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { agencyId } = req.params as { agencyId: string };
    const { name, isActive } = req.body as UpdateAgencyBody;

    const existing = await prisma.agency.findUnique({
      where: { id: agencyId },
    });
    if (!existing) {
      sendError(res, "Agency not found", 404);
      return;
    }

    const data: { name?: string; isActive?: boolean } = {};
    if (name !== undefined) data.name = name;
    if (isActive !== undefined) data.isActive = isActive;

    const agency = await prisma.agency.update({
      where: { id: agencyId },
      data,
    });

    await writeAuditLog(
      adminUserId,
      "agency.update",
      "Agency",
      agencyId,
      data,
    );

    sendSuccess(res, agency, "Agency updated");
  } catch (error: unknown) {
    sendError(res, "Failed to update agency", 500, error);
  }
}

export async function addAgencyDomain(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { agencyId } = req.params as { agencyId: string };
    const { domain, isPrimary } = req.body as AddAgencyDomainBody;

    if (!domain) {
      sendError(res, "domain is required", 400);
      return;
    }

    const agency = await prisma.agency.findUnique({
      where: { id: agencyId },
    });
    if (!agency) {
      sendError(res, "Agency not found", 404);
      return;
    }

    const agencyDomain = await prisma.agencyDomain.create({
      data: {
        agencyId,
        domain,
        isPrimary: isPrimary ?? false,
      },
    });

    await writeAuditLog(
      adminUserId,
      "agency.domain.add",
      "AgencyDomain",
      agencyDomain.id,
      { agencyId, domain, isPrimary: isPrimary ?? false },
    );

    sendSuccess(res, agencyDomain, "Domain added", 201);
  } catch (error: unknown) {
    sendError(res, "Failed to add domain", 500, error);
  }
}

export async function removeAgencyDomain(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { agencyId, domainId } = req.params as {
      agencyId: string;
      domainId: string;
    };

    const domain = await prisma.agencyDomain.findFirst({
      where: { id: domainId, agencyId },
    });
    if (!domain) {
      sendError(res, "Domain not found", 404);
      return;
    }

    await prisma.agencyDomain.delete({ where: { id: domainId } });

    await writeAuditLog(
      adminUserId,
      "agency.domain.remove",
      "AgencyDomain",
      domainId,
      { agencyId, domain: domain.domain },
    );

    sendSuccess(res, null, "Domain removed");
  } catch (error: unknown) {
    sendError(res, "Failed to remove domain", 500, error);
  }
}

export async function listAgencyBusinesses(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { agencyId } = req.params as { agencyId: string };

    const businesses = await prisma.business.findMany({
      where: { agencyId },
      include: {
        websiteSubscription: true,
      },
      orderBy: { createdAt: "desc" },
    });

    sendSuccess(res, businesses, "Agency businesses retrieved");
  } catch (error: unknown) {
    sendError(res, "Failed to list agency businesses", 500, error);
  }
}

export async function reassignBusiness(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { businessId } = req.params as { businessId: string };
    const { targetAgencyId } = req.body as ReassignBusinessBody;

    if (!targetAgencyId) {
      sendError(res, "targetAgencyId is required", 400);
      return;
    }

    const business = await prisma.business.findUnique({
      where: { id: businessId },
    });
    if (!business) {
      sendError(res, "Business not found", 404);
      return;
    }

    const targetAgency = await prisma.agency.findUnique({
      where: { id: targetAgencyId },
    });
    if (!targetAgency) {
      sendError(res, "Target agency not found", 404);
      return;
    }

	    const previousAgencyId = business.agencyId;
      const targetAgencyPricingConfigId =
        await getActiveAgencyPricingConfigId(targetAgencyId);
      const nextOwnershipType =
        targetAgency.slug === "uplift-direct" ? "uplift_direct" : "agency_managed";

	    const updated = await prisma.$transaction(async (tx) => {
        const updatedBusiness = await tx.business.update({
          where: { id: businessId },
          data: {
            agencyId: targetAgencyId,
            ownershipType: nextOwnershipType,
          },
        });

        await tx.websiteSubscription.updateMany({
          where: { businessId },
          data: {
            agencyId: targetAgencyId,
            agencyPricingConfigId: targetAgencyPricingConfigId,
          },
        });

        return updatedBusiness;
      });

    await writeAuditLog(
      adminUserId,
      "business.reassign",
      "Business",
      businessId,
	      {
	        previousAgencyId,
	        targetAgencyId,
	        ownershipType: nextOwnershipType,
          agencyPricingConfigId: targetAgencyPricingConfigId,
	      },
	    );

    sendSuccess(res, updated, "Business reassigned");
  } catch (error: unknown) {
    sendError(res, "Failed to reassign business", 500, error);
  }
}

export async function getRevenueShareRules(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { agencyId } = req.params as { agencyId: string };

    const rules = await prisma.agencyRevenueShareRule.findMany({
      where: { agencyId },
      orderBy: { createdAt: "desc" },
    });

    sendSuccess(res, rules, "Revenue share rules retrieved");
  } catch (error: unknown) {
    sendError(res, "Failed to get revenue share rules", 500, error);
  }
}

export async function createRevenueShareRule(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { agencyId } = req.params as { agencyId: string };
    const { platformSharePercent, agencySharePercent } =
      req.body as CreateRevenueShareRuleBody;

    if (platformSharePercent === undefined || agencySharePercent === undefined) {
      sendError(
        res,
        "platformSharePercent and agencySharePercent are required",
        400,
      );
      return;
    }

    const agency = await prisma.agency.findUnique({
      where: { id: agencyId },
    });
    if (!agency) {
      sendError(res, "Agency not found", 404);
      return;
    }

    await prisma.agencyRevenueShareRule.updateMany({
      where: { agencyId, isActive: true },
      data: { isActive: false, effectiveTo: new Date() },
    });

    const rule = await prisma.agencyRevenueShareRule.create({
      data: {
        agencyId,
        platformSharePercent,
        agencySharePercent,
        isActive: true,
        effectiveFrom: new Date(),
      },
    });

    await writeAuditLog(
      adminUserId,
      "revenue_share.create",
      "AgencyRevenueShareRule",
      rule.id,
      { agencyId, platformSharePercent, agencySharePercent },
    );

    sendSuccess(res, rule, "Revenue share rule created", 201);
  } catch (error: unknown) {
    sendError(res, "Failed to create revenue share rule", 500, error);
  }
}

export async function listSettlementRuns(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { agencyId } = req.params as { agencyId: string };

    const runs = await prisma.agencySettlementRun.findMany({
      where: { agencyId },
      orderBy: { createdAt: "desc" },
    });

    sendSuccess(res, runs, "Settlement runs retrieved");
  } catch (error: unknown) {
    sendError(res, "Failed to list settlement runs", 500, error);
  }
}

export async function getSettlementRunDetail(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { runId } = req.params as { runId: string };

    const run = await prisma.agencySettlementRun.findUnique({
      where: { id: runId },
      include: {
        lineItems: true,
      },
    });

    if (!run) {
      sendError(res, "Settlement run not found", 404);
      return;
    }

    sendSuccess(res, run, "Settlement run detail retrieved");
  } catch (error: unknown) {
    sendError(res, "Failed to get settlement run detail", 500, error);
  }
}

export async function approveSettlementRun(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { runId } = req.params as { runId: string };

    const run = await prisma.agencySettlementRun.findUnique({
      where: { id: runId },
    });
    if (!run) {
      sendError(res, "Settlement run not found", 404);
      return;
    }

    const updated = await prisma.agencySettlementRun.update({
      where: { id: runId },
      data: {
        status: "approved",
        approvedAt: new Date(),
        approvedBy: adminUserId,
      },
    });

    await writeAuditLog(
      adminUserId,
      "settlement.approve",
      "AgencySettlementRun",
      runId,
      { agencyId: run.agencyId },
    );

    sendSuccess(res, updated, "Settlement run approved");
  } catch (error: unknown) {
    sendError(res, "Failed to approve settlement run", 500, error);
  }
}

export async function markSettlementPaid(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { runId } = req.params as { runId: string };
    const { payoutReference } = req.body as MarkSettlementPaidBody;

    const run = await prisma.agencySettlementRun.findUnique({
      where: { id: runId },
    });
    if (!run) {
      sendError(res, "Settlement run not found", 404);
      return;
    }

    const updated = await prisma.agencySettlementRun.update({
      where: { id: runId },
      data: {
        status: "paid",
        paidAt: new Date(),
        payoutReference: payoutReference ?? null,
      },
    });

    await writeAuditLog(
      adminUserId,
      "settlement.paid",
      "AgencySettlementRun",
      runId,
      { agencyId: run.agencyId, payoutReference },
    );

    sendSuccess(res, updated, "Settlement run marked as paid");
  } catch (error: unknown) {
    sendError(res, "Failed to mark settlement as paid", 500, error);
  }
}

export async function markSettlementFailed(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const { runId } = req.params as { runId: string };
    const { failureReason } = req.body as MarkSettlementFailedBody;

    if (!failureReason) {
      sendError(res, "failureReason is required", 400);
      return;
    }

    const run = await prisma.agencySettlementRun.findUnique({
      where: { id: runId },
    });
    if (!run) {
      sendError(res, "Settlement run not found", 404);
      return;
    }

    const updated = await prisma.agencySettlementRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        failedAt: new Date(),
        failureReason,
      },
    });

    await writeAuditLog(
      adminUserId,
      "settlement.failed",
      "AgencySettlementRun",
      runId,
      { agencyId: run.agencyId, failureReason },
    );

    sendSuccess(res, updated, "Settlement run marked as failed");
  } catch (error: unknown) {
    sendError(res, "Failed to mark settlement as failed", 500, error);
  }
}

export async function listSalesRecords(
  _req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const [records, totals, bySalesperson] = await Promise.all([
      prisma.superAdminSalesRecord.findMany({
        orderBy: [{ recordedAt: "desc" }, { createdAt: "desc" }],
        take: 100,
        include: {
          createdByUser: {
            select: { id: true, name: true, email: true },
          },
        },
      }),
      prisma.superAdminSalesRecord.aggregate({
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
      prisma.superAdminSalesRecord.groupBy({
        by: ["salespersonName"],
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
    ]);

    const bySalespersonSummary = bySalesperson
      .map((row) => ({
        salespersonName: row.salespersonName,
        recordCount: row._count._all,
        amountCents: row._sum.amountCents ?? 0,
        amountUsd: (row._sum.amountCents ?? 0) / 100,
      }))
      .sort((a, b) => b.amountCents - a.amountCents);

    const totalAmountCents = totals._sum.amountCents ?? 0;

    sendSuccess(
      res,
      {
        summary: {
          recordCount: totals._count._all,
          totalAmountCents,
          totalAmountUsd: totalAmountCents / 100,
          bySalesperson: bySalespersonSummary,
        },
        records: records.map(serializeSalesRecord),
      },
      "Sales records retrieved",
    );
  } catch (error: unknown) {
    sendError(res, "Failed to list sales records", 500, error);
  }
}

export async function createSalesRecord(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const adminUserId = req.authUserId;
    if (!adminUserId) {
      sendError(res, "Unauthorized", 401);
      return;
    }

    const body = req.body as CreateSalesRecordBody;
    const salespersonName = body.salespersonName?.trim();
    const amountCents = parseSalesAmountCents(body);
    const note = body.note?.trim();
    const recordedAt = parseSalesRecordedAt(body.recordedAt);

    if (!salespersonName) {
      sendError(res, "Sales person name is required", 400);
      return;
    }

    if (salespersonName.length > USER_INPUT_LIMITS.authorName) {
      sendError(res, "Sales person name must be 160 characters or fewer", 400);
      return;
    }

    if (note && note.length > USER_INPUT_LIMITS.notes) {
      sendError(res, "Sales record note must be 5000 characters or fewer", 400);
      return;
    }

    if (amountCents === null || amountCents <= 0) {
      sendError(res, "Amount must be greater than zero", 400);
      return;
    }

    if (amountCents > 100_000_000_00) {
      sendError(res, "Amount is too large", 400);
      return;
    }

    const record = await prisma.superAdminSalesRecord.create({
      data: {
        salespersonName,
        amountCents,
        note: note || undefined,
        recordedAt,
        createdByUserId: adminUserId,
      },
      include: {
        createdByUser: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    await writeAuditLog(
      adminUserId,
      "sales_record.create",
      "SuperAdminSalesRecord",
      record.id,
      {
        salespersonName,
        amountCents,
        amountUsd: amountCents / 100,
        recordedAt: recordedAt.toISOString(),
      },
    );

    sendSuccess(
      res,
      serializeSalesRecord(record),
      "Sales record created",
      201,
    );
  } catch (error: unknown) {
    sendError(res, "Failed to create sales record", 500, error);
  }
}

export async function getAdminAuditLog(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const {
      page = "1",
      limit = "50",
      action,
      targetType,
    } = req.query as AuditLogQueryParams;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const where: { action?: string; targetType?: string } = {};
    if (action) where.action = action;
    if (targetType) where.targetType = targetType;

    const [logs, total] = await Promise.all([
      prisma.adminAuditLog.findMany({
        where,
        include: {
          adminUser: {
            select: { id: true, name: true, email: true },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.adminAuditLog.count({ where }),
    ]);

    sendSuccess(
      res,
      {
        logs,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      },
      "Audit log retrieved",
    );
  } catch (error: unknown) {
    sendError(res, "Failed to get audit log", 500, error);
  }
}
