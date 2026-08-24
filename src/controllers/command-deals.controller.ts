import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { canAccessDealRep } from "../command/deal-access";
import { sendError, sendSuccess } from "../utils/response.utils";
import { isSettledGhlPayment } from "../command/ghl-payment-metrics";
import { majorToMinorExact } from "../command/money";
import { Prisma } from "@prisma/client";
import {
  commandDealCorrectionKey,
  COMMAND_DEAL_SERVICE_CORRECTION_INPUT,
  COMMAND_DEAL_SOURCE_TYPES,
} from "../command/deal-service-correction";
import { resolveApprovedCommandDecisions } from "../command/decision.service";
import { invalidateCommandCache } from "../utils/command-cache";

function queryString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function resolveRepUserScope(req: Request): Promise<
  | {
      allowed: true;
      repId: string | null;
      repUserId: string | null;
      repGhlUserId: string | null;
    }
  | { allowed: false; status: number; message: string }
> {
  const capabilities = req.commandCapabilities ?? [];
  const requestedRepId = queryString(req.query.repId);
  const hasAll = capabilities.includes("view.deals.all");

  if (requestedRepId) {
    if (
      !canAccessDealRep({
        capabilities,
        actorRepId: req.commandRepId ?? null,
        requestedRepId,
      })
    ) {
      return { allowed: false, status: 403, message: "Forbidden rep scope" };
    }
    const profile = await prisma.commandRepProfile.findUnique({
      where: { id: requestedRepId },
      select: { id: true, userId: true, ghlUserId: true, isActive: true },
    });
    if (!profile?.isActive) {
      return { allowed: false, status: 404, message: "Rep not found" };
    }
    return {
      allowed: true,
      repId: profile.id,
      repUserId: profile.userId,
      repGhlUserId: profile.ghlUserId,
    };
  }

  if (hasAll) {
    return {
      allowed: true,
      repId: null,
      repUserId: null,
      repGhlUserId: null,
    };
  }
  if (!capabilities.includes("view.own.financials") || !req.commandRepId) {
    return { allowed: false, status: 403, message: "Deal access required" };
  }
  const profile = await prisma.commandRepProfile.findUnique({
    where: { id: req.commandRepId },
    select: { id: true, userId: true, ghlUserId: true, isActive: true },
  });
  if (!profile?.isActive) {
    return { allowed: false, status: 403, message: "Active rep required" };
  }
  return {
    allowed: true,
    repId: profile.id,
    repUserId: profile.userId,
    repGhlUserId: profile.ghlUserId,
  };
}

function providerMajorToMinor(
  amount: Prisma.Decimal | null,
  currency: string | null,
): string | null {
  if (!amount || !currency) return null;
  try {
    return majorToMinorExact(amount, currency).toString();
  } catch {
    return null;
  }
}

