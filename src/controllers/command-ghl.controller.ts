import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { canAccessPipelineRep } from "../command/pipeline-access";
import {
  commandPaginationResult,
  parseCommandPagination,
} from "../command/pagination";
import { sendError, sendSuccess } from "../utils/response.utils";
import { aggregatePipelineSourceConversion } from "../command/pipeline-metrics";
import { commandMonthRange, currentCommandMonth } from "../command/toronto-period";
import { Prisma } from "@prisma/client";
import { resolveApprovedCommandDecisions } from "../command/decision.service";
import {
  adjustCommandPipelineStageGroups,
  COMMAND_PIPELINE_STAGE_CORRECTION_INPUT,
  parseCommandPipelineStageCorrection,
} from "../command/pipeline-stage-correction";
import {
  invalidateCommandCache,
  readCommandCache,
  writeCommandCache,
} from "../utils/command-cache";

function queryString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function resolvePipelineScope(req: Request): Promise<
  | { allowed: true; assignedToGhlId?: string; repId?: string }
  | { allowed: false; status: number; message: string }
> {
  const requestedRepId = queryString(req.query.repId);
  const capabilities = req.commandCapabilities ?? [];
  const hasAll = capabilities.includes("view.pipeline.all");

  if (requestedRepId) {
    if (
      !canAccessPipelineRep({
        capabilities,
        actorRepId: req.commandRepId ?? null,
        requestedRepId,
      })
    ) {
      return { allowed: false, status: 403, message: "Forbidden rep scope" };
    }
    const profile = await prisma.commandRepProfile.findUnique({
      where: { id: requestedRepId },
      select: { ghlUserId: true, isActive: true },
    });
    if (!profile?.isActive) {
      return { allowed: false, status: 404, message: "Rep not found" };
    }
    return {
      allowed: true,
      assignedToGhlId: profile.ghlUserId ?? "__unmapped_rep__",
      repId: requestedRepId,
    };
  }

  if (hasAll) return { allowed: true };
  if (!capabilities.includes("view.own") || !req.commandRepId) {
    return { allowed: false, status: 403, message: "Pipeline access required" };
  }
  const profile = await prisma.commandRepProfile.findUnique({
    where: { id: req.commandRepId },
    select: { ghlUserId: true, isActive: true },
  });
  if (!profile?.isActive) {
    return { allowed: false, status: 403, message: "Active rep required" };
  }
  return {
    allowed: true,
    assignedToGhlId: profile.ghlUserId ?? "__unmapped_rep__",
    repId: req.commandRepId,
  };
}

export async function getCommandGhlOverview(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const cached = await readCommandCache<Record<string, unknown>>("ghl-overview-v1");
    if (cached) {
      sendSuccess(res, cached, "Command GHL overview");
      return;
    }
    const [contacts, opportunities, byStatus, lastRun] = await Promise.all([
      prisma.commandGhlContact.count({ where: { isActive: true } }),
      prisma.commandGhlOpportunity.count({ where: { isActive: true } }),
      prisma.commandGhlOpportunity.groupBy({
        by: ["status"],
        where: { isActive: true },
        _count: { _all: true },
      }),
      prisma.commandProviderSyncRun.findFirst({
        where: { provider: "ghl" },
        orderBy: { startedAt: "desc" },
      }),
    ]);
    const payload = {
        contacts,
        opportunities,
        opportunitiesByStatus: Object.fromEntries(
          byStatus.map((row) => [row.status, row._count._all]),
        ),
        lastSync: lastRun,
      };
    await writeCommandCache("ghl-overview-v1", payload, 60);
    sendSuccess(res, payload, "Command GHL overview");
  } catch (error) {
    sendError(res, "Failed to load Command GHL overview", 500, error);
  }
}

