import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import {
  calculateDealCommissionLines,
  summarizeRepCommission,
  type CalculatedCommissionLine,
  type CommissionDeal,
  type CommissionPolicy,
} from "./commission-engine";
import { currencyExponent, majorToMinorExact } from "./money";
import { resolveApprovedCommandDecisions } from "./decision.service";
import { commandMonthRange } from "./toronto-period";

type DecisionValue = Record<string, unknown>;
type ServiceWithRates = Prisma.CommandServiceGetPayload<{
  include: { rateVersions: true };
}>;

type CommissionBlocker = {
  code: string;
  sourceType?: string;
  sourceId?: string;
  message: string;
};

type DealSeed = Omit<CommissionDeal, "repId" | "creditShare" | "heldMinorToRelease" | "rate"> & {
  ownerRepId: string | null;
};

type ApprovedOverride = Prisma.CommandDataOverrideGetPayload<Record<string, never>>;

export class CommandCommissionBlockedError extends Error {
  constructor(public readonly blockers: CommissionBlocker[]) {
    super("Commission calculation is blocked by incomplete configuration or mappings");
  }
}

function decisionValue(
  decisions: Awaited<ReturnType<typeof resolveApprovedCommandDecisions>>,
  key: string,
): DecisionValue | null {
  const value = decisions[key]?.value;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as DecisionValue)
    : null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function customFieldValue(raw: Prisma.JsonValue | null, fieldId: string): string | null {
  if (!raw) return null;
  if (!Array.isArray(raw) && typeof raw === "object") {
    const direct = raw[fieldId];
    return typeof direct === "string" ? direct : null;
  }
  if (!Array.isArray(raw)) return null;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = item.id ?? item.fieldId ?? item.key;
    if (id !== fieldId) continue;
    const value = item.field_value ?? item.value ?? item.fieldValue;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
  }
  return null;
}

function matchExactlyOneService(
  services: readonly ServiceWithRates[],
  predicate: (service: ServiceWithRates) => boolean,
): ServiceWithRates | null {
  const matches = services.filter(predicate);
  return matches.length === 1 ? matches[0]! : null;
}