export async function getCommandDeals(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const scope = await resolveRepUserScope(req);
    if (!scope.allowed) {
      sendError(res, scope.message, scope.status);
      return;
    }

    const scopedAssignments = scope.repUserId
      ? await prisma.salesCustomerAssignment.findMany({
          where: { salespersonId: scope.repUserId },
          select: { businessId: true },
        })
      : null;
    const scopedBusinessIds = scopedAssignments?.map((row) => row.businessId);
    const scopedGhlOpportunities = scope.repId
      ? await prisma.commandGhlOpportunity.findMany({
          where: {
            isActive: true,
            assignedToGhlId: scope.repGhlUserId ?? "__unmapped_rep__",
            ghlContactId: { not: null },
          },
          select: { ghlContactId: true },
          distinct: ["ghlContactId"],
        })
      : null;
    const scopedGhlContactIds = scopedGhlOpportunities?.flatMap((row) =>
      row.ghlContactId ? [row.ghlContactId] : [],
    );
    const asOf = new Date();

    const [
      latestSubscriptions,
      oneTimeSales,
      services,
      ghlSubscriptions,
      ghlOneTimeTransactions,
      knownStripeSubscriptions,
      serviceOverrides,
      decisions,
    ] = await Promise.all([
      prisma.commandStripeSubscriptionSnapshot.findMany({
        where:
          scopedBusinessIds === undefined
            ? undefined
            : { businessId: { in: scopedBusinessIds } },
        orderBy: [{ occurredAt: "desc" }, { stripeSubscriptionId: "asc" }],
        take: 1000,
      }),
      prisma.salesEntry.findMany({
        where: scope.repUserId ? { salespersonId: scope.repUserId } : undefined,
        include: {
          assignment: {
            include: {
              business: { select: { id: true, businessName: true, userId: true } },
            },
          },
          salesperson: {
            select: { id: true, name: true, CommandRepProfile: { select: { id: true, name: true } } },
          },
        },
        orderBy: { soldAt: "desc" },
        take: 1000,
      }),
      prisma.commandService.findMany({ orderBy: { name: "asc" } }),
      prisma.commandGhlPaymentSubscription.findMany({
        where: {
          isActive: true,
          ...(scopedGhlContactIds === undefined
            ? {}
            : { contactId: { in: scopedGhlContactIds } }),
        },
        orderBy: [{ providerUpdatedAt: "desc" }, { id: "asc" }],
        take: 1000,
      }),
      prisma.commandGhlPaymentTransaction.findMany({
        where: {
          isActive: true,
          providerSubscriptionId: null,
          ...(scopedGhlContactIds === undefined
            ? {}
            : { contactId: { in: scopedGhlContactIds } }),
        },
        orderBy: [{ fulfilledAt: "desc" }, { id: "asc" }],
        take: 1000,
      }),
      prisma.commandStripeSubscriptionSnapshot.findMany({
        select: { stripeSubscriptionId: true },
      }),
      prisma.commandDataOverride.findMany({
        where: {
          field: "serviceId",
          status: "approved",
          effectiveAt: { lte: asOf },
          OR: [{ expiresAt: null }, { expiresAt: { gt: asOf } }],
        },
        orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
      }),
      resolveApprovedCommandDecisions(asOf),
    ]);
    const serviceById = new Map(services.map((service) => [service.id, service]));
    const serviceCorrectionByDeal = new Map<
      string,
      { id: string; effectiveAt: Date; serviceId: string }
    >();
    for (const override of serviceOverrides) {
      if (typeof override.value !== "string") continue;
      const key = commandDealCorrectionKey(
        override.entityType,
        override.entityId,
      );
      if (serviceCorrectionByDeal.has(key)) continue;
      if (!serviceById.has(override.value)) continue;
      serviceCorrectionByDeal.set(key, {
        id: override.id,
        effectiveAt: override.effectiveAt,
        serviceId: override.value,
      });
    }
    const correctedService = (sourceType: string, sourceId: string) => {
      const correction = serviceCorrectionByDeal.get(
        commandDealCorrectionKey(sourceType, sourceId),
      );
      const service = correction
        ? (serviceById.get(correction.serviceId) ?? null)
        : null;
      return correction && service ? { correction, service } : null;
    };

    const subscriptionIds = latestSubscriptions.map(
      (item) => item.stripeSubscriptionId,
    );
    const businessIds = latestSubscriptions.flatMap((item) =>
      item.businessId ? [item.businessId] : [],
    );
    const userIds = latestSubscriptions.flatMap((item) =>
      item.userId ? [item.userId] : [],
    );
    const stripeSubscriptionIdSet = new Set(
      knownStripeSubscriptions.map((row) => row.stripeSubscriptionId),
    );
    const visibleGhlSubscriptions = ghlSubscriptions.filter(
      (row) =>
        !row.providerSubscriptionId ||
        !stripeSubscriptionIdSet.has(row.providerSubscriptionId),
    );
    const ghlContactIds = [
      ...new Set(
        [...visibleGhlSubscriptions, ...ghlOneTimeTransactions].flatMap((row) =>
          row.contactId ? [row.contactId] : [],
        ),
      ),
    ];
    const ghlProviderSubscriptionIds = visibleGhlSubscriptions.flatMap((row) =>
      row.providerSubscriptionId ? [row.providerSubscriptionId] : [],
    );
    const [
      invoices,
      firstEvents,
      businesses,
      users,
      assignments,
      ghlOpportunityOwners,
      ghlRepProfiles,
      ghlSubscriptionTransactions,
    ] =
      await Promise.all([
        prisma.commandStripeInvoice.findMany({
          where: {
            stripeSubscriptionId: { in: subscriptionIds },
            status: "paid",
            paidAt: { not: null },
          },
          select: {
            stripeSubscriptionId: true,
            amountPaidMinor: true,
            currency: true,
          },
        }),
        prisma.commandStripeSubscriptionEvent.groupBy({
          by: ["stripeSubscriptionId"],
          where: { stripeSubscriptionId: { in: subscriptionIds } },
          _min: { occurredAt: true },
        }),
        prisma.business.findMany({
          where: { id: { in: businessIds } },
          select: { id: true, businessName: true, userId: true },
        }),
        prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        }),
        prisma.salesCustomerAssignment.findMany({
          where: { businessId: { in: businessIds } },
          select: {
            businessId: true,
            salesperson: {
              select: {
                id: true,
                name: true,
                CommandRepProfile: { select: { id: true, name: true } },
              },
            },
          },
        }),
        prisma.commandGhlOpportunity.findMany({
          where: {
            isActive: true,
            ghlContactId: { in: ghlContactIds },
          },
          select: {
            ghlContactId: true,
            assignedToGhlId: true,
            providerUpdatedAt: true,
          },
          orderBy: { providerUpdatedAt: "desc" },
        }),
        prisma.commandRepProfile.findMany({
          where: { isActive: true, ghlUserId: { not: null } },
          select: { id: true, name: true, ghlUserId: true },
        }),
        prisma.commandGhlPaymentTransaction.findMany({
          where: {
            isActive: true,
            providerSubscriptionId: { in: ghlProviderSubscriptionIds },
          },
          orderBy: { fulfilledAt: "desc" },
        }),
      ]);

    const invoiceSummary = new Map<
      string,
      { paidInvoiceCount: number; paidToDateByCurrency: Record<string, bigint> }
    >();
    for (const invoice of invoices) {
      if (!invoice.stripeSubscriptionId) continue;
      const summary = invoiceSummary.get(invoice.stripeSubscriptionId) ?? {
        paidInvoiceCount: 0,
        paidToDateByCurrency: {},
      };
      summary.paidInvoiceCount += 1;
      const currency = invoice.currency.toLowerCase();
      summary.paidToDateByCurrency[currency] =
        (summary.paidToDateByCurrency[currency] ?? 0n) +
        BigInt(invoice.amountPaidMinor.toFixed(0));
      invoiceSummary.set(invoice.stripeSubscriptionId, summary);
    }

    const firstEventBySubscription = new Map(
      firstEvents.map((row) => [
        row.stripeSubscriptionId,
        row._min.occurredAt ?? null,
      ]),
    );
    const businessById = new Map(businesses.map((item) => [item.id, item]));
    const userById = new Map(users.map((item) => [item.id, item]));
    const assignmentByBusiness = new Map(
      assignments.map((item) => [item.businessId, item.salesperson]),
    );
    const latestOwnerGhlIdByContact = new Map<string, string | null>();
    for (const opportunity of ghlOpportunityOwners) {
      if (
        opportunity.ghlContactId &&
        !latestOwnerGhlIdByContact.has(opportunity.ghlContactId)
      ) {
        latestOwnerGhlIdByContact.set(
          opportunity.ghlContactId,
          opportunity.assignedToGhlId,
        );
      }
    }
    const ghlRepByUserId = new Map(
      ghlRepProfiles.flatMap((rep) =>
        rep.ghlUserId ? [[rep.ghlUserId, { id: rep.id, name: rep.name }]] : [],
      ),
    );
    const ownerForContact = (contactId: string | null) => {
      const ownerId = contactId
        ? latestOwnerGhlIdByContact.get(contactId)
        : null;
      return ownerId ? (ghlRepByUserId.get(ownerId) ?? null) : null;
    };

    const subscriptions = latestSubscriptions.map((subscription) => {
      const matchingServices = services.filter((service) =>
        service.stripePriceIds.some((priceId) =>
          subscription.stripePriceIds.includes(priceId),
        ),
      );
      const invoice = invoiceSummary.get(subscription.stripeSubscriptionId);
      const corrected = correctedService(
        "stripe_subscription",
        subscription.stripeSubscriptionId,
      );
      return {
        type: "subscription" as const,
        id: subscription.stripeSubscriptionId,
        provider: "stripe",
        providerId: subscription.stripeSubscriptionId,
        creditSourceType: "stripe_subscription",
        creditSourceId: subscription.stripeSubscriptionId,
        account: subscription.userId
          ? (userById.get(subscription.userId) ?? null)
          : null,
        business: subscription.businessId
          ? (businessById.get(subscription.businessId) ?? null)
          : null,
        ownerRep: subscription.businessId
          ? (assignmentByBusiness.get(subscription.businessId)?.CommandRepProfile ??
            null)
          : null,
        service: corrected
          ? { id: corrected.service.id, name: corrected.service.name }
          : matchingServices.length === 1
            ? { id: matchingServices[0]!.id, name: matchingServices[0]!.name }
            : null,
        serviceMappingStatus: corrected
          ? "corrected"
          : matchingServices.length === 1
            ? "mapped"
            : matchingServices.length > 1
              ? "ambiguous"
              : "unmapped",
        reportingCorrection: corrected?.correction ?? null,
        status: subscription.status,
        paused: subscription.pauseCollectionBehavior !== null,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        monthlyRecurringMinor: subscription.monthlyRecurringMinor.toString(),
        currency: subscription.currency,
        startedAt:
          firstEventBySubscription.get(subscription.stripeSubscriptionId) ??
          subscription.currentPeriodStart,
        nextRenewalAt: subscription.currentPeriodEnd,
        paidInvoiceCount: invoice?.paidInvoiceCount ?? 0,
        paidToDateByCurrency: Object.fromEntries(
          Object.entries(invoice?.paidToDateByCurrency ?? {}).map(
            ([currency, amount]) => [currency, amount.toString()],
          ),
        ),
      };
    });

    const oneTime = oneTimeSales.map((sale) => {
      const corrected = correctedService("legacy_sale", sale.id);
      return {
        type: "one_time" as const,
        id: sale.id,
        provider: "manual_sales_ledger",
        providerId: sale.id,
        creditSourceType: "legacy_sale",
        creditSourceId: sale.id,
        account: null,
        business: sale.assignment.business,
        ownerRep: sale.salesperson.CommandRepProfile,
        service: corrected
          ? { id: corrected.service.id, name: corrected.service.name }
          : { id: null, name: sale.itemSold },
        serviceMappingStatus: corrected ? "corrected" : "legacy_label",
        reportingCorrection: corrected?.correction ?? null,
        status: "recorded",
        paused: false,
        cancelAtPeriodEnd: false,
        monthlyRecurringMinor: "0",
        priceMinor: String(sale.amountCents),
        currency: sale.currency.toLowerCase(),
        startedAt: sale.soldAt,
        nextRenewalAt: null,
        paidInvoiceCount: 0,
        paidToDateByCurrency: {},
      };
    });

    const transactionsBySubscription = new Map<
      string,
      typeof ghlSubscriptionTransactions
    >();
    for (const transaction of ghlSubscriptionTransactions) {
      if (!transaction.providerSubscriptionId) continue;
      const rows =
        transactionsBySubscription.get(transaction.providerSubscriptionId) ?? [];
      rows.push(transaction);
      transactionsBySubscription.set(transaction.providerSubscriptionId, rows);
    }
    const ghlRecurring = visibleGhlSubscriptions.map((subscription) => {
      const transactionRows = subscription.providerSubscriptionId
        ? (transactionsBySubscription.get(subscription.providerSubscriptionId) ?? [])
        : [];
      const paidToDateByCurrency: Record<string, Prisma.Decimal> = {};
      for (const transaction of transactionRows) {
        if (
          !transaction.currency ||
          !transaction.amount ||
          !isSettledGhlPayment(transaction.status)
        ) {
          continue;
        }
        const currency = transaction.currency.toLowerCase();
        const net = transaction.amount.sub(
          transaction.amountRefunded ?? new Prisma.Decimal(0),
        );
        const minor = providerMajorToMinor(net, currency);
        if (minor === null) continue;
        paidToDateByCurrency[currency] = (
          paidToDateByCurrency[currency] ?? new Prisma.Decimal(0)
        ).add(minor);
      }
      const monthlyRecurringMinor = providerMajorToMinor(
        subscription.amount,
        subscription.currency,
      );
      const corrected = correctedService(
        "ghl_subscription",
        subscription.ghlSubscriptionRecordId,
      );
      return {
        type: "subscription" as const,
        id: subscription.id,
        provider: "ghl_payments",
        providerId:
          subscription.providerSubscriptionId ??
          subscription.ghlSubscriptionRecordId,
        creditSourceType: "ghl_subscription",
        creditSourceId: subscription.ghlSubscriptionRecordId,
        account: {
          id: subscription.contactId ?? subscription.id,
          name: subscription.contactName ?? "GHL contact",
          email: subscription.contactEmail ?? "",
        },
        business: null,
        ownerRep: ownerForContact(subscription.contactId),
        service: corrected
          ? { id: corrected.service.id, name: corrected.service.name }
          : subscription.entitySourceName
            ? { id: null, name: subscription.entitySourceName }
            : null,
        serviceMappingStatus: corrected
          ? "corrected"
          : "provider_label_unverified",
        reportingCorrection: corrected?.correction ?? null,
        status: subscription.status,
        paused: false,
        cancelAtPeriodEnd: false,
        monthlyRecurringMinor: monthlyRecurringMinor ?? "0",
        currency: monthlyRecurringMinor ? subscription.currency : null,
        startedAt: subscription.providerCreatedAt,
        nextRenewalAt: null,
        paidInvoiceCount: transactionRows.filter((row) =>
          isSettledGhlPayment(row.status),
        ).length,
        paidToDateByCurrency: Object.fromEntries(
          Object.entries(paidToDateByCurrency).map(([currency, amount]) => [
            currency,
            amount.toString(),
          ]),
        ),
      };
    });
    const ghlOneTime = ghlOneTimeTransactions
      .filter((transaction) => isSettledGhlPayment(transaction.status))
      .flatMap((transaction) => {
        const net = transaction.amount?.sub(
          transaction.amountRefunded ?? new Prisma.Decimal(0),
        ) ?? null;
        const priceMinor = providerMajorToMinor(net, transaction.currency);
        if (!priceMinor || !transaction.currency) return [];
        const corrected = correctedService(
          "ghl_transaction",
          transaction.ghlTransactionId,
        );
        return [{
          type: "one_time" as const,
          id: transaction.id,
          provider: "ghl_payments",
          providerId: transaction.ghlTransactionId,
          creditSourceType: "ghl_transaction",
          creditSourceId: transaction.ghlTransactionId,
          account: {
            id: transaction.contactId ?? transaction.id,
            name: transaction.contactName ?? "GHL contact",
            email: transaction.contactEmail ?? "",
          },
          business: null,
          ownerRep: ownerForContact(transaction.contactId),
          service: corrected
            ? { id: corrected.service.id, name: corrected.service.name }
            : transaction.entitySourceName
              ? { id: null, name: transaction.entitySourceName }
              : null,
          serviceMappingStatus: corrected
            ? "corrected"
            : "provider_label_unverified",
          reportingCorrection: corrected?.correction ?? null,
          status: transaction.status,
          paused: false,
          cancelAtPeriodEnd: false,
          monthlyRecurringMinor: "0",
          priceMinor,
          currency: transaction.currency.toLowerCase(),
          startedAt: transaction.fulfilledAt ?? transaction.providerCreatedAt,
          nextRenewalAt: null,
          paidInvoiceCount: 1,
          paidToDateByCurrency: {
            [transaction.currency.toLowerCase()]: priceMinor,
          },
        }];
      });

    sendSuccess(
      res,
      {
        scope: scope.repId ? "rep" : "company",
        correctionsEnabled: Boolean(decisions.provider_override_policy),
        serviceOptions: services
          .filter((service) => service.isActive)
          .map((service) => ({ id: service.id, name: service.name })),
        subscriptions: [...subscriptions, ...ghlRecurring],
        oneTime: [...oneTime, ...ghlOneTime],
      },
      "Command deals",
    );
  } catch (error) {
    sendError(res, "Failed to load Command deals", 500, error);
  }
}

