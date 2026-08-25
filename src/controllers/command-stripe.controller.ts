import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import { inngest } from "../inngest/admin-client";
import {
  commandDayForDate,
  commandDayRange,
  commandMonthsEndingAt,
  commandMonthRange,
  currentCommandMonth,
} from "../command/toronto-period";
import {
  buildStripeLifecycle,
  SUBSCRIPTION_CREATED_EVENT,
  SUBSCRIPTION_DELETED_EVENT,
} from "../command/stripe-lifecycle";
import { buildPlanMix } from "../command/plan-mix";
import {
  commandPaginationResult,
  parseCommandPagination,
} from "../command/pagination";
import { aggregateGhlRevenue } from "../command/ghl-payment-metrics";
import { mergeMajorCurrencyBucketsIntoMinor } from "../command/money";
import { aggregateCommandUnitEconomics } from "../command/unit-economics";
import { activityRatios } from "../command/activity-metrics";
import { getCommandStripeMonthlyMovement } from "../command/stripe-monthly-rollup.service";
import {
  aggregateTrailingRevenueChurn,
  calculateGrowthEconomics,
} from "../command/growth-economics";
import { currencyExponent } from "../command/money";
import { readCommandCache, writeCommandCache } from "../utils/command-cache";
import { isStripeConfigured, stripe } from "../config/stripe.config";
import {
  projectUpliftSubscriptionPlanBilling,
  resolveStripeDiscount,
  type ResolvedStripeDiscount,
  type UpliftSubscriptionPlanBilling,
} from "../command/stripe-discount-metrics";

type UpliftPlanDefinition = {
  priceId: string;
  name: string;
  billingPeriod: string;
  currency: string | null;
  unitAmountMinor: string | null;
};

function configuredUpliftPlanLabels(): Map<string, Omit<UpliftPlanDefinition, "priceId">> {
  const entries: Array<[string | undefined, string, string]> = [
    [process.env.UPLIFT_PLAN_PRICE_ID, "Uplift AI", "Monthly"],
    [process.env.UPLIFT_YEARLY_PRICE_ID, "Uplift AI", "Annual"],
    [
      process.env.UPLIFT_SEO_SOCIAL_PRICE_ID,
      "Uplift AI SEO + Social",
      "Monthly",
    ],
    [
      process.env.UPLIFT_SEO_SOCIAL_YEARLY_PRICE_ID,
      "Uplift AI SEO + Social",
      "Annual",
    ],
  ];
  return new Map(
    entries.flatMap(([priceId, name, billingPeriod]) =>
      priceId
        ? [[priceId, { name, billingPeriod, currency: null, unitAmountMinor: null }] as const]
        : [],
    ),
  );
}

async function getUpliftPlanDefinitions(): Promise<UpliftPlanDefinition[]> {
  const configured = configuredUpliftPlanLabels();
  const [subscriptionPrices, websitePrices] = await Promise.all([
    prisma.subscription.findMany({
      where: { stripePriceId: { not: null } },
      distinct: ["stripePriceId"],
      select: { stripePriceId: true, planName: true },
    }),
    prisma.websiteSubscription.findMany({
      where: { stripePriceId: { not: null } },
      distinct: ["stripePriceId"],
      select: { stripePriceId: true },
    }),
  ]);
  const priceIds = new Set(configured.keys());
  for (const row of subscriptionPrices) {
    if (row.stripePriceId && row.planName?.toLowerCase().includes("uplift")) {
      priceIds.add(row.stripePriceId);
    }
  }
  for (const row of websitePrices) {
    if (row.stripePriceId) priceIds.add(row.stripePriceId);
  }

  return Promise.all(
    [...priceIds].map(async (priceId) => {
      const fallback = configured.get(priceId) ?? {
        name: "Uplift AI legacy plan",
        billingPeriod: "Recurring",
        currency: null,
        unitAmountMinor: null,
      };
      if (!isStripeConfigured) return { priceId, ...fallback };
      try {
        const price = await stripe.prices.retrieve(priceId, {
          expand: ["product"],
        });
        const product = price.product;
        const productName =
          typeof product !== "string" && !("deleted" in product)
            ? product.name
            : fallback.name;
        const interval = price.recurring?.interval;
        return {
          priceId,
          name: productName,
          billingPeriod:
            interval === "year"
              ? "Annual"
              : interval === "month"
                ? "Monthly"
                : fallback.billingPeriod,
          currency: price.currency,
          unitAmountMinor:
            price.unit_amount_decimal != null
              ? String(price.unit_amount_decimal)
              : price.unit_amount === null
                ? null
                : String(price.unit_amount),
        };
      } catch {
        return { priceId, ...fallback };
      }
    }),
  );
}

function stripeObjectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    return value.id;
  }
  return null;
}

function expandedSubscriptionDiscounts(
  subscription: Stripe.Subscription,
): Stripe.Discount[] {
  return [
    ...(subscription.discounts ?? []),
    ...subscription.items.data.flatMap((item) => item.discounts ?? []),
  ].flatMap((entry) =>
    typeof entry === "string" || entry.deleted ? [] : [entry],
  );
}