export async function getCommandPipeline(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const scope = await resolvePipelineScope(req);
    if (!scope.allowed) {
      sendError(res, scope.message, scope.status);
      return;
    }
    const where = {
      isActive: true,
      ...(scope.assignedToGhlId
        ? { assignedToGhlId: scope.assignedToGhlId }
        : {}),
    };
    const month =
      typeof req.query.month === "string" ? req.query.month : currentCommandMonth();
    const period = commandMonthRange(month);
    const asOf = new Date();
    const capabilities = req.commandCapabilities ?? [];
    const canViewOwnFinancials =
      capabilities.includes("view.financials") ||
      capabilities.includes("view.own.financials");
    const canViewCompanyFinancials = capabilities.includes("view.financials");
    const { page, pageSize, skip } = parseCommandPagination({
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    const cacheKey = `pipeline-v3:${scope.repId ?? "all"}:${period.month}:${page}:${pageSize}:${canViewOwnFinancials ? "money" : "redacted"}:${canViewCompanyFinancials ? "company" : "scoped"}`;
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command pipeline");
      return;
    }
    const [
      opportunities,
      opportunityTotal,
      byStatus,
      byStage,
      bySourceStatus,
      cohortAssignments,
      cohortCoverage,
      acquisitionCosts,
      decisions,
      stageOverrides,
      stageCatalog,
    ] = await Promise.all([
      prisma.commandGhlOpportunity.findMany({
        where,
        orderBy: [
          { lastActionAt: "desc" },
          { providerUpdatedAt: "desc" },
        ],
        skip,
        take: pageSize,
      }),
      prisma.commandGhlOpportunity.count({ where }),
      prisma.commandGhlOpportunity.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
      }),
      prisma.commandGhlOpportunity.groupBy({
        by: ["pipelineStageId", "pipelineStageName", "pipelineStageIndex"],
        where,
        _count: { _all: true },
        orderBy: { pipelineStageIndex: "asc" },
      }),
      prisma.commandGhlOpportunity.groupBy({
        by: ["source", "status"],
        where,
        _count: { _all: true },
      }),
      prisma.commandGhlLeadAssignment.findMany({
        where: {
          observedFrom: { gte: period.start, lt: period.end },
          ...(scope.repId ? { repId: scope.repId } : {}),
        },
        distinct: ["ghlOpportunityId"],
        include: {
          opportunity: { select: { status: true } },
          rep: { select: { id: true, name: true } },
        },
        orderBy: [
          { ghlOpportunityId: "asc" },
          { observedFrom: "asc" },
        ],
      }),
      prisma.commandGhlLeadAssignment.aggregate({ _min: { observedFrom: true } }),
      canViewCompanyFinancials
        ? prisma.commandCostEntry.groupBy({
            by: ["currency"],
            where: {
              deletedAt: null,
              category: "acquisition",
              occurredAt: { gte: period.start, lt: period.end },
            },
            _sum: { amountMinor: true },
          })
        : Promise.resolve([]),
      resolveApprovedCommandDecisions(period.end),
      prisma.commandDataOverride.findMany({
        where: {
          provider: "ghl",
          entityType: "ghl_opportunity",
          field: "pipelineStage",
          status: "approved",
          effectiveAt: { lte: asOf },
          OR: [{ expiresAt: null }, { expiresAt: { gt: asOf } }],
        },
        orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
      }),
      prisma.commandGhlOpportunity.findMany({
        where: { isActive: true },
        distinct: ["pipelineId", "pipelineStageId"],
        select: {
          pipelineId: true,
          pipelineStageId: true,
          pipelineStageName: true,
          pipelineStageIndex: true,
        },
        orderBy: [
          { pipelineId: "asc" },
          { pipelineStageIndex: "asc" },
        ],
      }),
    ]);
    const stageCorrectionByOpportunity = new Map<
      string,
      {
        id: string;
        effectiveAt: Date;
        correction: NonNullable<
          ReturnType<typeof parseCommandPipelineStageCorrection>
        >;
      }
    >();
    for (const override of stageOverrides) {
      if (stageCorrectionByOpportunity.has(override.entityId)) continue;
      const correction = parseCommandPipelineStageCorrection(override.value);
      if (!correction) continue;
      stageCorrectionByOpportunity.set(override.entityId, {
        id: override.id,
        effectiveAt: override.effectiveAt,
        correction,
      });
    }
    const correctedOpportunityRows =
      stageCorrectionByOpportunity.size > 0
        ? await prisma.commandGhlOpportunity.findMany({
            where: {
              ...where,
              ghlOpportunityId: {
                in: [...stageCorrectionByOpportunity.keys()],
              },
            },
            select: {
              ghlOpportunityId: true,
              pipelineStageId: true,
              pipelineStageName: true,
              pipelineStageIndex: true,
            },
          })
        : [];
    const correctedStageGroups = adjustCommandPipelineStageGroups({
      groups: byStage.map((row) => ({
        stageId: row.pipelineStageId,
        stageName: row.pipelineStageName ?? "Unknown stage",
        stageIndex: row.pipelineStageIndex,
        count: row._count._all,
      })),
      correctedOpportunities: correctedOpportunityRows.flatMap((opportunity) => {
        const stored = stageCorrectionByOpportunity.get(
          opportunity.ghlOpportunityId,
        );
        return stored
          ? [{ ...opportunity, correction: stored.correction }]
          : [];
      }),
    });
    const cohortByRep = new Map<
      string,
      { repId: string | null; repName: string; assigned: number; won: number }
    >();
    for (const assignment of cohortAssignments) {
      const key = assignment.repId ?? "unassigned";
      const row = cohortByRep.get(key) ?? {
        repId: assignment.repId,
        repName: assignment.rep?.name ?? "Unassigned",
        assigned: 0,
        won: 0,
      };
      row.assigned += 1;
      if (assignment.opportunity.status.toLowerCase() === "won") row.won += 1;
      cohortByRep.set(key, row);
    }
    const cohort = [...cohortByRep.values()].map((row) => ({
      ...row,
      closeRatePercent:
        row.assigned === 0
          ? null
          : new Prisma.Decimal(row.won).mul(100).div(row.assigned).toFixed(2),
    }));
    const cplPolicyApproved = Boolean(decisions.cpl_policy);
    const totalAssigned = cohort.reduce((total, row) => total + row.assigned, 0);
    const contactIds = new Set(
      opportunities.flatMap((item) =>
        item.ghlContactId ? [item.ghlContactId] : [],
      ),
    );
    const contacts = await prisma.commandGhlContact.findMany({
      where: { ghlContactId: { in: [...contactIds] } },
      select: {
        ghlContactId: true,
        name: true,
        email: true,
        phone: true,
        source: true,
      },
    });
    const contactById = new Map(
      contacts.map((contact) => [contact.ghlContactId, contact]),
    );

    const payload = {
        scope: scope.assignedToGhlId ? "rep" : "company",
        pagination: commandPaginationResult({
          page,
          pageSize,
          total: opportunityTotal,
        }),
        opportunitiesByStatus: Object.fromEntries(
          byStatus.map((row) => [row.status, row._count._all]),
        ),
        opportunitiesByStage: correctedStageGroups,
        stageOptions: stageCatalog.map((stage) => ({
          pipelineId: stage.pipelineId,
          stageId: stage.pipelineStageId,
          stageName: stage.pipelineStageName ?? "Unknown stage",
          stageIndex: stage.pipelineStageIndex,
        })),
        correctionsEnabled: Boolean(decisions.provider_override_policy),
        conversionBySource: aggregatePipelineSourceConversion(
          bySourceStatus.map((row) => ({
            source: row.source,
            status: row.status,
            count: row._count._all,
          })),
        ),
        assignedCohort: {
          month: period.month,
          coverageStartsAt: cohortCoverage._min.observedFrom,
          warning:
            cohortCoverage._min.observedFrom === null
              ? "Assignment history begins after the next successful GHL sync."
              : "Cohorts use first-observed Command assignment dates and do not invent earlier history.",
          reps: cohort,
          assigned: totalAssigned,
          won: cohort.reduce((total, row) => total + row.won, 0),
          closeRatePercent:
            totalAssigned === 0
              ? null
              : new Prisma.Decimal(
                  cohort.reduce((total, row) => total + row.won, 0),
                )
                  .mul(100)
                  .div(totalAssigned)
                  .toFixed(2),
        },
        cplByCurrency: canViewCompanyFinancials && cplPolicyApproved
          ? Object.fromEntries(
              acquisitionCosts.map((cost) => [
                cost.currency,
                totalAssigned > 0
                  ? (cost._sum.amountMinor ?? new Prisma.Decimal(0))
                      .div(totalAssigned)
                      .toDecimalPlaces(4)
                      .toString()
                  : null,
              ]),
            )
          : null,
        opportunities: opportunities.map((opportunity) => {
          const stored = stageCorrectionByOpportunity.get(
            opportunity.ghlOpportunityId,
          );
          const corrected = stored?.correction;
          const correctedFurthest =
            corrected?.stageIndex !== null &&
            corrected?.stageIndex !== undefined &&
            (opportunity.furthestStageIndex === null ||
              corrected.stageIndex > opportunity.furthestStageIndex);
          return {
            ...opportunity,
            pipelineStageId:
              corrected?.stageId ?? opportunity.pipelineStageId,
            pipelineStageName:
              corrected?.stageName ?? opportunity.pipelineStageName,
            pipelineStageIndex:
              corrected?.stageIndex ?? opportunity.pipelineStageIndex,
            furthestStageId: correctedFurthest
              ? corrected?.stageId
              : opportunity.furthestStageId,
            furthestStageName: correctedFurthest
              ? corrected?.stageName
              : opportunity.furthestStageName,
            furthestStageIndex: correctedFurthest
              ? corrected?.stageIndex
              : opportunity.furthestStageIndex,
            reportingCorrection: stored
              ? { id: stored.id, effectiveAt: stored.effectiveAt }
              : null,
            monetaryValue: canViewOwnFinancials
              ? opportunity.monetaryValue?.toString() ?? null
              : null,
            currency: canViewOwnFinancials ? opportunity.currency : null,
            contact: opportunity.ghlContactId
              ? (contactById.get(opportunity.ghlContactId) ?? null)
              : null,
          };
        }),
      };
    await writeCommandCache(cacheKey, payload, 60);
    sendSuccess(res, payload, "Command pipeline");
  } catch (error) {
    sendError(res, "Failed to load Command pipeline", 500, error);
  }
}