async function resolveDealOwnerRepId(
  sourceType: (typeof COMMAND_DEAL_SOURCE_TYPES)[number],
  sourceId: string,
): Promise<{ exists: boolean; repId: string | null }> {
  if (sourceType === "stripe_subscription") {
    const snapshot = await prisma.commandStripeSubscriptionSnapshot.findFirst({
      where: { stripeSubscriptionId: sourceId },
      orderBy: { occurredAt: "desc" },
      select: { businessId: true },
    });
    if (!snapshot) return { exists: false, repId: null };
    const assignment = snapshot.businessId
      ? await prisma.salesCustomerAssignment.findFirst({
          where: { businessId: snapshot.businessId },
          select: {
            salesperson: {
              select: { CommandRepProfile: { select: { id: true } } },
            },
          },
        })
      : null;
    return {
      exists: true,
      repId: assignment?.salesperson.CommandRepProfile?.id ?? null,
    };
  }

  if (sourceType === "legacy_sale") {
    const sale = await prisma.salesEntry.findUnique({
      where: { id: sourceId },
      select: {
        salesperson: {
          select: { CommandRepProfile: { select: { id: true } } },
        },
      },
    });
    return {
      exists: Boolean(sale),
      repId: sale?.salesperson.CommandRepProfile?.id ?? null,
    };
  }

  const payment =
    sourceType === "ghl_subscription"
      ? await prisma.commandGhlPaymentSubscription.findUnique({
          where: { ghlSubscriptionRecordId: sourceId },
          select: { contactId: true },
        })
      : await prisma.commandGhlPaymentTransaction.findUnique({
          where: { ghlTransactionId: sourceId },
          select: { contactId: true },
        });
  if (!payment) return { exists: false, repId: null };
  const opportunity = payment.contactId
    ? await prisma.commandGhlOpportunity.findFirst({
        where: { isActive: true, ghlContactId: payment.contactId },
        orderBy: { providerUpdatedAt: "desc" },
        select: { assignedToGhlId: true },
      })
    : null;
  const rep = opportunity?.assignedToGhlId
    ? await prisma.commandRepProfile.findFirst({
        where: {
          isActive: true,
          ghlUserId: opportunity.assignedToGhlId,
        },
        select: { id: true },
      })
    : null;
  return { exists: true, repId: rep?.id ?? null };
}