async function retrieveStripeCoupons(
  ids: ReadonlySet<string>,
): Promise<Map<string, Stripe.Coupon>> {
  const entries = await Promise.all(
    [...ids].map(async (id) => {
      try {
        const coupon = await stripe.coupons.retrieve(id);
        return coupon.deleted ? null : ([id, coupon] as const);
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
}

async function retrieveStripePromotionCodes(
  ids: ReadonlySet<string>,
): Promise<Map<string, Stripe.PromotionCode>> {
  const entries = await Promise.all(
    [...ids].map(async (id) => {
      try {
        return [id, await stripe.promotionCodes.retrieve(id)] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
}

async function loadLiveUpliftSubscriptionBilling(input: {
  subscriptionIds: ReadonlySet<string>;
  upliftPriceIds: ReadonlySet<string>;
}): Promise<{
  bySubscriptionId: Map<string, UpliftSubscriptionPlanBilling[]>;
  missingSubscriptionCount: number;
} | null> {
  if (!isStripeConfigured || input.subscriptionIds.size === 0) return null;
  try {
    const subscriptions = new Map<string, Stripe.Subscription>();
    const statuses = ["active", "trialing", "past_due"] as const;
    await Promise.all(
      statuses.map(async (status) => {
        for await (const subscription of stripe.subscriptions.list({
          status,
          limit: 100,
          expand: ["data.discounts", "data.items.data.discounts"],
        })) {
          if (input.subscriptionIds.has(subscription.id)) {
            subscriptions.set(subscription.id, subscription);
          }
        }
      }),
    );

    const discounts = [...subscriptions.values()].flatMap(
      expandedSubscriptionDiscounts,
    );
    const couponIds = new Set(
      discounts.flatMap((discount) => {
        const id = stripeObjectId(discount.source.coupon);
        return id ? [id] : [];
      }),
    );
    const promotionCodeIds = new Set(
      discounts.flatMap((discount) => {
        const id = stripeObjectId(discount.promotion_code);
        return id ? [id] : [];
      }),
    );
    const [couponsById, promotionCodesById] = await Promise.all([
      retrieveStripeCoupons(couponIds),
      retrieveStripePromotionCodes(promotionCodeIds),
    ]);
    const discountsById = new Map<string, ResolvedStripeDiscount>();
    for (const discount of discounts) {
      const rawCoupon = discount.source.coupon;
      const coupon =
        typeof rawCoupon === "string"
          ? (couponsById.get(rawCoupon) ?? null)
          : rawCoupon && !rawCoupon.deleted
            ? rawCoupon
            : null;
      const rawPromotionCode = discount.promotion_code;
      const promotionCode =
        typeof rawPromotionCode === "string"
          ? (promotionCodesById.get(rawPromotionCode) ?? null)
          : rawPromotionCode;
      const resolved = resolveStripeDiscount({
        discount,
        coupon,
        promotionCode,
      });
      if (resolved) discountsById.set(resolved.id, resolved);
    }

    return {
      bySubscriptionId: new Map(
        [...subscriptions.entries()].map(([subscriptionId, subscription]) => [
          subscriptionId,
          projectUpliftSubscriptionPlanBilling({
            subscription,
            upliftPriceIds: input.upliftPriceIds,
            discountsById,
          }),
        ]),
      ),
      missingSubscriptionCount:
        input.subscriptionIds.size - subscriptions.size,
    };
  } catch (error) {
    console.error(
      "[command-stripe] Could not load live subscription discounts",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function getCommandStripeOverview(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const period = commandMonthRange(currentCommandMonth());
    const { page, pageSize, skip } = parseCommandPagination({
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    const cacheKey = `stripe-overview-v7:${period.month}:${page}:${pageSize}`;
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command Stripe overview");
      return;
    }
    const upliftPlans = await getUpliftPlanDefinitions();
    const upliftPlanByPriceId = new Map(
      upliftPlans.map((plan) => [plan.priceId, plan]),
    );
    const liveWhere: Prisma.CommandStripeSubscriptionSnapshotWhereInput = {
      status: { in: ["trialing", "active", "past_due"] },
    };
    const mrrWhere: Prisma.CommandStripeSubscriptionSnapshotWhereInput = {
      ...liveWhere,
      pauseCollectionBehavior: null,
    };

    const [
      rosterAccountRefs,
      subscriptionCount,
      paidSubscriptionRefs,
      trialingCount,
      pastDueCount,
      pausedCount,
      accountRows,
      mrrGroups,
      paidGroups,
      monthlyPaidGroups,
      monthlyCostGroups,
      monthlyMovements,
      ghlRevenueTransactions,
      knownStripeSubscriptionIds,
      activeReps,
      allAssignments,
      leaderboardSubscriptions,
      wonByGhlUser,
      leaderboardActivity,
    ] = await Promise.all([
      prisma.commandStripeSubscriptionSnapshot.findMany({
        where: { ...liveWhere, stripeCustomerId: { not: null } },
        distinct: ["stripeCustomerId"],
        orderBy: { stripeCustomerId: "asc" },
        skip,
        take: pageSize,
        select: { stripeCustomerId: true },
      }),
      prisma.commandStripeSubscriptionSnapshot.count({ where: liveWhere }),
      prisma.commandStripeInvoice.findMany({
        where: {
          status: "paid",
          paidAt: { not: null },
          stripeSubscriptionId: { not: null },
        },
        distinct: ["stripeSubscriptionId"],
        select: { stripeSubscriptionId: true },
      }),
      prisma.commandStripeSubscriptionSnapshot.count({
        where: { status: "trialing" },
      }),
      prisma.commandStripeSubscriptionSnapshot.count({
        where: { status: "past_due" },
      }),
      prisma.commandStripeSubscriptionSnapshot.count({
        where: {
          ...liveWhere,
          pauseCollectionBehavior: { not: null },
        },
      }),
      prisma.commandStripeSubscriptionSnapshot.findMany({
        where: { ...liveWhere, stripeCustomerId: { not: null } },
        distinct: ["stripeCustomerId"],
        select: { stripeCustomerId: true },
      }),
      prisma.commandStripeSubscriptionSnapshot.groupBy({
        by: ["currency"],
        where: mrrWhere,
        _sum: { monthlyRecurringMinor: true },
      }),
      prisma.commandStripeInvoice.groupBy({
        by: ["currency"],
        where: { status: "paid", paidAt: { not: null } },
        _sum: { amountPaidMinor: true },
      }),
      prisma.commandStripeInvoice.groupBy({
        by: ["currency"],
        where: {
          status: "paid",
          paidAt: { gte: period.start, lt: period.end },
        },
        _sum: { amountPaidMinor: true },
      }),
      prisma.commandCostEntry.groupBy({
        by: ["category", "currency"],
        where: {
          deletedAt: null,
          occurredAt: { gte: period.start, lt: period.end },
        },
        _sum: { amountMinor: true },
      }),
      Promise.all(
        commandMonthsEndingAt(period.month, 3).map((month) =>
          getCommandStripeMonthlyMovement(month),
        ),
      ),
      prisma.commandGhlPaymentTransaction.findMany({
        where: {
          isActive: true,
          fulfilledAt: { gte: period.start, lt: period.end },
        },
        select: {
          amount: true,
          amountRefunded: true,
          currency: true,
          status: true,
          providerSubscriptionId: true,
        },
      }),
      prisma.commandStripeSubscriptionSnapshot.findMany({
        select: { stripeSubscriptionId: true },
      }),
      prisma.commandRepProfile.findMany({
        where: { isActive: true },
        select: { id: true, name: true, userId: true, ghlUserId: true },
        orderBy: { name: "asc" },
      }),
      prisma.salesCustomerAssignment.findMany({
        select: { businessId: true, salespersonId: true },
      }),
      prisma.commandStripeSubscriptionSnapshot.findMany({
        where: mrrWhere,
        select: {
          stripeSubscriptionId: true,
          stripeCustomerId: true,
          businessId: true,
          status: true,
          currency: true,
          monthlyRecurringMinor: true,
          stripePriceIds: true,
        },
      }),
      prisma.commandGhlOpportunity.groupBy({
        by: ["assignedToGhlId"],
        where: {
          isActive: true,
          status: "won",
          assignedToGhlId: { not: null },
          lastStatusChangeAt: { gte: period.start, lt: period.end },
        },
        _count: { _all: true },
      }),
      prisma.commandRepActivity.findMany({
        where: { periodMonth: period.month },
        orderBy: [{ repId: "asc" }, { source: "asc" }],
      }),
    ]);

    const monthlyMovement = monthlyMovements[0]!;
    const trailingRevenueChurn = aggregateTrailingRevenueChurn(monthlyMovements);
    const rosterCustomerIds = rosterAccountRefs.flatMap((row) =>
      row.stripeCustomerId ? [row.stripeCustomerId] : [],
    );
    const roster = await prisma.commandStripeSubscriptionSnapshot.findMany({
      where: {
        ...liveWhere,
        stripeCustomerId: { in: rosterCustomerIds },
      },
      orderBy: [{ stripeCustomerId: "asc" }, { occurredAt: "asc" }],
    });

    const userIds = new Set<string>();
    const businessIds = new Set<string>();
    const rosterSubscriptionIds: string[] = [];
    for (const subscription of roster) {
      if (subscription.userId) userIds.add(subscription.userId);
      if (subscription.businessId) businessIds.add(subscription.businessId);
      rosterSubscriptionIds.push(subscription.stripeSubscriptionId);
    }

    const [
      users,
      businesses,
      invoiceTotals,
      firstEvents,
      createdEvents,
      subscriptionRecords,
      commandAccounts,
    ] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: [...userIds] } },
        select: { id: true, name: true, email: true, phone: true },
      }),
      prisma.business.findMany({
        where: { id: { in: [...businessIds] } },
        select: { id: true, businessName: true, businessPhone: true },
      }),
      prisma.commandStripeInvoice.groupBy({
        by: ["stripeSubscriptionId", "currency"],
        where: {
          status: "paid",
          paidAt: { not: null },
          stripeSubscriptionId: { in: rosterSubscriptionIds },
        },
        _sum: { amountPaidMinor: true },
      }),
      prisma.commandStripeSubscriptionEvent.groupBy({
        by: ["stripeSubscriptionId"],
        where: { stripeSubscriptionId: { in: rosterSubscriptionIds } },
        _min: { occurredAt: true },
      }),
      // The only rows whose occurredAt is when the subscription actually began.
      // The groupBy above spans every row including reconciliation snapshots,
      // which are stamped with the sync run's clock — see stripe-lifecycle.ts.
      prisma.commandStripeSubscriptionEvent.groupBy({
        by: ["stripeSubscriptionId"],
        where: {
          stripeSubscriptionId: { in: rosterSubscriptionIds },
          eventType: SUBSCRIPTION_CREATED_EVENT,
        },
        _min: { occurredAt: true },
      }),
      // Stripe's own start date, kept on our subscription records. Covers
      // subscriptions that predate the webhook wiring, where no created event
      // was ever received.
      prisma.subscription.findMany({
        where: { stripeSubscriptionId: { in: rosterSubscriptionIds } },
        select: { stripeSubscriptionId: true, startDate: true },
      }),
      prisma.commandAccount.findMany({
        where: { stripeCustomerId: { in: rosterCustomerIds } },
        include: { ownerRep: { select: { id: true, name: true } } },
      }),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const businessById = new Map(
      businesses.map((business) => [business.id, business]),
    );
    const repByUserId = new Map(activeReps.map((rep) => [rep.userId, rep]));
    const ownerRepByBusinessId = new Map(
      allAssignments.map((assignment) => {
        const rep = repByUserId.get(assignment.salespersonId);
        return [
          assignment.businessId,
          rep ? { id: rep.id, name: rep.name } : null,
        ];
      }),
    );

    const invoiceTotalsBySubscription = new Map<
      string,
      Map<string, Prisma.Decimal>
    >();
    for (const row of invoiceTotals) {
      if (!row.stripeSubscriptionId) continue;
      const byCurrency =
        invoiceTotalsBySubscription.get(row.stripeSubscriptionId) ?? new Map();
      byCurrency.set(
        row.currency,
        row._sum.amountPaidMinor ?? new Prisma.Decimal(0),
      );
      invoiceTotalsBySubscription.set(row.stripeSubscriptionId, byCurrency);
    }
    const firstEventBySubscription = new Map(
      firstEvents.map((row) => [
        row.stripeSubscriptionId,
        row._min.occurredAt ?? null,
      ]),
    );
    /**
     * When each subscription genuinely started, and where that came from.
     *
     * `firstEventBySubscription` above is the earliest row of any kind, which
     * for anything predating the sync is the moment reconciliation first saw
     * it — not a start date. Sorting a roster by that produces a "newest wins"
     * list where the oldest customer in the company appears to have joined the
     * day the sync was switched on. Preferred order: Stripe's own created
     * event, then the start date on our subscription record, then nothing.
     * Nothing is a real answer here; first-seen is not a substitute for it.
     */
    const createdEventBySubscription = new Map(
      createdEvents.flatMap((row) =>
        row._min.occurredAt
          ? ([[row.stripeSubscriptionId, row._min.occurredAt]] as const)
          : [],
      ),
    );
    const recordStartBySubscription = new Map(
      subscriptionRecords.flatMap((row) =>
        row.stripeSubscriptionId
          ? ([[row.stripeSubscriptionId, row.startDate]] as const)
          : [],
      ),
    );
    const trueStartFor = (
      stripeSubscriptionId: string,
    ): { at: Date; source: "stripe_event" | "subscription_record" } | null => {
      const fromEvent = createdEventBySubscription.get(stripeSubscriptionId);
      if (fromEvent) return { at: fromEvent, source: "stripe_event" };
      const fromRecord = recordStartBySubscription.get(stripeSubscriptionId);
      if (fromRecord) return { at: fromRecord, source: "subscription_record" };
      return null;
    };
    const commandAccountByStripeCustomerId = new Map(
      commandAccounts.flatMap((account) =>
        account.stripeCustomerId
          ? [[account.stripeCustomerId, account] as const]
          : [],
      ),
    );
    const mrrMinorByCurrency = Object.fromEntries(
      mrrGroups.flatMap((row) =>
        row.currency
          ? [[row.currency, row._sum?.monthlyRecurringMinor?.toString() ?? "0"]]
          : [],
      ),
    );
    const paidToDateMinorByCurrency = Object.fromEntries(
      paidGroups.map((row) => [
        row.currency,
        row._sum?.amountPaidMinor?.toString() ?? "0",
      ]),
    );
    const ghlRevenue = aggregateGhlRevenue(
      ghlRevenueTransactions,
      new Set(
        knownStripeSubscriptionIds.map((row) => row.stripeSubscriptionId),
      ),
    );
    const ghlRecurringMajorByCurrency = Object.fromEntries(
      Object.entries(ghlRevenue.byCurrency).map(([currency, values]) => [
        currency,
        values.recurring,
      ]),
    );
    const combinedMrr = mergeMajorCurrencyBucketsIntoMinor({
      minorByCurrency: mrrMinorByCurrency,
      majorByCurrency: ghlRecurringMajorByCurrency,
    });
    const combinedArrRunRateMinorByCurrency = Object.fromEntries(
      Object.entries(combinedMrr.combinedMinorByCurrency).map(
        ([currency, amount]) => [
          currency,
          new Prisma.Decimal(amount).mul(12).toString(),
        ],
      ),
    );
    const stripeMonthlyCollectedMinorByCurrency = Object.fromEntries(
      monthlyPaidGroups.map((row) => [
        row.currency,
        row._sum?.amountPaidMinor?.toString() ?? "0",
      ]),
    );
    const ghlCollectedMajorByCurrency = Object.fromEntries(
      Object.entries(ghlRevenue.byCurrency).map(([currency, values]) => [
        currency,
        values.collected,
      ]),
    );
    const monthlyCollected = mergeMajorCurrencyBucketsIntoMinor({
      minorByCurrency: stripeMonthlyCollectedMinorByCurrency,
      majorByCurrency: ghlCollectedMajorByCurrency,
    });
    const unitEconomicsByCurrency = aggregateCommandUnitEconomics({
      collectedMinorByCurrency: monthlyCollected.combinedMinorByCurrency,
      costs: monthlyCostGroups.map((row) => ({
        category: row.category,
        currency: row.currency,
        amountMinor: row._sum.amountMinor ?? new Prisma.Decimal(0),
      })),
    });
    const [lockedCommissionRun, newStripeEvents, priorStripeCustomers, liveGhlSubscriptions] =
      await Promise.all([
        prisma.commandCommissionRun.findUnique({
          where: { periodMonth: period.month },
          include: { repSnapshots: true },
        }),
        prisma.commandStripeSubscriptionEvent.findMany({
          where: {
            occurredAt: { gte: period.start, lt: period.end },
            stripeCustomerId: { not: null },
            status: { in: ["trialing", "active", "past_due"] },
            pauseCollectionBehavior: null,
          },
          orderBy: { occurredAt: "asc" },
          select: { stripeCustomerId: true, currency: true },
        }),
        prisma.commandStripeSubscriptionEvent.findMany({
          where: { occurredAt: { lt: period.start }, stripeCustomerId: { not: null } },
          distinct: ["stripeCustomerId"],
          select: { stripeCustomerId: true },
        }),
        prisma.commandGhlPaymentSubscription.findMany({
          where: {
            isActive: true,
            status: { notIn: ["canceled", "cancelled", "expired", "terminated"] },
          },
          select: {
            ghlSubscriptionRecordId: true,
            providerSubscriptionId: true,
            contactId: true,
            contactEmail: true,
            currency: true,
            providerCreatedAt: true,
          },
        }),
      ]);
    const priorCustomerIds = new Set(
      priorStripeCustomers.flatMap((row) =>
        row.stripeCustomerId ? [row.stripeCustomerId] : [],
      ),
    );
    const liveAccountKeysByCurrency = new Map<string, Set<string>>();
    const newAccountKeysByCurrency = new Map<string, Set<string>>();
    const addAccount = (
      target: Map<string, Set<string>>,
      currency: string | null,
      accountKey: string | null,
    ) => {
      if (!currency || !accountKey) return;
      const key = currency.toLowerCase();
      const values = target.get(key) ?? new Set<string>();
      values.add(accountKey);
      target.set(key, values);
    };
    for (const subscription of leaderboardSubscriptions) {
      addAccount(
        liveAccountKeysByCurrency,
        subscription.currency,
        subscription.stripeCustomerId,
      );
    }
    for (const event of newStripeEvents) {
      if (event.stripeCustomerId && !priorCustomerIds.has(event.stripeCustomerId)) {
        addAccount(
          newAccountKeysByCurrency,
          event.currency,
          event.stripeCustomerId,
        );
      }
    }
    for (const subscription of liveGhlSubscriptions) {
      if (
        subscription.providerSubscriptionId &&
        knownStripeSubscriptionIds.some(
          (row) => row.stripeSubscriptionId === subscription.providerSubscriptionId,
        )
      ) {
        continue;
      }
      const accountKey = subscription.contactId ?? subscription.contactEmail ?? null;
      addAccount(liveAccountKeysByCurrency, subscription.currency, accountKey);
      if (
        subscription.providerCreatedAt &&
        subscription.providerCreatedAt >= period.start &&
        subscription.providerCreatedAt < period.end
      ) {
        addAccount(newAccountKeysByCurrency, subscription.currency, accountKey);
      }
    }
    const commissionReady = lockedCommissionRun?.status === "locked";
    const salesCashByCurrency = new Map<string, Prisma.Decimal>();
    if (commissionReady) {
      for (const snapshot of lockedCommissionRun.repSnapshots) {
        salesCashByCurrency.set(
          snapshot.currency,
          (salesCashByCurrency.get(snapshot.currency) ?? new Prisma.Decimal(0)).add(
            snapshot.cashPayableMinor,
          ),
        );
      }
    }
    const growthCurrencies = new Set([
      ...Object.keys(combinedMrr.combinedMinorByCurrency),
      ...Object.keys(unitEconomicsByCurrency),
      ...liveAccountKeysByCurrency.keys(),
      ...newAccountKeysByCurrency.keys(),
      ...salesCashByCurrency.keys(),
    ]);
    const growthBuckets = Object.fromEntries(
      [...growthCurrencies].map((currency) => {
        const unit = unitEconomicsByCurrency[currency];
        return [
          currency,
          {
            mrrMinor: new Prisma.Decimal(
              combinedMrr.combinedMinorByCurrency[currency] ?? 0,
            ),
            collectedMinor: new Prisma.Decimal(unit?.collectedMinor ?? 0),
            acquisitionCostMinor: new Prisma.Decimal(
              unit?.acquisitionCostMinor ?? 0,
            ),
            deliveryCostMinor: new Prisma.Decimal(unit?.deliveryCostMinor ?? 0),
            salesCashMinor: salesCashByCurrency.get(currency) ?? new Prisma.Decimal(0),
            liveAccounts: liveAccountKeysByCurrency.get(currency)?.size ?? 0,
            newCustomers: newAccountKeysByCurrency.get(currency)?.size ?? 0,
          },
        ];
      }),
    );
    const configuration =
      lockedCommissionRun?.configurationSnapshot &&
      typeof lockedCommissionRun.configurationSnapshot === "object" &&
      !Array.isArray(lockedCommissionRun.configurationSnapshot)
        ? (lockedCommissionRun.configurationSnapshot as Record<string, unknown>)
        : null;
    const decisions =
      configuration?.decisions &&
      typeof configuration.decisions === "object" &&
      !Array.isArray(configuration.decisions)
        ? (configuration.decisions as Record<string, Record<string, unknown>>)
        : null;
    const currencyDecision = decisions?.currency_policy?.value as
      | { mode?: string; baseCurrency?: string; fxRates?: Record<string, string> }
      | undefined;
    let normalizedGrowthBuckets = growthBuckets;
    let normalizedTrailingRevenueChurnPercentByCurrency =
      trailingRevenueChurn.revenueChurnPercentByCurrency;
    if (
      currencyDecision?.mode === "base_currency" &&
      currencyDecision.baseCurrency &&
      currencyDecision.fxRates
    ) {
      const base = currencyDecision.baseCurrency.toLowerCase();
      const combined = {
        mrrMinor: new Prisma.Decimal(0),
        collectedMinor: new Prisma.Decimal(0),
        acquisitionCostMinor: new Prisma.Decimal(0),
        deliveryCostMinor: new Prisma.Decimal(0),
        salesCashMinor: new Prisma.Decimal(0),
        liveAccounts: 0,
        newCustomers: 0,
      };
      for (const [currency, bucket] of Object.entries(growthBuckets)) {
        const rate =
          currency === base
            ? new Prisma.Decimal(1)
            : new Prisma.Decimal(currencyDecision.fxRates[currency] ?? 0);
        const sourceFactor = new Prisma.Decimal(10).pow(currencyExponent(currency));
        const targetFactor = new Prisma.Decimal(10).pow(currencyExponent(base));
        const convert = (amount: Prisma.Decimal) =>
          amount.div(sourceFactor).mul(rate).mul(targetFactor);
        combined.mrrMinor = combined.mrrMinor.add(convert(bucket.mrrMinor));
        combined.collectedMinor = combined.collectedMinor.add(
          convert(bucket.collectedMinor),
        );
        combined.acquisitionCostMinor = combined.acquisitionCostMinor.add(
          convert(bucket.acquisitionCostMinor),
        );
        combined.deliveryCostMinor = combined.deliveryCostMinor.add(
          convert(bucket.deliveryCostMinor),
        );
        combined.salesCashMinor = combined.salesCashMinor.add(
          currency === base ? bucket.salesCashMinor : convert(bucket.salesCashMinor),
        );
        combined.liveAccounts += bucket.liveAccounts;
        combined.newCustomers += bucket.newCustomers;
      }
      normalizedGrowthBuckets = { [base]: combined };
      const opening = new Prisma.Decimal(0);
      const churned = new Prisma.Decimal(0);
      let convertedOpening = opening;
      let convertedChurned = churned;
      const trailingCurrencies = new Set([
        ...Object.keys(trailingRevenueChurn.openingMrrMinorByCurrency),
        ...Object.keys(trailingRevenueChurn.churnedMrrMinorByCurrency),
      ]);
      for (const currency of trailingCurrencies) {
        const rate =
          currency === base
            ? new Prisma.Decimal(1)
            : new Prisma.Decimal(currencyDecision.fxRates[currency] ?? 0);
        const sourceFactor = new Prisma.Decimal(10).pow(
          currencyExponent(currency),
        );
        const targetFactor = new Prisma.Decimal(10).pow(currencyExponent(base));
        const convert = (amount: string) =>
          new Prisma.Decimal(amount)
            .div(sourceFactor)
            .mul(rate)
            .mul(targetFactor);
        convertedOpening = convertedOpening.add(
          convert(
            trailingRevenueChurn.openingMrrMinorByCurrency[currency] ?? "0",
          ),
        );
        convertedChurned = convertedChurned.add(
          convert(
            trailingRevenueChurn.churnedMrrMinorByCurrency[currency] ?? "0",
          ),
        );
      }
      normalizedTrailingRevenueChurnPercentByCurrency = {
        [base]: convertedOpening.gt(0)
          ? convertedChurned.mul(100).div(convertedOpening).toFixed(4)
          : null,
      };
    }
    const growthEconomics = commissionReady
      ? calculateGrowthEconomics(
          normalizedGrowthBuckets,
          normalizedTrailingRevenueChurnPercentByCurrency,
        )
      : {};
    const paidSubscriptionIds = new Set(
      paidSubscriptionRefs.flatMap((row) =>
        row.stripeSubscriptionId ? [row.stripeSubscriptionId] : [],
      ),
    );
    const upliftSubscriptions = leaderboardSubscriptions.filter((subscription) =>
      subscription.stripePriceIds.some((priceId) =>
        upliftPlanByPriceId.has(priceId),
      ),
    );
    const upliftSubscriptionIds = upliftSubscriptions.map(
      (subscription) => subscription.stripeSubscriptionId,
    );
    const liveUpliftBilling = await loadLiveUpliftSubscriptionBilling({
      subscriptionIds: new Set(upliftSubscriptionIds),
      upliftPriceIds: new Set(upliftPlanByPriceId.keys()),
    });
    const upliftMonthlyPaidGroups = upliftSubscriptionIds.length
      ? await prisma.commandStripeInvoice.groupBy({
          by: ["currency"],
          where: {
            status: "paid",
            paidAt: { gte: period.start, lt: period.end },
            stripeSubscriptionId: { in: upliftSubscriptionIds },
          },
          _sum: { amountPaidMinor: true },
        })
      : [];
    const upliftMrrByCurrency = new Map<string, Prisma.Decimal>();
    const upliftPlanBuckets = new Map<
      string,
      {
        definition: UpliftPlanDefinition;
        subscriptionCount: number;
        activeCount: number;
        trialingCount: number;
        pastDueCount: number;
        discountedSubscriptionIds: Set<string>;
        discounts: Map<
          string,
          {
            key: string;
            discount: ResolvedStripeDiscount;
            subscriptionIds: Set<string>;
          }
        >;
        listMonthlyRecurringMinorByCurrency: Map<string, Prisma.Decimal>;
        discountMonthlyRecurringMinorByCurrency: Map<string, Prisma.Decimal>;
        monthlyRecurringMinorByCurrency: Map<string, Prisma.Decimal>;
      }
    >();
    for (const subscription of upliftSubscriptions) {
      const livePlans = liveUpliftBilling?.bySubscriptionId.get(
        subscription.stripeSubscriptionId,
      );
      const fallbackPriceId = subscription.stripePriceIds.find((id) =>
        upliftPlanByPriceId.has(id),
      );
      const plans =
        livePlans && livePlans.length > 0
          ? livePlans
          : fallbackPriceId && subscription.currency
            ? [
                {
                  priceId: fallbackPriceId,
                  currency: subscription.currency,
                  grossMonthlyMinor: subscription.monthlyRecurringMinor,
                  netMonthlyMinor: subscription.monthlyRecurringMinor,
                  discountMonthlyMinor: new Prisma.Decimal(0),
                  discounts: [],
                },
              ]
            : [];
      for (const plan of plans) {
        const definition = upliftPlanByPriceId.get(plan.priceId);
        if (!definition) continue;
        upliftMrrByCurrency.set(
          plan.currency,
          (upliftMrrByCurrency.get(plan.currency) ?? new Prisma.Decimal(0)).add(
            plan.netMonthlyMinor,
          ),
        );
        const bucket = upliftPlanBuckets.get(plan.priceId) ?? {
          definition,
          subscriptionCount: 0,
          activeCount: 0,
          trialingCount: 0,
          pastDueCount: 0,
          discountedSubscriptionIds: new Set<string>(),
          discounts: new Map<
            string,
            {
              key: string;
              discount: ResolvedStripeDiscount;
              subscriptionIds: Set<string>;
            }
          >(),
          listMonthlyRecurringMinorByCurrency: new Map<string, Prisma.Decimal>(),
          discountMonthlyRecurringMinorByCurrency: new Map<string, Prisma.Decimal>(),
          monthlyRecurringMinorByCurrency: new Map<string, Prisma.Decimal>(),
        };
        bucket.subscriptionCount += 1;
        if (subscription.status === "active") bucket.activeCount += 1;
        if (subscription.status === "trialing") bucket.trialingCount += 1;
        if (subscription.status === "past_due") bucket.pastDueCount += 1;
        if (plan.discountMonthlyMinor.gt(0)) {
          bucket.discountedSubscriptionIds.add(
            subscription.stripeSubscriptionId,
          );
        }
        for (const discount of plan.discounts) {
          const key = JSON.stringify({
            label: discount.label,
            percentOff: discount.percentOff,
            amountOffMinor: discount.amountOffMinor,
            amountOffCurrency: discount.amountOffCurrency,
            amountOffByCurrency: Object.fromEntries(
              Object.entries(discount.amountOffByCurrency).sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            ),
            duration: discount.duration,
            durationInMonths: discount.durationInMonths,
          });
          const summary = bucket.discounts.get(key) ?? {
            key,
            discount,
            subscriptionIds: new Set<string>(),
          };
          summary.subscriptionIds.add(subscription.stripeSubscriptionId);
          bucket.discounts.set(key, summary);
        }
        bucket.listMonthlyRecurringMinorByCurrency.set(
          plan.currency,
          (bucket.listMonthlyRecurringMinorByCurrency.get(plan.currency) ??
            new Prisma.Decimal(0)).add(plan.grossMonthlyMinor),
        );
        bucket.discountMonthlyRecurringMinorByCurrency.set(
          plan.currency,
          (bucket.discountMonthlyRecurringMinorByCurrency.get(plan.currency) ??
            new Prisma.Decimal(0)).add(plan.discountMonthlyMinor),
        );
        bucket.monthlyRecurringMinorByCurrency.set(
          plan.currency,
          (bucket.monthlyRecurringMinorByCurrency.get(plan.currency) ??
            new Prisma.Decimal(0)).add(plan.netMonthlyMinor),
        );
        upliftPlanBuckets.set(plan.priceId, bucket);
      }
    }
    const upliftMrrMinorByCurrency = Object.fromEntries(
      [...upliftMrrByCurrency.entries()].map(([currency, amount]) => [
        currency,
        amount.toString(),
      ]),
    );
    const upliftArrRunRateMinorByCurrency = Object.fromEntries(
      [...upliftMrrByCurrency.entries()].map(([currency, amount]) => [
        currency,
        amount.mul(12).toString(),
      ]),
    );
    const upliftCollectedThisMonthMinorByCurrency = Object.fromEntries(
      upliftMonthlyPaidGroups.map((row) => [
        row.currency,
        row._sum.amountPaidMinor?.toString() ?? "0",
      ]),
    );
    const payingUpliftCustomerIds = new Set(
      upliftSubscriptions.flatMap((subscription) =>
        subscription.status !== "trialing" &&
        paidSubscriptionIds.has(subscription.stripeSubscriptionId) &&
        subscription.stripeCustomerId
          ? [subscription.stripeCustomerId]
        : [],
      ),
    );
    const upliftSubscriptionCountByCustomerId = new Map<string, number>();
    for (const subscription of upliftSubscriptions) {
      if (!subscription.stripeCustomerId) continue;
      upliftSubscriptionCountByCustomerId.set(
        subscription.stripeCustomerId,
        (upliftSubscriptionCountByCustomerId.get(
          subscription.stripeCustomerId,
        ) ?? 0) + 1,
      );
    }
    const currentUpliftCustomerIds = new Set(
      upliftSubscriptionCountByCustomerId.keys(),
    );
    const customersWithoutSuccessfulPaymentCount = [
      ...currentUpliftCustomerIds,
    ].filter((customerId) => !payingUpliftCustomerIds.has(customerId)).length;
    const customersWithMultipleSubscriptionsCount = [
      ...upliftSubscriptionCountByCustomerId.values(),
    ].filter((subscriptionCount) => subscriptionCount > 1).length;
    const counts = {
      accounts: accountRows.length,
      subscriptions: subscriptionCount,
      paying: leaderboardSubscriptions.filter(
        (row) =>
          row.status !== "trialing" &&
          paidSubscriptionIds.has(row.stripeSubscriptionId),
      ).length,
      trialing: trialingCount,
      pastDue: pastDueCount,
      paused: pausedCount,
    };
    const mrrByRep = new Map<string, Map<string, Prisma.Decimal>>();
    for (const subscription of leaderboardSubscriptions) {
      if (!subscription.businessId || !subscription.currency) continue;
      const rep = ownerRepByBusinessId.get(subscription.businessId);
      if (!rep) continue;
      const byCurrency = mrrByRep.get(rep.id) ?? new Map();
      byCurrency.set(
        subscription.currency,
        (byCurrency.get(subscription.currency) ?? new Prisma.Decimal(0)).add(
          subscription.monthlyRecurringMinor,
        ),
      );
      mrrByRep.set(rep.id, byCurrency);
    }
    const winsByGhlUserId = new Map(
      wonByGhlUser.map((row) => [row.assignedToGhlId, row._count._all]),
    );
    const repLeaderboard = activeReps
      .map((rep) => {
        const activitySources = leaderboardActivity.filter(
          (row) => row.repId === rep.id,
        );
        const effectiveActivity =
          activitySources.find((row) => row.source === "manual") ??
          activitySources.find((row) => row.source === "ghl_sync") ??
          null;
        const counts = effectiveActivity ?? {
          calls: 0,
          connects: 0,
          meetingsBooked: 0,
          meetingsHeld: 0,
        };
        const closes = rep.ghlUserId
          ? (winsByGhlUserId.get(rep.ghlUserId) ?? 0)
          : 0;
        return {
          rep: { id: rep.id, name: rep.name },
          source: effectiveActivity?.source ?? "none",
          mrrMinorByCurrency: Object.fromEntries(
            [...(mrrByRep.get(rep.id)?.entries() ?? [])]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([currency, amount]) => [currency, amount.toString()]),
          ),
          calls: counts.calls,
          connects: counts.connects,
          meetingsBooked: counts.meetingsBooked,
          meetingsHeld: counts.meetingsHeld,
          closes,
          ...activityRatios(counts, closes),
        };
      })
      .sort((left, right) => right.closes - left.closes || left.rep.name.localeCompare(right.rep.name));

    const payload = {
        counts,
        upliftSubscriptions: {
          customerCount: payingUpliftCustomerIds.size,
          totalCustomerCount: currentUpliftCustomerIds.size,
          payingCustomerCount: payingUpliftCustomerIds.size,
          customersWithoutSuccessfulPaymentCount,
          customersWithMultipleSubscriptionsCount,
          subscriptionCount: upliftSubscriptions.length,
          discountDataStatus: liveUpliftBilling
            ? liveUpliftBilling.missingSubscriptionCount > 0
              ? "partial"
              : "live"
            : "unavailable",
          discountDataMissingSubscriptionCount:
            liveUpliftBilling?.missingSubscriptionCount ??
            upliftSubscriptions.length,
          mrrMinorByCurrency: upliftMrrMinorByCurrency,
          collectedThisMonthMinorByCurrency:
            upliftCollectedThisMonthMinorByCurrency,
          arrRunRateMinorByCurrency: upliftArrRunRateMinorByCurrency,
          plans: [...upliftPlanBuckets.values()]
            .map((bucket) => ({
              name: bucket.definition.name,
              billingPeriod: bucket.definition.billingPeriod,
              currency: bucket.definition.currency,
              unitAmountMinor: bucket.definition.unitAmountMinor,
              subscriptionCount: bucket.subscriptionCount,
              activeCount: bucket.activeCount,
              trialingCount: bucket.trialingCount,
              pastDueCount: bucket.pastDueCount,
              discountedSubscriptionCount:
                bucket.discountedSubscriptionIds.size,
              discounts: [...bucket.discounts.values()]
                .map(({ key, discount, subscriptionIds }) => ({
                  id: key,
                  label: discount.label,
                  percentOff:
                    discount.percentOff === null
                      ? null
                      : String(discount.percentOff),
                  amountOffMinor:
                    discount.amountOffMinor === null
                      ? null
                      : String(discount.amountOffMinor),
                  amountOffCurrency: discount.amountOffCurrency,
                  amountOffByCurrency: Object.fromEntries(
                    Object.entries(discount.amountOffByCurrency).map(
                      ([currency, amount]) => [currency, String(amount)],
                    ),
                  ),
                  duration: discount.duration,
                  durationInMonths: discount.durationInMonths,
                  subscriptionCount: subscriptionIds.size,
                }))
                .sort((left, right) => left.label.localeCompare(right.label)),
              listMonthlyRecurringMinorByCurrency: Object.fromEntries(
                [...bucket.listMonthlyRecurringMinorByCurrency.entries()].map(
                  ([currency, amount]) => [currency, amount.toString()],
                ),
              ),
              discountMonthlyRecurringMinorByCurrency: Object.fromEntries(
                [
                  ...bucket.discountMonthlyRecurringMinorByCurrency.entries(),
                ].map(([currency, amount]) => [
                  currency,
                  amount.toString(),
                ]),
              ),
              monthlyRecurringMinorByCurrency: Object.fromEntries(
                [...bucket.monthlyRecurringMinorByCurrency.entries()].map(
                  ([currency, amount]) => [currency, amount.toString()],
                ),
              ),
            }))
            .sort(
              (left, right) =>
                left.name.localeCompare(right.name) ||
                left.billingPeriod.localeCompare(right.billingPeriod),
            ),
        },
        stripeMrrMinorByCurrency: mrrMinorByCurrency,
        ghlRecurringMrrMinorByCurrency: combinedMrr.addedMinorByCurrency,
        mrrMinorByCurrency: combinedMrr.combinedMinorByCurrency,
        arrRunRateMinorByCurrency: combinedArrRunRateMinorByCurrency,
        paidToDateMinorByCurrency,
        unitEconomics: {
          period,
          byCurrency: unitEconomicsByCurrency,
        },
        growthEconomics: {
          ready: commissionReady,
          blockedBy: commissionReady ? [] : ["locked_commission_run"],
          trailingMonths: commandMonthsEndingAt(period.month, 3),
          trailingRevenueChurnPercentByCurrency:
            normalizedTrailingRevenueChurnPercentByCurrency,
          byCurrency: growthEconomics,
        },
        repLeaderboard,
        monthlyMovement: {
          period,
          ...monthlyMovement,
        },
        rosterPagination: commandPaginationResult({
          page,
          pageSize,
          total: accountRows.length,
        }),
        roster: rosterCustomerIds.map((stripeCustomerId) => {
          const subscriptions = roster.filter(
            (row) => row.stripeCustomerId === stripeCustomerId,
          );
          const first = subscriptions[0];
          const account = commandAccountByStripeCustomerId.get(stripeCustomerId);
          const mrrMinorByCurrency = new Map<string, Prisma.Decimal>();
          const paidToDateMinorByCurrency = new Map<string, Prisma.Decimal>();
          for (const subscription of subscriptions) {
            if (subscription.currency) {
              mrrMinorByCurrency.set(
                subscription.currency,
                (mrrMinorByCurrency.get(subscription.currency) ?? new Prisma.Decimal(0)).add(
                  subscription.monthlyRecurringMinor,
                ),
              );
            }
            for (const [currency, amount] of
              invoiceTotalsBySubscription.get(
                subscription.stripeSubscriptionId,
              )?.entries() ?? []) {
              paidToDateMinorByCurrency.set(
                currency,
                (paidToDateMinorByCurrency.get(currency) ?? new Prisma.Decimal(0)).add(
                  amount,
                ),
              );
            }
          }
          const firstSeenDates = subscriptions.flatMap((subscription) => {
            const value = firstEventBySubscription.get(subscription.stripeSubscriptionId);
            return value ? [value] : [];
          });
          const trueStarts = subscriptions.flatMap((subscription) => {
            const value = trueStartFor(subscription.stripeSubscriptionId);
            return value ? [value] : [];
          });
          const earliestTrueStart = trueStarts.reduce<
            { at: Date; source: "stripe_event" | "subscription_record" } | null
          >(
            (earliest, candidate) =>
              earliest === null || candidate.at < earliest.at ? candidate : earliest,
            null,
          );
          const renewalDates = subscriptions.flatMap((subscription) =>
            subscription.currentPeriodEnd ? [subscription.currentPeriodEnd] : [],
          );
          const fallbackOwner = first?.businessId
            ? (ownerRepByBusinessId.get(first.businessId) ?? null)
            : null;
          return {
            accountId: account?.id ?? null,
            stripeCustomerId,
            name:
              account?.name ??
              (first?.businessId
                ? businessById.get(first.businessId)?.businessName
                : null) ??
              (first?.userId ? userById.get(first.userId)?.name : null) ??
              "Unmapped account",
            email:
              account?.normalizedEmail ??
              (first?.userId ? userById.get(first.userId)?.email : null) ??
              null,
            // Somebody to call. The account owner's number comes first because
            // that is the person who holds the subscription; the business line
            // is the fallback, and which one it is gets said rather than left
            // for the caller to discover when a receptionist answers.
            phone:
              (first?.userId ? userById.get(first.userId)?.phone : null) ??
              (first?.businessId
                ? businessById.get(first.businessId)?.businessPhone
                : null) ??
              null,
            phoneSource: (first?.userId
              ? userById.get(first.userId)?.phone
              : null)
              ? "user"
              : (first?.businessId
                    ? businessById.get(first.businessId)?.businessPhone
                    : null)
                ? "business"
                : null,
            // Shaped explicitly so selecting businessPhone above does not
            // quietly widen this object's contract.
            business: first?.businessId
              ? (() => {
                  const record = businessById.get(first.businessId);
                  return record
                    ? { id: record.id, businessName: record.businessName }
                    : null;
                })()
              : null,
            ownerRep: account?.ownerRep ?? fallbackOwner,
            subscriptionsHeld: subscriptions.length,
            statuses: [...new Set(subscriptions.map((row) =>
              row.pauseCollectionBehavior ? "paused" : row.status,
            ))].sort(),
            cancelAtPeriodEnd: subscriptions.some((row) => row.cancelAtPeriodEnd),
            mrrMinorByCurrency: Object.fromEntries(
              [...mrrMinorByCurrency.entries()].map(([currency, amount]) => [
                currency,
                amount.toString(),
              ]),
            ),
            paidToDateMinorByCurrency: Object.fromEntries(
              [...paidToDateMinorByCurrency.entries()].map(([currency, amount]) => [
                currency,
                amount.toString(),
              ]),
            ),
            // Null when nothing authoritative is known, so a reader is told
            // rather than shown the day the sync happened to run.
            startedAt: earliestTrueStart?.at ?? null,
            startedAtSource: earliestTrueStart?.source ?? null,
            // What `startedAt` used to be. Kept under a name that says what it
            // is, so anything still reading it is not silently changed.
            firstSeenAt:
              firstSeenDates.length > 0
                ? new Date(Math.min(...firstSeenDates.map((value) => value.getTime())))
                : null,
            nextRenewalAt:
              renewalDates.length > 0
                ? new Date(Math.min(...renewalDates.map((value) => value.getTime())))
                : null,
            stripeSubscriptionIds: subscriptions.map(
              (row) => row.stripeSubscriptionId,
            ),
          };
        }),
      };
    await writeCommandCache(cacheKey, payload, 60);
    sendSuccess(res, payload, "Command Stripe overview");
  } catch (error) {
    sendError(res, "Failed to load Command Stripe overview", 500, error);
  }
}

export async function getCommandStripeSyncRuns(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const runs = await prisma.commandProviderSyncRun.findMany({
      where: { provider: "stripe" },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    sendSuccess(res, { runs }, "Command Stripe sync runs");
  } catch (error) {
    sendError(res, "Failed to load Stripe sync runs", 500, error);
  }
}

export async function getCommandStripeHealth(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const [statusGroups, paused, pastDue, pastDueTotal, cancellations, cancellationTotal] =
      await Promise.all([
        prisma.commandStripeSubscriptionSnapshot.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        prisma.commandStripeSubscriptionSnapshot.count({
          where: { pauseCollectionBehavior: { not: null } },
        }),
        prisma.commandStripeSubscriptionSnapshot.findMany({
          where: { status: "past_due" },
          orderBy: { occurredAt: "desc" },
          take: 100,
        }),
        prisma.commandStripeSubscriptionSnapshot.count({
          where: { status: "past_due" },
        }),
        prisma.commandStripeSubscriptionSnapshot.findMany({
          where: {
            OR: [{ status: "canceled" }, { cancelAtPeriodEnd: true }],
          },
          orderBy: { occurredAt: "desc" },
          take: 100,
        }),
        prisma.commandStripeSubscriptionSnapshot.count({
          where: {
            OR: [{ status: "canceled" }, { cancelAtPeriodEnd: true }],
          },
        }),
      ]);

    const rows = [...pastDue, ...cancellations];
    const stripeCustomerIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.stripeCustomerId ? [row.stripeCustomerId] : [],
        ),
      ),
    ];
    const commandAccounts = await prisma.commandAccount.findMany({
      where: { stripeCustomerId: { in: stripeCustomerIds } },
      select: {
        id: true,
        name: true,
        normalizedEmail: true,
        stripeCustomerId: true,
        userId: true,
        businessId: true,
      },
    });
    const commandAccountByStripeCustomerId = new Map(
      commandAccounts.flatMap((account) =>
        account.stripeCustomerId
          ? [[account.stripeCustomerId, account] as const]
          : [],
      ),
    );
    const userIds = [
      ...new Set([
        ...rows.flatMap((row) => (row.userId ? [row.userId] : [])),
        ...commandAccounts.flatMap((account) =>
          account.userId ? [account.userId] : [],
        ),
      ]),
    ];
    const businessIds = [
      ...new Set([
        ...rows.flatMap((row) => (row.businessId ? [row.businessId] : [])),
        ...commandAccounts.flatMap((account) =>
          account.businessId ? [account.businessId] : [],
        ),
      ]),
    ];
    const [users, businesses] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      }),
      prisma.business.findMany({
        where: { id: { in: businessIds } },
        select: { id: true, businessName: true },
      }),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const businessById = new Map(
      businesses.map((business) => [business.id, business]),
    );
    const project = (row: (typeof rows)[number]) => {
      const commandAccount = row.stripeCustomerId
        ? commandAccountByStripeCustomerId.get(row.stripeCustomerId)
        : null;
      const userId = row.userId ?? commandAccount?.userId ?? null;
      const businessId = row.businessId ?? commandAccount?.businessId ?? null;
      return {
        stripeSubscriptionId: row.stripeSubscriptionId,
        stripeCustomerId: row.stripeCustomerId,
        stripeCustomer: commandAccount
          ? {
              id: commandAccount.id,
              name: commandAccount.name,
              email: commandAccount.normalizedEmail,
            }
          : null,
        user: userId ? (userById.get(userId) ?? null) : null,
        business: businessId
          ? (businessById.get(businessId) ?? null)
          : null,
        status: row.status,
        paused: row.pauseCollectionBehavior !== null,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        monthlyRecurringMinor: row.monthlyRecurringMinor.toString(),
        currency: row.currency,
        currentPeriodEnd: row.currentPeriodEnd,
        lastEventAt: row.occurredAt,
      };
    };

    sendSuccess(
      res,
      {
        statusCounts: {
          ...Object.fromEntries(
            statusGroups.map((row) => [row.status, row._count._all]),
          ),
          paused,
        },
        pastDue: {
          total: pastDueTotal,
          truncated: pastDueTotal > pastDue.length,
          rows: pastDue.map(project),
        },
        cancellations: {
          total: cancellationTotal,
          truncated: cancellationTotal > cancellations.length,
          rows: cancellations.map(project),
        },
      },
      "Command Stripe health",
    );
  } catch (error) {
    sendError(res, "Failed to load Stripe health", 500, error);
  }
}

export async function requestCommandStripeReconciliation(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const result = await inngest.send({
      name: "command/stripe.reconcile.requested",
      data: {
        requestedByUserId: req.authUserId,
        requestedAt: new Date().toISOString(),
      },
    });
    sendSuccess(
      res,
      { eventIds: result.ids },
      "Stripe reconciliation queued",
      202,
    );
  } catch (error) {
    sendError(res, "Failed to queue Stripe reconciliation", 500, error);
  }
}