function approvedRate(service: ServiceWithRates, startedAt: Date) {
  return service.rateVersions
    .filter(
      (rate) =>
        rate.status === "approved" &&
        rate.approvedAt !== null &&
        rate.effectiveFrom <= startedAt &&
        (rate.effectiveTo === null || rate.effectiveTo > startedAt),
    )
    .sort((left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime())[0] ?? null;
}

function convertMinor(input: {
  amount: Prisma.Decimal;
  sourceCurrency: string;
  targetCurrency: string;
  rate: Prisma.Decimal;
}): Prisma.Decimal {
  const sourceFactor = new Prisma.Decimal(10).pow(currencyExponent(input.sourceCurrency));
  const targetFactor = new Prisma.Decimal(10).pow(currencyExponent(input.targetCurrency));
  return input.amount
    .div(sourceFactor)
    .mul(input.rate)
    .mul(targetFactor)
    .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
}

function settledGhlStatus(status: string): boolean {
  return ["succeeded", "success", "paid", "completed"].includes(normalize(status));
}

function inactiveSubscriptionStatus(status: string): boolean {
  return ["canceled", "cancelled", "expired", "terminated"].includes(normalize(status));
}

function pastDueStatus(status: string): boolean {
  return ["past_due", "pastdue", "unpaid", "failed"].includes(normalize(status));
}

async function discoverDealSeeds(input: {
  periodStart: Date;
  periodEnd: Date;
  services: ServiceWithRates[];
  attribution: DecisionValue;
  overrides: ApprovedOverride[];
}): Promise<{ seeds: DealSeed[]; blockers: CommissionBlocker[]; warnings: string[] }> {
  const blockers: CommissionBlocker[] = [];
  const warnings: string[] = [];
  const seeds: DealSeed[] = [];
  const overrideValue = (entityType: string, entityId: string, field: string) =>
    input.overrides.find(
      (override) =>
        override.entityType === entityType &&
        override.entityId === entityId &&
        override.field === field,
    )?.value;
  const correctedSeed = (seed: DealSeed): DealSeed => {
    const value = (field: string) => overrideValue(seed.sourceType, seed.sourceId, field);
    const amount = value("amountMinor");
    const currency = value("currency");
    const startedAt = value("startedAt");
    const canceledAt = value("canceledAt");
    const pastDue = value("isPastDueInPeriod");
    const adjustment = input.overrides.find(
      (override) =>
        override.entityType === seed.sourceType &&
        override.entityId === seed.sourceId &&
        override.field === "commissionAdjustmentMinor" &&
        override.effectiveAt >= input.periodStart &&
        override.effectiveAt < input.periodEnd,
    )?.value;
    return {
      ...seed,
      amountMinor:
        typeof amount === "string" ? new Prisma.Decimal(amount) : seed.amountMinor,
      currency: typeof currency === "string" ? normalize(currency) : seed.currency,
      startedAt:
        typeof startedAt === "string" ? new Date(startedAt) : seed.startedAt,
      canceledAt:
        canceledAt === null
          ? null
          : typeof canceledAt === "string"
            ? new Date(canceledAt)
            : seed.canceledAt,
      isPastDueInPeriod:
        typeof pastDue === "boolean" ? pastDue : seed.isPastDueInPeriod,
      adjustmentMinor:
        typeof adjustment === "string"
          ? new Prisma.Decimal(adjustment)
          : undefined,
    };
  };
  const [stripeEvents, accounts, assignments, reps, ghlSubscriptions, ghlTransactions, ghlContacts, ghlOpportunities, salesEntries] =
    await Promise.all([
      prisma.commandStripeSubscriptionEvent.findMany({
        where: { occurredAt: { lt: input.periodEnd } },
        orderBy: [{ stripeSubscriptionId: "asc" }, { occurredAt: "asc" }],
      }),
      prisma.commandAccount.findMany({ select: { stripeCustomerId: true, ownerRepId: true } }),
      prisma.salesCustomerAssignment.findMany({ select: { businessId: true, salespersonId: true } }),
      prisma.commandRepProfile.findMany({
        select: { id: true, userId: true, ghlUserId: true, endDate: true, isActive: true },
      }),
      prisma.commandGhlPaymentSubscription.findMany({
        where: { isActive: true, providerCreatedAt: { lt: input.periodEnd } },
      }),
      prisma.commandGhlPaymentTransaction.findMany({
        where: {
          isActive: true,
          fulfilledAt: { gte: input.periodStart, lt: input.periodEnd },
        },
      }),
      prisma.commandGhlContact.findMany({
        where: { isActive: true },
        select: { ghlContactId: true, customFields: true },
      }),
      prisma.commandGhlOpportunity.findMany({
        where: { isActive: true, ghlContactId: { not: null } },
        orderBy: [{ providerUpdatedAt: "desc" }, { lastActionAt: "desc" }],
      }),
      prisma.salesEntry.findMany({
        where: { soldAt: { gte: input.periodStart, lt: input.periodEnd } },
      }),
    ]);

  const repByUserId = new Map(reps.map((rep) => [rep.userId, rep]));
  const repByGhlId = new Map(
    reps.flatMap((rep) => (rep.ghlUserId ? [[rep.ghlUserId, rep] as const] : [])),
  );
  const ownerByStripeCustomer = new Map(
    accounts.flatMap((account) =>
      account.stripeCustomerId
        ? [[account.stripeCustomerId, account.ownerRepId] as const]
        : [],
    ),
  );
  const ownerByBusiness = new Map(
    assignments.map((assignment) => [
      assignment.businessId,
      repByUserId.get(assignment.salespersonId)?.id ?? null,
    ]),
  );
  const eventsBySubscription = new Map<string, typeof stripeEvents>();
  for (const event of stripeEvents) {
    const current = eventsBySubscription.get(event.stripeSubscriptionId) ?? [];
    current.push(event);
    eventsBySubscription.set(event.stripeSubscriptionId, current);
  }
  for (const [sourceId, events] of eventsBySubscription) {
    const first = events[0];
    const latest = events.at(-1);
    const commercial = [...events]
      .reverse()
      .find((event) => event.monthlyRecurringMinor.gt(0) && event.currency);
    if (!first || !latest || !commercial || !commercial.currency) continue;
    const serviceOverride = overrideValue("stripe_subscription", sourceId, "serviceId");
    const service =
      typeof serviceOverride === "string"
        ? (input.services.find((candidate) => candidate.id === serviceOverride) ?? null)
        : matchExactlyOneService(input.services, (candidate) =>
            candidate.stripePriceIds.some((priceId) =>
              commercial.stripePriceIds.includes(priceId),
            ),
          );
    if (!service) {
      blockers.push({
        code: "stripe_service_mapping",
        sourceType: "stripe_subscription",
        sourceId,
        message: "Stripe subscription must map to exactly one service",
      });
      continue;
    }
    const ownerOverride = overrideValue("stripe_subscription", sourceId, "ownerRepId");
    const ownerRepId =
      (typeof ownerOverride === "string" ? ownerOverride : null) ??
      (latest.stripeCustomerId
        ? ownerByStripeCustomer.get(latest.stripeCustomerId)
        : null) ??
      (latest.businessId ? ownerByBusiness.get(latest.businessId) : null) ??
      null;
    if (!ownerRepId) {
      blockers.push({
        code: "stripe_rep_mapping",
        sourceType: "stripe_subscription",
        sourceId,
        message: "Stripe subscription does not have one mapped owner rep",
      });
      continue;
    }
    const rep = reps.find((candidate) => candidate.id === ownerRepId);
    const canceledEvent = [...events]
      .reverse()
      .find((event) => inactiveSubscriptionStatus(event.status));
    seeds.push(correctedSeed({
      sourceType: "stripe_subscription",
      sourceId,
      serviceId: service.id,
      ownerRepId,
      amountMinor: commercial.monthlyRecurringMinor,
      currency: commercial.currency,
      kind: "subscription",
      startedAt: first.occurredAt,
      canceledAt: canceledEvent?.occurredAt ?? null,
      repDepartedAt: rep?.endDate ?? null,
      isPastDueInPeriod: pastDueStatus(latest.status),
    }));
  }

  const knownStripeSubscriptionIds = new Set(eventsBySubscription.keys());
  const contactById = new Map(ghlContacts.map((contact) => [contact.ghlContactId, contact]));
  const opportunityByContact = new Map<string, (typeof ghlOpportunities)[number]>();
  for (const opportunity of ghlOpportunities) {
    if (opportunity.ghlContactId && !opportunityByContact.has(opportunity.ghlContactId)) {
      opportunityByContact.set(opportunity.ghlContactId, opportunity);
    }
  }
  const attributionMethod = input.attribution.method;
  const customFieldId =
    typeof input.attribution.customFieldId === "string"
      ? input.attribution.customFieldId
      : null;
  const serviceForGhlContact = (contactId: string | null) => {
    if (!contactId) return null;
    const opportunity = opportunityByContact.get(contactId);
    if (attributionMethod === "pipeline") {
      return opportunity
        ? matchExactlyOneService(input.services, (service) =>
            service.ghlPipelineIds.includes(opportunity.pipelineId),
          )
        : null;
    }
    if (!customFieldId) return null;
    const value = customFieldValue(contactById.get(contactId)?.customFields ?? null, customFieldId);
    if (!value) return null;
    const normalizedValue = normalize(value);
    return matchExactlyOneService(input.services, (service) =>
      service.ghlCustomFieldValues.some(
        (candidate) => normalize(candidate) === normalizedValue,
      ),
    );
  };
  const ownerForGhlContact = (contactId: string | null) => {
    const owner = contactId ? opportunityByContact.get(contactId)?.assignedToGhlId : null;
    return owner ? (repByGhlId.get(owner) ?? null) : null;
  };

  for (const subscription of ghlSubscriptions) {
    if (
      subscription.providerSubscriptionId &&
      knownStripeSubscriptionIds.has(subscription.providerSubscriptionId)
    ) {
      continue;
    }
    if (!subscription.amount || !subscription.currency || !subscription.providerCreatedAt) continue;
    const serviceOverride = overrideValue(
      "ghl_subscription",
      subscription.ghlSubscriptionRecordId,
      "serviceId",
    );
    const ownerOverride = overrideValue(
      "ghl_subscription",
      subscription.ghlSubscriptionRecordId,
      "ownerRepId",
    );
    const service =
      typeof serviceOverride === "string"
        ? (input.services.find((candidate) => candidate.id === serviceOverride) ?? null)
        : serviceForGhlContact(subscription.contactId);
    const rep =
      typeof ownerOverride === "string"
        ? (reps.find((candidate) => candidate.id === ownerOverride) ?? null)
        : ownerForGhlContact(subscription.contactId);
    if (!service || !rep) {
      blockers.push({
        code: !service ? "ghl_service_mapping" : "ghl_rep_mapping",
        sourceType: "ghl_subscription",
        sourceId: subscription.ghlSubscriptionRecordId,
        message: !service
          ? "GHL subscription must map to exactly one service"
          : "GHL subscription does not have one mapped owner rep",
      });
      continue;
    }
    seeds.push(correctedSeed({
      sourceType: "ghl_subscription",
      sourceId: subscription.ghlSubscriptionRecordId,
      serviceId: service.id,
      ownerRepId: rep.id,
      amountMinor: majorToMinorExact(subscription.amount, subscription.currency),
      currency: subscription.currency,
      kind: "subscription",
      startedAt: subscription.providerCreatedAt,
      canceledAt: inactiveSubscriptionStatus(subscription.status)
        ? subscription.providerUpdatedAt
        : null,
      repDepartedAt: rep.endDate,
      isPastDueInPeriod: pastDueStatus(subscription.status),
    }));
  }

  for (const transaction of ghlTransactions) {
    if (
      !settledGhlStatus(transaction.status) ||
      !transaction.amount ||
      !transaction.currency ||
      !transaction.fulfilledAt ||
      (transaction.providerSubscriptionId &&
        knownStripeSubscriptionIds.has(transaction.providerSubscriptionId))
    ) {
      continue;
    }
    if (transaction.providerSubscriptionId) continue;
    const serviceOverride = overrideValue(
      "ghl_transaction",
      transaction.ghlTransactionId,
      "serviceId",
    );
    const ownerOverride = overrideValue(
      "ghl_transaction",
      transaction.ghlTransactionId,
      "ownerRepId",
    );
    const service =
      typeof serviceOverride === "string"
        ? (input.services.find((candidate) => candidate.id === serviceOverride) ?? null)
        : serviceForGhlContact(transaction.contactId);
    const rep =
      typeof ownerOverride === "string"
        ? (reps.find((candidate) => candidate.id === ownerOverride) ?? null)
        : ownerForGhlContact(transaction.contactId);
    if (!service || !rep) {
      blockers.push({
        code: !service ? "ghl_service_mapping" : "ghl_rep_mapping",
        sourceType: "ghl_transaction",
        sourceId: transaction.ghlTransactionId,
        message: !service
          ? "GHL transaction must map to exactly one service"
          : "GHL transaction does not have one mapped owner rep",
      });
      continue;
    }
    const netMajor = transaction.amount.sub(transaction.amountRefunded ?? 0);
    if (netMajor.lte(0)) continue;
    seeds.push(correctedSeed({
      sourceType: "ghl_transaction",
      sourceId: transaction.ghlTransactionId,
      serviceId: service.id,
      ownerRepId: rep.id,
      amountMinor: majorToMinorExact(netMajor, transaction.currency),
      currency: transaction.currency,
      kind: "one_time",
      startedAt: transaction.fulfilledAt,
      canceledAt: null,
      repDepartedAt: rep.endDate,
      isPastDueInPeriod: false,
    }));
  }

  for (const sale of salesEntries) {
    const serviceOverride = overrideValue("legacy_sale", sale.id, "serviceId");
    const ownerOverride = overrideValue("legacy_sale", sale.id, "ownerRepId");
    const service =
      typeof serviceOverride === "string"
        ? (input.services.find((candidate) => candidate.id === serviceOverride) ?? null)
        : matchExactlyOneService(
            input.services,
            (candidate) =>
              normalize(candidate.key) === normalize(sale.itemSold) ||
              normalize(candidate.name) === normalize(sale.itemSold),
          );
    const rep =
      typeof ownerOverride === "string"
        ? reps.find((candidate) => candidate.id === ownerOverride)
        : repByUserId.get(sale.salespersonId);
    if (!service || !rep) {
      blockers.push({
        code: !service ? "legacy_service_mapping" : "legacy_rep_mapping",
        sourceType: "legacy_sale",
        sourceId: sale.id,
        message: !service
          ? "Legacy sale item must exactly match one service key or name"
          : "Legacy sale salesperson does not have a rep profile",
      });
      continue;
    }
    seeds.push(correctedSeed({
      sourceType: "legacy_sale",
      sourceId: sale.id,
      serviceId: service.id,
      ownerRepId: rep.id,
      amountMinor: new Prisma.Decimal(sale.amountCents),
      currency: sale.currency,
      kind: "one_time",
      startedAt: sale.soldAt,
      canceledAt: null,
      repDepartedAt: rep.endDate,
      isPastDueInPeriod: false,
    }));
  }

  warnings.push(
    "GHL assignment and cancellation history is authoritative only from the first successful Command sync forward.",
  );
  return { seeds, blockers, warnings };
}

export async function calculateAndPersistCommissionRun(input: {
  periodMonth: string;
  actorUserId: string;
  ipAddress?: string;
}) {
  const period = commandMonthRange(input.periodMonth);
  const asOf = new Date(Math.min(Date.now(), period.end.getTime() - 1));
  const [decisions, services, reps, credits, overrides, priorLines, priorSnapshots, existingRun] =
    await Promise.all([
      resolveApprovedCommandDecisions(asOf),
      prisma.commandService.findMany({
        include: { rateVersions: true },
      }),
      prisma.commandRepProfile.findMany({
        where: { startDate: { lt: period.end } },
        orderBy: { name: "asc" },
      }),
      prisma.commandDealCredit.findMany({
        where: {
          status: "approved",
          effectiveFrom: { lt: period.end },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.start } }],
        },
      }),
      prisma.commandDataOverride.findMany({
        where: {
          status: "approved",
          effectiveAt: { lte: asOf },
          OR: [{ expiresAt: null }, { expiresAt: { gt: asOf } }],
        },
        orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }],
      }),
      prisma.commandCommissionLine.findMany({
        where: {
          postedPeriodMonth: { lt: input.periodMonth },
          run: { status: "locked" },
        },
      }),
      prisma.commandCommissionRepSnapshot.findMany({
        where: {
          run: { status: "locked", periodMonth: { lt: input.periodMonth } },
        },
        include: { run: { select: { periodMonth: true } } },
        orderBy: { run: { periodMonth: "desc" } },
      }),
      prisma.commandCommissionRun.findUnique({ where: { periodMonth: input.periodMonth } }),
    ]);
  if (existingRun?.status === "locked") {
    throw new CommandCommissionBlockedError([
      { code: "locked_run", message: "A locked commission run cannot be recalculated" },
    ]);
  }
  const required = [
    "clawback_policy",
    "draw_policy",
    "ghl_service_attribution",
    "departing_rep_residuals",
    "deal_credit_policy",
    "currency_policy",
    "past_due_release_policy",
    "provider_override_policy",
  ];
  const blockers: CommissionBlocker[] = required
    .filter((key) => !decisions[key])
    .map((key) => ({ code: "missing_decision", message: `Approved ${key} decision is required` }));
  const attribution = decisionValue(decisions, "ghl_service_attribution");
  const draw = decisionValue(decisions, "draw_policy");
  const clawback = decisionValue(decisions, "clawback_policy");
  const departure = decisionValue(decisions, "departing_rep_residuals");
  const creditPolicy = decisionValue(decisions, "deal_credit_policy");
  const currencyPolicy = decisionValue(decisions, "currency_policy");
  if (!attribution || !draw || !clawback || !departure || !creditPolicy || !currencyPolicy) {
    throw new CommandCommissionBlockedError(blockers);
  }
  const discovery = await discoverDealSeeds({
    periodStart: period.start,
    periodEnd: period.end,
    services,
    attribution,
    overrides,
  });
  blockers.push(...discovery.blockers);
  const creditsBySource = new Map<string, typeof credits>();
  for (const credit of credits) {
    const key = `${credit.sourceType}:${credit.sourceId}`;
    const current = creditsBySource.get(key) ?? [];
    current.push(credit);
    creditsBySource.set(key, current);
  }
  const outstandingHeld = new Map<string, Prisma.Decimal>();
  for (const line of priorLines) {
    const key = `${line.sourceType}:${line.sourceId}:${line.repId}:${line.serviceId ?? ""}:${line.currency}`;
    const current = outstandingHeld.get(key) ?? new Prisma.Decimal(0);
    if (line.status === "held") outstandingHeld.set(key, current.add(line.amountMinor));
    if (line.kind === "release") outstandingHeld.set(key, current.sub(line.amountMinor));
  }
  const baseCurrency =
    currencyPolicy.mode === "base_currency" && typeof currencyPolicy.baseCurrency === "string"
      ? normalize(currencyPolicy.baseCurrency)
      : null;
  const fxRates =
    currencyPolicy.fxRates && typeof currencyPolicy.fxRates === "object"
      ? (currencyPolicy.fxRates as Record<string, unknown>)
      : {};
  const convert = (amount: Prisma.Decimal, sourceCurrency: string) => {
    const source = normalize(sourceCurrency);
    if (!baseCurrency || source === baseCurrency) return { amount, currency: baseCurrency ?? source };
    const rawRate = fxRates[source];
    if (typeof rawRate !== "string") {
      blockers.push({ code: "missing_fx_rate", message: `Approved FX rate for ${source.toUpperCase()} is required` });
      return null;
    }
    return {
      amount: convertMinor({ amount, sourceCurrency: source, targetCurrency: baseCurrency, rate: new Prisma.Decimal(rawRate) }),
      currency: baseCurrency,
    };
  };
  const calculated: CalculatedCommissionLine[] = [];
  const policy: CommissionPolicy = {
    periodMonth: input.periodMonth,
    periodStart: period.start,
    periodEnd: period.end,
    clawbackWindowDays: Number(clawback.windowDays) as 0 | 30 | 60 | 90,
    departingRepResiduals: String(departure.policy) as CommissionPolicy["departingRepResiduals"],
  };
  for (const seed of discovery.seeds) {
    const service = services.find((candidate) => candidate.id === seed.serviceId)!;
    const rate = approvedRate(service, seed.startedAt);
    if (!rate) {
      blockers.push({
        code: "missing_effective_rate",
        sourceType: seed.sourceType,
        sourceId: seed.sourceId,
        message: `No approved ${service.name} rate covers the deal start date`,
      });
      continue;
    }
    const explicitCredits = creditsBySource.get(`${seed.sourceType}:${seed.sourceId}`) ?? [];
    const allocations =
      creditPolicy.policy === "split_credit"
        ? explicitCredits.map((credit) => ({ repId: credit.repId, creditShare: credit.creditShare }))
        : seed.ownerRepId
          ? [{ repId: seed.ownerRepId, creditShare: new Prisma.Decimal(1) }]
          : [];
    if (
      allocations.length === 0 ||
      !allocations.reduce((total, allocation) => total.add(allocation.creditShare), new Prisma.Decimal(0)).eq(1)
    ) {
      blockers.push({
        code: "invalid_deal_credit",
        sourceType: seed.sourceType,
        sourceId: seed.sourceId,
        message: "Approved deal credit must allocate exactly 100%",
      });
      continue;
    }
    const converted = convert(seed.amountMinor, seed.currency);
    if (!converted) continue;
    const convertedAdjustment = seed.adjustmentMinor
      ? convert(seed.adjustmentMinor, seed.currency)
      : null;
    if (seed.adjustmentMinor && !convertedAdjustment) continue;
    for (const allocation of allocations) {
      const heldKey = `${seed.sourceType}:${seed.sourceId}:${allocation.repId}:${seed.serviceId}:${converted.currency}`;
      const heldMinorToRelease = Prisma.Decimal.max(
        outstandingHeld.get(heldKey) ?? new Prisma.Decimal(0),
        new Prisma.Decimal(0),
      );
      calculated.push(
        ...calculateDealCommissionLines(
          {
            ...seed,
            amountMinor: converted.amount,
            currency: converted.currency,
            adjustmentMinor: convertedAdjustment?.amount,
            repId: allocation.repId,
            creditShare: allocation.creditShare,
            heldMinorToRelease,
            rate: {
              id: rate.id,
              firstSaleRate: rate.firstSaleRate,
              recurringRate: rate.recurringRate,
            },
          },
          policy,
        ),
      );
    }
  }
  if (blockers.length > 0) throw new CommandCommissionBlockedError(blockers);

  const openingByRepCurrency = new Map<string, Prisma.Decimal>();
  for (const snapshot of priorSnapshots) {
    const key = `${snapshot.repId}:${snapshot.currency}`;
    if (!openingByRepCurrency.has(key)) {
      openingByRepCurrency.set(key, snapshot.closingDrawBalanceMinor);
    }
  }
  const linesByRepCurrency = new Map<string, CalculatedCommissionLine[]>();
  for (const line of calculated) {
    const key = `${line.repId}:${line.currency}`;
    const current = linesByRepCurrency.get(key) ?? [];
    current.push(line);
    linesByRepCurrency.set(key, current);
  }
  for (const rep of reps) {
    if (!rep.basePay || !rep.currency) continue;
    const drawMinor = majorToMinorExact(rep.basePay, rep.currency);
    const converted = convert(drawMinor, rep.currency);
    if (!converted) continue;
    const key = `${rep.id}:${converted.currency}`;
    if (!linesByRepCurrency.has(key)) linesByRepCurrency.set(key, []);
  }
  if (blockers.length > 0) throw new CommandCommissionBlockedError(blockers);

  const snapshots = [...linesByRepCurrency.entries()].map(([key, lines]) => {
    const [repId, currency] = key.split(":") as [string, string];
    const rep = reps.find((candidate) => candidate.id === repId)!;
    let baseDrawMinor = new Prisma.Decimal(0);
    if (rep.basePay && rep.currency) {
      const original = majorToMinorExact(rep.basePay, rep.currency);
      const converted = convert(original, rep.currency);
      if (converted?.currency === currency) baseDrawMinor = converted.amount;
    }
    const serviceRates = services
      .filter((service) => service.listPriceMinor && service.currency)
      .flatMap((service) => {
        const rate = approvedRate(service, asOf);
        if (!rate || !service.listPriceMinor || !service.currency) return [];
        const converted = convert(service.listPriceMinor, service.currency);
        return converted?.currency === currency
          ? [converted.amount.mul(rate.firstSaleRate)]
          : [];
      });
    const perClose = serviceRates.length === 1 ? serviceRates[0]! : null;
    return {
      repId,
      currency,
      ...summarizeRepCommission({
        lines,
        baseDrawMinor,
        openingDrawBalanceMinor:
          openingByRepCurrency.get(key) ?? new Prisma.Decimal(0),
        drawPolicy: String(draw.type) as "recoverable" | "non_recoverable",
        firstSaleCommissionPerCloseMinor: perClose,
      }),
    };
  });
  const configurationSnapshot = {
    decisions: Object.fromEntries(
      Object.entries(decisions).map(([key, decision]) => [key, {
        id: decision.id,
        version: decision.version,
        value: decision.value,
        effectiveAt: decision.effectiveAt.toISOString(),
      }]),
    ),
    rateVersionIds: [...new Set(calculated.map((line) => line.rateVersionId))],
    overrideIds: overrides.map((override) => override.id),
    warnings: discovery.warnings,
  };
  const now = new Date();
  const run = await prisma.$transaction(async (tx) => {
    const persisted = existingRun
      ? await tx.commandCommissionRun.update({
          where: { id: existingRun.id },
          data: {
            configurationSnapshot,
            sourceFactsThrough: now,
            calculatedAt: now,
            calculatedByUserId: input.actorUserId,
          },
        })
      : await tx.commandCommissionRun.create({
          data: {
            periodMonth: input.periodMonth,
            configurationSnapshot,
            sourceFactsThrough: now,
            calculatedAt: now,
            calculatedByUserId: input.actorUserId,
          },
        });
    await tx.commandCommissionLine.deleteMany({ where: { runId: persisted.id } });
    await tx.commandCommissionRepSnapshot.deleteMany({ where: { runId: persisted.id } });
    if (calculated.length > 0) {
      await tx.commandCommissionLine.createMany({
        data: calculated.map((line) => ({
          ...line,
          runId: persisted.id,
          metadata: line.metadata as Prisma.InputJsonValue,
        })),
      });
    }
    if (snapshots.length > 0) {
      await tx.commandCommissionRepSnapshot.createMany({
        data: snapshots.map((snapshot) => ({
          runId: persisted.id,
          repId: snapshot.repId,
          currency: snapshot.currency,
          firstSaleMinor: snapshot.firstSaleMinor,
          recurringMinor: snapshot.recurringMinor,
          clawbackMinor: snapshot.clawbackMinor,
          heldMinor: snapshot.heldMinor,
          releasedMinor: snapshot.releasedMinor,
          adjustmentMinor: snapshot.adjustmentMinor,
          earnedMinor: snapshot.earnedMinor,
          baseDrawMinor: snapshot.baseDrawMinor,
          drawDifferentialMinor: snapshot.drawDifferentialMinor,
          openingDrawBalanceMinor: snapshot.openingDrawBalanceMinor,
          closingDrawBalanceMinor: snapshot.closingDrawBalanceMinor,
          cashPayableMinor: snapshot.cashPayableMinor,
          closesNeeded: snapshot.closesNeeded,
        })),
      });
    }
    await tx.adminAuditLog.create({
      data: {
        adminUserId: input.actorUserId,
        action: "command.commission.calculate",
        targetType: "command_commission_run",
        targetId: persisted.id,
        after: {
          periodMonth: input.periodMonth,
          status: persisted.status,
          lineCount: calculated.length,
          repSnapshotCount: snapshots.length,
          sourceFactsThrough: now,
        },
        ipAddress: input.ipAddress,
      },
    });
    return persisted;
  });
  return { run, lineCount: calculated.length, snapshots, warnings: discovery.warnings };
}