export async function updateCommandDealService(
  req: Request,
  res: Response,
): Promise<void> {
  const sourceTypeValue = req.params.sourceType;
  if (
    !COMMAND_DEAL_SOURCE_TYPES.includes(
      sourceTypeValue as (typeof COMMAND_DEAL_SOURCE_TYPES)[number],
    )
  ) {
    sendError(res, "Unsupported deal source type", 400);
    return;
  }
  const sourceType =
    sourceTypeValue as (typeof COMMAND_DEAL_SOURCE_TYPES)[number];
  const sourceId = req.params.sourceId;
  if (!sourceId) {
    sendError(res, "Deal source ID is required", 400);
    return;
  }
  const parsed = COMMAND_DEAL_SERVICE_CORRECTION_INPUT.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "Invalid deal service correction", 400, parsed.error);
    return;
  }
  if (!req.authUserId) {
    sendError(res, "Authentication required", 401);
    return;
  }

  try {
    const [scope, owner, service, decisions] = await Promise.all([
      resolveRepUserScope(req),
      resolveDealOwnerRepId(sourceType, sourceId),
      prisma.commandService.findFirst({
        where: { id: parsed.data.serviceId, isActive: true },
        select: { id: true, name: true },
      }),
      resolveApprovedCommandDecisions(new Date()),
    ]);
    if (!scope.allowed) {
      sendError(res, scope.message, scope.status);
      return;
    }
    if (!owner.exists) {
      sendError(res, "Deal not found", 404);
      return;
    }
    if (scope.repId && owner.repId !== scope.repId) {
      sendError(res, "Forbidden rep scope", 403);
      return;
    }
    if (!service) {
      sendError(res, "Service not found", 404);
      return;
    }
    if (!decisions.provider_override_policy) {
      sendError(
        res,
        "Provider correction policy must be approved in Settings before mapping a deal service",
        409,
      );
      return;
    }

    const prior = await prisma.commandDataOverride.findFirst({
      where: {
        entityType: sourceType,
        entityId: sourceId,
        field: "serviceId",
        status: "approved",
      },
      orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
    });
    const now = new Date();
    const correction = await prisma.$transaction(async (tx) => {
      const created = await tx.commandDataOverride.create({
        data: {
          provider: sourceType.startsWith("stripe_")
            ? "stripe"
            : sourceType.startsWith("ghl_")
              ? "ghl"
              : "legacy",
          entityType: sourceType,
          entityId: sourceId,
          field: "serviceId",
          value: service.id,
          reason: parsed.data.reason,
          effectiveAt: now,
          approvedByUserId: req.authUserId!,
          createdByUserId: req.authUserId!,
        },
      });
      await tx.adminAuditLog.create({
        data: {
          adminUserId: req.authUserId!,
          action: "command.deal_service.correct",
          targetType: sourceType,
          targetId: sourceId,
          before: {
            serviceId:
              typeof prior?.value === "string" ? prior.value : null,
          },
          after: { serviceId: service.id, serviceName: service.name },
          details: {
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
        sourceType,
        sourceId,
        service,
        effectiveAt: correction.effectiveAt,
        writesBackToProvider: false,
      },
      "Deal service mapping corrected",
    );
  } catch (error) {
    sendError(res, "Failed to correct deal service mapping", 500, error);
  }
}