/** Live statuses, matching the roster and MRR queries in this file. */
const LIFECYCLE_LIVE_STATUSES = ["trialing", "active", "past_due"];
/** Same ceiling the superadmin daily metrics use, for the same reason. */
const LIFECYCLE_MAX_DAYS = 3_660;

function parseLifecycleRange(query: Request["query"]) {
  const raw = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  const today = commandDayForDate(new Date());
  const to = raw(query.to) ?? today;
  const from = raw(query.from) ?? to;
  try {
    const range = commandDayRange(from, to);
    if (range.dayCount > LIFECYCLE_MAX_DAYS) {
      return { error: new Error(`Date range cannot exceed ${LIFECYCLE_MAX_DAYS} days`) } as const;
    }
    return { range } as const;
  } catch (error) {
    return { error } as const;
  }
}

/**
 * Daily subscription starts and cancellations.
 *
 * Answers the two questions the Command panel has had to guess at: how many
 * subscriptions began on a given day, and how many ended — with the revenue
 * attached to each, per currency, never summed across them.
 *
 * The timing is taken only from real Stripe webhook rows. Reconciliation
 * snapshots carry the sync run's clock rather than the event's, so treating
 * them as starts would report long-standing customers as new business. See
 * `command/stripe-lifecycle.ts`; the `coverage` block reports exactly how much
 * of the roster this endpoint can and cannot date, so the panel can say so
 * rather than drawing zeros that read as "nothing happened".
 */