export async function updateCommandPipelineStage(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = COMMAND_PIPELINE_STAGE_CORRECTION_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid pipeline stage correction", 400, parsed.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }

  try {
    const opportunity = await prisma.commandGhlOpportunity.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        ghlOpportunityId: true,
        pipelineId: true,
        pipelineStageId: true,
        pipelineStageName: true,
        pipelineStageIndex: true,
        assignedToGhlId: true,
        isActive: true,
      },
    });
    if (!opportunity?.isActive) {
      sendError(res, "Opportunity not found", 404);
      return;
    }

    const scope = await resolvePipelineScope(req);
    if (
      !scope.allowed ||
      (scope.assignedToGhlId !== undefined &&
        scope.assignedToGhlId !== opportunity.assignedToGhlId)
    ) {
      sendError(res, "Forbidden rep scope", 403);
      return;
    }

    const decisions = await resolveApprovedCommandDecisions(new Date());
    if (!decisions.provider_override_policy) {
      sendError(
        res,
        "Provider correction policy must be approved in Settings before changing a reporting stage",
        409,
      );
      return;
    }

    const knownStage = await prisma.commandGhlOpportunity.findFirst({
      where: {
        isActive: true,
        pipelineId: opportunity.pipelineId,
        pipelineStageId: parsed.data.stageId,
        pipelineStageName: parsed.data.stageName,
        pipelineStageIndex: parsed.data.stageIndex,
      },
      select: { id: true },
    });
    if (!knownStage) {
      sendError(res, "Stage is not part of this GHL pipeline", 400);
      return;
    }

    const now = new Date();
    const correctionValue = {
      stageId: parsed.data.stageId,
      stageName: parsed.data.stageName,
      stageIndex: parsed.data.stageIndex,
    };
    const correction = await prisma.$transaction(async (tx) => {
      const created = await tx.commandDataOverride.create({
        data: {
          provider: "ghl",
          entityType: "ghl_opportunity",
          entityId: opportunity.ghlOpportunityId,
          field: "pipelineStage",
          value: correctionValue,
          reason: parsed.data.reason,
          effectiveAt: now,
          approvedByUserId: req.authUserId!,
          createdByUserId: req.authUserId!,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "command.pipeline_stage.correct",
          targetType: "command_ghl_opportunity",
          targetId: opportunity.id,
          before: {
            stageId: opportunity.pipelineStageId,
            stageName: opportunity.pipelineStageName,
            stageIndex: opportunity.pipelineStageIndex,
          },
          after: correctionValue,
          details: {
            provider: "ghl",
            providerOpportunityId: opportunity.ghlOpportunityId,
            reason: parsed.data.reason,
            writesBackToProvider: false,
          },
          ipAddress: req.ip,
        },
      });
      return created;
    });

    await invalidateCommandCache();
    sendSuccess(
      res,
      {
        id: correction.id,
        opportunityId: opportunity.id,
        stage: correctionValue,
        effectiveAt: correction.effectiveAt,
        writesBackToProvider: false,
      },
      "Pipeline reporting stage corrected",
    );
  } catch (error) {
    sendError(res, "Failed to correct pipeline reporting stage", 500, error);
  }
}