export async function getCommandStripeLifecycle(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const parsed = parseLifecycleRange(req.query);
    if ("error" in parsed) {
      sendError(res, "Invalid query", 400, parsed.error);
      return;
    }
    const { range } = parsed;
    const cacheKey = `stripe-lifecycle-v1:${range.from}:${range.to}`;
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command Stripe lifecycle");
      return;
    }

    const eventSelect = {
      stripeSubscriptionId: true,
      stripeCustomerId: true,
      eventType: true,
      status: true,
      monthlyRecurringMinor: true,
      currency: true,
      occurredAt: true,
    } as const;

    const [inRange, liveSubscriptions, createdEventRefs] = await Promise.all([
      prisma.commandStripeSubscriptionEvent.findMany({
        where: {
          occurredAt: { gte: range.start, lt: range.end },
          eventType: { in: [SUBSCRIPTION_CREATED_EVENT, SUBSCRIPTION_DELETED_EVENT] },
        },
        select: eventSelect,
        orderBy: { occurredAt: "asc" },
      }),
      prisma.commandStripeSubscriptionSnapshot.findMany({
        where: { status: { in: LIFECYCLE_LIVE_STATUSES } },
        select: { stripeSubscriptionId: true },
      }),
      prisma.commandStripeSubscriptionEvent.findMany({
        where: { eventType: SUBSCRIPTION_CREATED_EVENT },
        distinct: ["stripeSubscriptionId"],
        select: { stripeSubscriptionId: true },
      }),
    ]);

    // A cancellation whose payload reports zero needs the last known value to
    // say what was actually lost. Only those subscriptions need their history,
    // so the second read stays small instead of pulling the whole log.
    const needsPriorValue = inRange
      .filter(
        (event) =>
          event.eventType === SUBSCRIPTION_DELETED_EVENT &&
          event.monthlyRecurringMinor.isZero(),
      )
      .map((event) => event.stripeSubscriptionId);
    const priorValues = needsPriorValue.length
      ? await prisma.commandStripeSubscriptionEvent.findMany({
          where: {
            stripeSubscriptionId: { in: [...new Set(needsPriorValue)] },
            occurredAt: { lt: range.end },
          },
          select: eventSelect,
          orderBy: { occurredAt: "asc" },
        })
      : [];

    // The oldest believable event overall, so the panel can say where the
    // series genuinely begins rather than implying it covers all history.
    const oldestReal = await prisma.commandStripeSubscriptionEvent.findFirst({
      where: {
        eventType: { in: [SUBSCRIPTION_CREATED_EVENT, SUBSCRIPTION_DELETED_EVENT] },
      },
      select: { occurredAt: true },
      orderBy: { occurredAt: "asc" },
    });

    const lifecycle = buildStripeLifecycle({
      events: [...inRange, ...priorValues],
      from: range.from,
      to: range.to,
      liveSubscriptionIds: liveSubscriptions.map((row) => row.stripeSubscriptionId),
      subscriptionIdsWithCreatedEvent: new Set(
        createdEventRefs.map((row) => row.stripeSubscriptionId),
      ),
    });

    const payload = {
      range: {
        from: range.from,
        to: range.to,
        start: range.start.toISOString(),
        endExclusive: range.end.toISOString(),
        dayCount: range.dayCount,
        timeZone: range.timeZone,
      },
      ...lifecycle,
      coverage: {
        ...lifecycle.coverage,
        // Taken from the whole log, not the fetched window, so a narrow range
        // does not make the log look younger than it is.
        eventLogStartsOn: oldestReal
          ? commandDayForDate(oldestReal.occurredAt)
          : null,
        rangeStartsBeforeEventLog: oldestReal
          ? range.from < commandDayForDate(oldestReal.occurredAt)
          : false,
      },
    };

    await writeCommandCache(cacheKey, payload);
    sendSuccess(res, payload, "Command Stripe lifecycle");
  } catch (error: unknown) {
    sendError(res, "Failed to load Stripe lifecycle", 500, error);
  }
}

/**
 * Core plan versus core + social, and who moved between them.
 *
 * Three questions in one call: how many are on the core plan only, how many
 * carry the social add-on, and how many existing customers added it recently.
 *
 * The classification deliberately reads the Stripe product name rather than a
 * configured price list. The admin's plan chart used the billing endpoint's
 * configured prices, which only ever held the two core price IDs, so every
 * SEO + Social subscription rendered as "not on a listed plan — no backend
 * entry": an entire product line showing up as a data gap.
 *
 * The upgrade count cannot come from current state at all. A subscription on
 * the social price looks identical whether it started there or moved there last
 * week, so the move is read from the event log — and only from real Stripe
 * events, because reconciliation snapshots carry the sync clock.
 */
export async function getCommandStripePlanMix(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const parsed = parseLifecycleRange(req.query);
    if ("error" in parsed) {
      sendError(res, "Invalid query", 400, parsed.error);
      return;
    }
    const { range } = parsed;
    const cacheKey = `stripe-plan-mix-v1:${range.from}:${range.to}`;
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command Stripe plan mix");
      return;
    }

    const plans = await getUpliftPlanDefinitions();
    const socialPriceIds = new Set(
      plans
        .filter((plan) => /social/i.test(plan.name))
        .map((plan) => plan.priceId),
    );

    const snapshots = await prisma.commandStripeSubscriptionSnapshot.findMany({
      where: { status: { in: LIFECYCLE_LIVE_STATUSES } },
      select: {
        stripeSubscriptionId: true,
        stripeCustomerId: true,
        status: true,
        stripePriceIds: true,
        monthlyRecurringMinor: true,
        currency: true,
      },
    });
    const subscriptionIds = snapshots.map((row) => row.stripeSubscriptionId);

    const events = subscriptionIds.length
      ? await prisma.commandStripeSubscriptionEvent.findMany({
          where: { stripeSubscriptionId: { in: subscriptionIds } },
          select: {
            stripeSubscriptionId: true,
            stripeCustomerId: true,
            eventType: true,
            stripePriceIds: true,
            occurredAt: true,
          },
          orderBy: { occurredAt: "asc" },
        })
      : [];

    const mix = buildPlanMix({
      snapshots,
      events,
      socialPriceIds,
      from: range.from,
      to: range.to,
    });

    // Put a name on the recent upgrades so the panel can list who, not just
    // how many — an upgrade nobody can identify is not actionable.
    const upgradeCustomerIds = [
      ...new Set(
        mix.upgrades.recent.flatMap((upgrade) =>
          upgrade.stripeCustomerId ? [upgrade.stripeCustomerId] : [],
        ),
      ),
    ];
    const accounts = upgradeCustomerIds.length
      ? await prisma.commandAccount.findMany({
          where: { stripeCustomerId: { in: upgradeCustomerIds } },
          select: { stripeCustomerId: true, name: true, normalizedEmail: true },
        })
      : [];
    const accountByCustomer = new Map(
      accounts.flatMap((row) =>
        row.stripeCustomerId ? [[row.stripeCustomerId, row] as const] : [],
      ),
    );

    const payload = {
      range: {
        from: range.from,
        to: range.to,
        dayCount: range.dayCount,
        timeZone: range.timeZone,
      },
      plans: plans.map((plan) => ({
        priceId: plan.priceId,
        name: plan.name,
        billingPeriod: plan.billingPeriod,
        isSocial: socialPriceIds.has(plan.priceId),
      })),
      ...mix,
      upgrades: {
        ...mix.upgrades,
        recent: mix.upgrades.recent.map((upgrade) => {
          const account = upgrade.stripeCustomerId
            ? accountByCustomer.get(upgrade.stripeCustomerId)
            : undefined;
          return {
            ...upgrade,
            name: account?.name ?? null,
            email: account?.normalizedEmail ?? null,
          };
        }),
      },
    };

    await writeCommandCache(cacheKey, payload, 120);
    sendSuccess(res, payload, "Command Stripe plan mix");
  } catch (error: unknown) {
    sendError(res, "Failed to load Stripe plan mix", 500, error);
  }
}
