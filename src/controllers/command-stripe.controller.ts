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
import { buildPlanMix, type SubscriptionSpan } from "../command/plan-mix";
import {
  classifyEntryPath,
  tallyEntryPaths,
  type EntryClassification,
  type EntryRoute,
  type InvoiceFact,
} from "../command/entry-path";
import {
  buildChurnCallList,
  buildMonthMovement,
  buildMovementHistory,
  commandMonthSpan,
  earliestFactMonth,
  parseMovementMonth,
  type ChurnIdentity,
  type FailedInvoiceFact,
  type MovementFact,
} from "../command/month-movement";
import {
  commandPaginationResult,
  parseCommandPagination,
} from "../command/pagination";
import {
  aggregateGhlRevenue,
  isSettledGhlPayment,
} from "../command/ghl-payment-metrics";
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
    /**
     * A ceiling high enough that the roster arrives in one page.
     *
     * This endpoint computes the entire Command payload — nineteen parallel
     * aggregations, three months of movement, the rep leaderboard, growth
     * economics — and *then* slices out one page of the roster. The cost is per
     * request, not per row. So a reader who needs the whole roster and can only
     * have 100 accounts at a time pays for that whole aggregation once per
     * hundred accounts: at 183 live accounts the Command page was running it
     * twice, on top of a third for its own metrics at a different page size.
     *
     * The default stays 50 for anything that just wants a page. Raising only
     * the ceiling means one request can now cover the roster outright, and
     * because every page in the panel asks at the same size they share a single
     * cache entry rather than warming one each.
     *
     * The better shape is a `stripe/roster` endpoint that reads only what a
     * roster needs — around eleven queries rather than thirty — so the two
     * concerns stop sharing a response at all. That is recorded in
     * docs/command-panel/backend-asks.md and is a refactor of the roster row
     * builder, not a parameter change; it should not ride along with this.
     */
    const { page, pageSize, skip } = parseCommandPagination({
      page: req.query.page,
      pageSize: req.query.pageSize,
      maxPageSize: 500,
    });
    const cacheKey = `stripe-overview-v11:${period.month}:${page}:${pageSize}`;
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command Stripe overview");
      return;
    }
    // How fresh the facts below actually are. Without this the panel is a
    // confident table with no way to tell a live number from one the sync
    // stopped updating three days ago.
    const [newestSnapshot, lastSyncRun] = await Promise.all([
      prisma.commandStripeSubscriptionSnapshot.aggregate({
        _max: { occurredAt: true, updatedAt: true },
      }),
      prisma.commandProviderSyncRun.findFirst({
        where: { provider: "stripe" },
        orderBy: { startedAt: "desc" },
        select: {
          status: true,
          mode: true,
          startedAt: true,
          completedAt: true,
          inspected: true,
          updated: true,
          error: true,
        },
      }),
    ]);

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

    /**
     * Trial-first versus paid-full-price-on-day-one, for every live
     * subscription.
     *
     * Read over the whole book rather than the visible page, because the
     * headline counts are about the business and a page of fifty would answer a
     * different question. The invoice rows are the only record of *entry* that
     * survives conversion — see `command/entry-path.ts`.
     */
    const liveForEntryPath =
      await prisma.commandStripeSubscriptionSnapshot.findMany({
        where: liveWhere,
        select: {
          stripeSubscriptionId: true,
          stripeCustomerId: true,
          monthlyRecurringMinor: true,
        },
      });
    const entryInvoiceRows = liveForEntryPath.length
      ? await prisma.commandStripeInvoice.findMany({
          where: {
            stripeSubscriptionId: {
              in: liveForEntryPath.map((row) => row.stripeSubscriptionId),
            },
          },
          select: {
            stripeSubscriptionId: true,
            currency: true,
            amountPaidMinor: true,
            billingReason: true,
            paidAt: true,
            providerCreatedAt: true,
          },
        })
      : [];
    const invoicesBySubscription = new Map<string, InvoiceFact[]>();
    for (const row of entryInvoiceRows) {
      if (!row.stripeSubscriptionId) continue;
      const list = invoicesBySubscription.get(row.stripeSubscriptionId) ?? [];
      list.push(row as InvoiceFact);
      invoicesBySubscription.set(row.stripeSubscriptionId, list);
    }
    const entryBySubscription = new Map<string, EntryClassification>();
    for (const subscription of liveForEntryPath) {
      entryBySubscription.set(
        subscription.stripeSubscriptionId,
        classifyEntryPath({
          invoices: invoicesBySubscription.get(subscription.stripeSubscriptionId) ?? [],
          recurringMinor: subscription.monthlyRecurringMinor,
        }),
      );
    }
    const entryPathTotals = tallyEntryPaths([...entryBySubscription.values()]);

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
    /**
     * Cash collected on Uplift plans: this month, and since the beginning.
     *
     * Both, because the panel needs both and they answer different questions —
     * "is this month tracking" against "what has this product ever earned". Run
     * together so the second costs a query rather than a round trip.
     *
     * Scoped to Uplift subscription invoices, matching every other figure in the
     * snapshot block. Total collected across *everything* Stripe has settled,
     * one-off invoices included, is `paidToDateMinorByCurrency` further down.
     */
    const [upliftMonthlyPaidGroups, upliftAllTimePaidGroups] =
      upliftSubscriptionIds.length
        ? await Promise.all([
            prisma.commandStripeInvoice.groupBy({
              by: ["currency"],
              where: {
                status: "paid",
                paidAt: { gte: period.start, lt: period.end },
                stripeSubscriptionId: { in: upliftSubscriptionIds },
              },
              _sum: { amountPaidMinor: true },
            }),
            prisma.commandStripeInvoice.groupBy({
              by: ["currency"],
              where: {
                status: "paid",
                paidAt: { not: null },
                stripeSubscriptionId: { in: upliftSubscriptionIds },
              },
              _sum: { amountPaidMinor: true },
            }),
          ])
        : [[], []];
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
    const upliftCollectedAllTimeMinorByCurrency = Object.fromEntries(
      upliftAllTimePaidGroups.map((row) => [
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
          collectedAllTimeMinorByCurrency:
            upliftCollectedAllTimeMinorByCurrency,
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
        dataFreshness: {
          /** When this payload was computed, before any caching. */
          generatedAt: new Date().toISOString(),
          /** How long a cached copy of it may be served for. */
          cacheTtlSeconds: 60,
          /** Newest provider event behind these figures. */
          newestFactAt: newestSnapshot._max.occurredAt?.toISOString() ?? null,
          /** Newest write to the projection, sync runs included. */
          newestWriteAt: newestSnapshot._max.updatedAt?.toISOString() ?? null,
          lastSync: lastSyncRun
            ? {
                status: lastSyncRun.status,
                mode: lastSyncRun.mode,
                startedAt: lastSyncRun.startedAt.toISOString(),
                completedAt: lastSyncRun.completedAt?.toISOString() ?? null,
                inspected: lastSyncRun.inspected,
                updated: lastSyncRun.updated,
                error: lastSyncRun.error,
              }
            : null,
        },
        /**
         * How the whole live book entered, counted in subscriptions rather than
         * accounts: an account that took both routes cannot be one tally mark.
         */
        entryPaths: entryPathTotals,
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
          const entries = subscriptions.flatMap((subscription) => {
            const value = entryBySubscription.get(subscription.stripeSubscriptionId);
            return value ? [value] : [];
          });
          // One label per account only when its subscriptions agree. An account
          // that bought the trial once and a second plan at full price took
          // both routes, and picking one would throw the other away.
          const distinctEntryPaths = [
            ...new Set(entries.map((entry) => entry.route)),
          ];
          const entryRoute: EntryRoute | "mixed" | null =
            distinctEntryPaths.length === 0
              ? null
              : distinctEntryPaths.length === 1
                ? distinctEntryPaths[0]!
                : "mixed";
          // Only meaningful when there is a single route, so it is withheld
          // rather than picking an arbitrary one of two openings.
          const entryOpening =
            distinctEntryPaths.length === 1 ? entries[0] : undefined;
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
            entryRoute,
            entryReachedFullPrice: entryOpening?.reachedFullPrice ?? null,
            entryFirstPaidMinor: entryOpening?.firstPaidMinor ?? null,
            entryCurrency: entryOpening?.currency ?? null,
            entryPaidInvoiceCount: entryOpening?.paidInvoiceCount ?? null,
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
    const cacheKey = `stripe-plan-mix-v2:${range.from}:${range.to}`;
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

    // Every subscription ever seen, not only the live ones: a core plan the
    // customer cancelled in March is exactly what makes an August social
    // subscription an upgrade rather than a first purchase.
    const allSnapshots = await prisma.commandStripeSubscriptionSnapshot.findMany({
      select: {
        stripeSubscriptionId: true,
        stripeCustomerId: true,
        status: true,
        stripePriceIds: true,
        monthlyRecurringMinor: true,
        currency: true,
      },
    });
    const snapshots = allSnapshots.filter((row) =>
      LIFECYCLE_LIVE_STATUSES.includes(row.status),
    );
    const subscriptionIds = snapshots.map((row) => row.stripeSubscriptionId);
    const allSubscriptionIds = allSnapshots.map((row) => row.stripeSubscriptionId);

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

    // Start dates for every subscription, from the created event where there
    // is one and the subscription record where there is not. Neither source
    // covers the whole base alone.
    const [createdForSpans, recordsForSpans] = await Promise.all([
      allSubscriptionIds.length
        ? prisma.commandStripeSubscriptionEvent.groupBy({
            by: ["stripeSubscriptionId"],
            where: {
              stripeSubscriptionId: { in: allSubscriptionIds },
              eventType: SUBSCRIPTION_CREATED_EVENT,
            },
            _min: { occurredAt: true },
          })
        : Promise.resolve([]),
      allSubscriptionIds.length
        ? prisma.subscription.findMany({
            where: { stripeSubscriptionId: { in: allSubscriptionIds } },
            select: { stripeSubscriptionId: true, startDate: true },
          })
        : Promise.resolve([]),
    ]);
    const createdAtBySub = new Map(
      createdForSpans.flatMap((row) =>
        row._min.occurredAt
          ? ([[row.stripeSubscriptionId, row._min.occurredAt]] as const)
          : [],
      ),
    );
    const recordStartBySub = new Map(
      recordsForSpans.flatMap((row) =>
        row.stripeSubscriptionId
          ? ([[row.stripeSubscriptionId, row.startDate]] as const)
          : [],
      ),
    );
    const spans: SubscriptionSpan[] = allSnapshots.map((row) => ({
      stripeSubscriptionId: row.stripeSubscriptionId,
      stripeCustomerId: row.stripeCustomerId,
      stripePriceIds: row.stripePriceIds,
      startedAt:
        createdAtBySub.get(row.stripeSubscriptionId) ??
        recordStartBySub.get(row.stripeSubscriptionId) ??
        null,
    }));

    const mix = buildPlanMix({
      snapshots,
      events,
      spans,
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

/** Invoice states that mean Stripe tried to take the money and did not get it. */
const FAILED_INVOICE_STATUSES = ["open", "uncollectible"];

/** Snapshot statuses that mean this subscription has ended. */
const MOVEMENT_ENDED_STATUSES = ["canceled", "cancelled", "incomplete_expired"];

/** Ceiling on the month-on-month series, so one bad date cannot balloon it. */
const MOVEMENT_HISTORY_MAX_MONTHS = 24;

/**
 * One month of arrivals against departures, counted in accounts.
 *
 * Replaces the new-versus-churned *MRR* block, which was not merely hard to read
 * but wrong: it decided a subscription was new business when its earliest row in
 * the webhook log fell inside the month, and the log only starts on
 * 2026-08-18. Every live subscription therefore looked like an August arrival —
 * new MRR came back exactly equal to the whole MRR book, and churn came back as
 * zero for want of an opening state. See `command/month-movement.ts`.
 *
 * Two things have to be right for the replacement to mean anything.
 *
 * **The universe is Stripe's, not the app's.** `Subscription` rows are created
 * the moment a Stripe *customer* is made — at checkout entry, with
 * `status: "incomplete"` — and again for free trials, so `Subscription.startDate`
 * dates *checkout attempts*, not paying subscribers. Counting it directly
 * returned 357 arrivals for a month against a book of 183 accounts. So the row
 * set here is `CommandStripeSubscriptionSnapshot`, which only holds
 * subscriptions Stripe actually created; ended ones are kept, so a customer who
 * arrived and churned inside the same month appears on both sides.
 *
 * **The dates come from the best available source, and we say which.** A Stripe
 * `created`/`deleted` event is the provider's own clock and wins wherever one
 * exists. Before 2026-08-18 there are none, so the fallback is the matching
 * `Subscription` record — which is why the whole month is visible at all.
 * Payment failures come from the invoice table, which reconciliation fills from
 * Stripe's own invoice list and so also reaches back past the webhooks.
 */
export async function getCommandStripeMonthMovement(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const month = parseMovementMonth(req.query.month) ?? currentCommandMonth();
    const range = commandMonthRange(month);
    const cacheKey = `stripe-month-movement-v8:${month}`;
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command Stripe month movement");
      return;
    }

    const inMonth = { gte: range.start, lt: range.end };
    const eventSelect = {
      stripeSubscriptionId: true,
      stripeCustomerId: true,
      occurredAt: true,
    } as const;

    const [
      snapshots,
      records,
      createdEventRows,
      deletedEventRows,
      failedInvoiceRows,
      oldestRealEvent,
      userRows,
      businessRows,
      settledInvoiceRows,
      ghlTransactionRows,
    ] = await Promise.all([
      // Every subscription Stripe ever made, live or ended. Small — hundreds.
      prisma.commandStripeSubscriptionSnapshot.findMany({
        select: {
          stripeSubscriptionId: true,
          stripeCustomerId: true,
          userId: true,
          businessId: true,
          status: true,
          // For the churn call list: what the account was worth and what it was
          // on, so the list can be worked highest-value first.
          monthlyRecurringMinor: true,
          currency: true,
          stripePriceIds: true,
        },
      }),
      // Record dates, keyed by Stripe id. Only rows that reached Stripe at all
      // are useful here; a checkout that never converted has no Stripe id.
      prisma.subscription.findMany({
        where: { stripeSubscriptionId: { not: null } },
        select: {
          userId: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          startDate: true,
          canceledAt: true,
        },
      }),
      prisma.commandStripeSubscriptionEvent.findMany({
        where: { eventType: SUBSCRIPTION_CREATED_EVENT },
        select: eventSelect,
        orderBy: { occurredAt: "asc" },
      }),
      prisma.commandStripeSubscriptionEvent.findMany({
        where: { eventType: SUBSCRIPTION_DELETED_EVENT },
        select: eventSelect,
        orderBy: { occurredAt: "asc" },
      }),
      // Not scoped to the requested month: the month-on-month series below
      // needs the same rows, and every other read here is already unscoped, so
      // narrowing this one would cost a second round trip to no purpose.
      prisma.commandStripeInvoice.findMany({
        where: {
          status: { in: FAILED_INVOICE_STATUSES },
          attemptCount: { gt: 0 },
          amountRemainingMinor: { gt: 0 },
        },
        select: {
          stripeInvoiceId: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          userId: true,
          providerCreatedAt: true,
          // What Stripe is still owed, so a rep opens the call knowing the
          // amount rather than having to look it up mid-conversation.
          amountRemainingMinor: true,
          currency: true,
        },
      }),
      prisma.commandStripeSubscriptionEvent.findFirst({
        where: {
          eventType: { in: [SUBSCRIPTION_CREATED_EVENT, SUBSCRIPTION_DELETED_EVENT] },
        },
        select: { occurredAt: true },
        orderBy: { occurredAt: "asc" },
      }),
      // Every account, serving two purposes so it is one read rather than two:
      // `createdAt` gives the per-month signup count, and the contact fields
      // give the churn call list a name and a number to ring.
      //
      // Months are bucketed in Toronto here rather than by the database,
      // because a timezone-aware truncation is not portable through Prisma and
      // the arrivals beside it are already bucketed by the same helper — two
      // different month boundaries on one chart would be worse than this read.
      prisma.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          createdAt: true,
        },
      }),
      prisma.business.findMany({
        select: { id: true, businessName: true, businessPhone: true },
      }),
      // Every settled invoice, for the per-month collected figure. Subscription
      // invoices *and* one-off invoices: that is what makes the number "revenue
      // collected" rather than "subscription revenue", and it is why a manually
      // invoiced retainer appears here while never appearing in MRR.
      prisma.commandStripeInvoice.findMany({
        where: { status: "paid", paidAt: { not: null } },
        select: { paidAt: true, amountPaidMinor: true, currency: true },
      }),
      // GHL's own payments, so the month-on-month figure can show the whole
      // business rather than the half of it Stripe happens to hold. Amounts here
      // are **major** units — that difference is why they are converted rather
      // than added.
      prisma.commandGhlPaymentTransaction.findMany({
        where: { isActive: true, fulfilledAt: { not: null } },
        select: {
          amount: true,
          amountRefunded: true,
          currency: true,
          status: true,
          providerSubscriptionId: true,
          fulfilledAt: true,
        },
      }),
    ]);

    type EventRow = {
      stripeSubscriptionId: string;
      stripeCustomerId: string | null;
      occurredAt: Date;
    };
    /** Earliest wins: Stripe can deliver one logical event under two ids. */
    const earliestBySubscription = (rows: readonly EventRow[]) => {
      const earliest = new Map<string, Date>();
      for (const row of rows) {
        const current = earliest.get(row.stripeSubscriptionId);
        if (!current || row.occurredAt < current) {
          earliest.set(row.stripeSubscriptionId, row.occurredAt);
        }
      }
      return earliest;
    };
    const createdEvents = earliestBySubscription(createdEventRows);
    const deletedEvents = earliestBySubscription(deletedEventRows);
    const recordBySubscription = new Map(
      records.flatMap((row) =>
        row.stripeSubscriptionId ? [[row.stripeSubscriptionId, row] as const] : [],
      ),
    );

    /**
     * What we count by. Stripe's customer id where we have one, so these totals
     * agree with the roster's account count rather than quietly counting a
     * two-website customer twice.
     */
    const accountKeyFor = (input: {
      stripeCustomerId?: string | null;
      userId?: string | null;
      stripeSubscriptionId?: string | null;
    }): string =>
      input.stripeCustomerId
        ? `cus:${input.stripeCustomerId}`
        : input.userId
          ? `user:${input.userId}`
          : `sub:${input.stripeSubscriptionId ?? "unknown"}`;

    const starts: MovementFact[] = [];
    const cancellations: MovementFact[] = [];
    let undatableSubscriptions = 0;
    let undatedCancellations = 0;
    // An account is only genuinely missing from the series when *none* of its
    // subscriptions can be dated. Counting undatable subscriptions alone
    // overstates the gap badly: a two-website customer has one `Subscription`
    // row, so its second subscription is always undatable while the account
    // itself is already counted.
    const datableAccounts = new Set<string>();
    const undatableAccounts = new Set<string>();

    for (const snapshot of snapshots) {
      const record = recordBySubscription.get(snapshot.stripeSubscriptionId);
      const accountKey = accountKeyFor({
        stripeCustomerId: snapshot.stripeCustomerId ?? record?.stripeCustomerId,
        userId: snapshot.userId ?? record?.userId,
        stripeSubscriptionId: snapshot.stripeSubscriptionId,
      });

      const createdAt = createdEvents.get(snapshot.stripeSubscriptionId);
      if (createdAt) {
        starts.push({ accountKey, at: createdAt, source: "stripe_event" });
        datableAccounts.add(accountKey);
      } else if (record) {
        starts.push({
          accountKey,
          at: record.startDate,
          source: "subscription_record",
        });
        datableAccounts.add(accountKey);
      } else {
        undatableSubscriptions += 1;
        undatableAccounts.add(accountKey);
      }

      if (!MOVEMENT_ENDED_STATUSES.includes(snapshot.status)) continue;
      const deletedAt = deletedEvents.get(snapshot.stripeSubscriptionId);
      if (deletedAt) {
        cancellations.push({ accountKey, at: deletedAt, source: "stripe_event" });
      } else if (record?.canceledAt) {
        cancellations.push({
          accountKey,
          at: record.canceledAt,
          source: "subscription_record",
        });
      } else {
        undatedCancellations += 1;
      }
    }

    const failedInvoices: FailedInvoiceFact[] = failedInvoiceRows.map((row) => ({
      accountKey: accountKeyFor(row),
      stripeInvoiceId: row.stripeInvoiceId,
      at: row.providerCreatedAt,
      amountRemainingMinor: row.amountRemainingMinor.toFixed(0),
      currency: row.currency,
    }));

    const movement = buildMonthMovement({
      month,
      starts,
      cancellations,
      failedInvoices,
      undatedCancellations,
      eventLogStartsOn: oldestRealEvent
        ? commandDayForDate(oldestRealEvent.occurredAt)
        : null,
    });

    /**
     * Month on month, from the first month we can actually date back to.
     *
     * The start is discovered rather than configured: the series begins at the
     * oldest arrival any subscription can be dated to, so it extends itself as
     * history accumulates and never draws a run of leading zeros that reads as
     * "we sold nothing then". Capped so a stray 2019 date cannot turn this into
     * a hundred empty columns.
     */
    const firstArrivalMonth = earliestFactMonth(starts);
    const historyFrom =
      firstArrivalMonth &&
      commandMonthSpan(firstArrivalMonth, month).length <= MOVEMENT_HISTORY_MAX_MONTHS
        ? firstArrivalMonth
        : commandMonthsEndingAt(month, MOVEMENT_HISTORY_MAX_MONTHS).at(-1)!;
    /**
     * GHL payments, net of refunds, minus anything that is the same money twice.
     *
     * GHL settles through its own Stripe account, so in practice these are
     * separate payments from the ones our invoice table holds — measured on
     * production the duplicate count is zero. The exclusion stays because it is
     * the one thing that could turn a combined total into an overstatement, and
     * a rule that only matters occasionally still has to be there when it does.
     * Same rule the GHL revenue page already applies.
     */
    const knownSubscriptionIds = new Set(
      snapshots.map((snapshot) => snapshot.stripeSubscriptionId),
    );
    let ghlDuplicatesExcluded = 0;
    const ghlCollected = ghlTransactionRows.flatMap((row) => {
      if (!row.fulfilledAt || !row.amount || !row.currency) return [];
      if (!isSettledGhlPayment(row.status)) return [];
      if (
        row.providerSubscriptionId &&
        knownSubscriptionIds.has(row.providerSubscriptionId)
      ) {
        ghlDuplicatesExcluded += 1;
        return [];
      }
      const net = row.amount.sub(row.amountRefunded ?? new Prisma.Decimal(0));
      return [
        {
          at: row.fulfilledAt,
          currency: row.currency,
          amountMajor: net.toString(),
        },
      ];
    });

    const history = buildMovementHistory({
      from: historyFrom,
      to: month,
      starts,
      cancellations,
      failedInvoices,
      ghlCollected,
      signups: userRows.map((row) => ({ at: row.createdAt })),
      collected: settledInvoiceRows.flatMap((row) =>
        row.paidAt
          ? [
              {
                at: row.paidAt,
                currency: row.currency,
                amountMinor: row.amountPaidMinor.toFixed(0),
              },
            ]
          : [],
      ),
    });

    /**
     * Who to ring about this month's churn.
     *
     * The two tiles already counted cancellations and failed payments. A count
     * is not something a rep can act on, so the same facts are joined to a name,
     * a number and an amount — "43 cancelled" becomes forty-three conversations
     * someone can have today. One row per account, matching how the tiles count,
     * so the list and the number beside it cannot drift apart.
     */
    const businessById = new Map(businessRows.map((row) => [row.id, row]));
    const userById = new Map(userRows.map((row) => [row.id, row]));
    const upliftPlanNames = await getUpliftPlanDefinitions();
    const planNameByPriceId = new Map(
      upliftPlanNames.map((plan) => [plan.priceId, plan.name]),
    );
    const identities = new Map<string, ChurnIdentity>();
    for (const snapshot of snapshots) {
      const record = recordBySubscription.get(snapshot.stripeSubscriptionId);
      const accountKey = accountKeyFor({
        stripeCustomerId: snapshot.stripeCustomerId ?? record?.stripeCustomerId,
        userId: snapshot.userId ?? record?.userId,
        stripeSubscriptionId: snapshot.stripeSubscriptionId,
      });
      const user = snapshot.userId ? userById.get(snapshot.userId) : undefined;
      const business = snapshot.businessId
        ? businessById.get(snapshot.businessId)
        : undefined;
      const existing = identities.get(accountKey);
      /**
       * A number to ring, and which number it is.
       *
       * Same order as the subscriber roster: the person first, the business line
       * as the fallback. Many signups leave no personal number, and for a call
       * list a business line is far better than "no number" — but a rep should
       * know a receptionist may answer before the call connects, so the source
       * travels with it rather than being inferred later.
       */
      const phone = user?.phone ?? business?.businessPhone ?? null;
      const phoneSource: "user" | "business" | null = user?.phone
        ? "user"
        : business?.businessPhone
          ? "business"
          : null;
      // An account can hold several subscriptions. Keep the dearest one's value
      // and plan, so a customer who also had a cheap add-on is not ranked by
      // the add-on.
      const value = snapshot.monthlyRecurringMinor.toFixed(0);
      const dearer =
        existing?.mrrMinor === undefined ||
        existing.mrrMinor === null ||
        Number(value) > Number(existing.mrrMinor);
      identities.set(accountKey, {
        stripeCustomerId: snapshot.stripeCustomerId ?? existing?.stripeCustomerId ?? null,
        name: user?.name ?? existing?.name ?? null,
        email: user?.email ?? existing?.email ?? null,
        phone: phone ?? existing?.phone ?? null,
        phoneSource: phone ? phoneSource : (existing?.phoneSource ?? null),
        businessName: business?.businessName ?? existing?.businessName ?? null,
        planName: dearer
          ? (snapshot.stripePriceIds
              .map((priceId) => planNameByPriceId.get(priceId))
              .find((name): name is string => Boolean(name)) ?? null)
          : (existing?.planName ?? null),
        mrrMinor: dearer ? value : existing?.mrrMinor,
        currency: dearer ? snapshot.currency : existing?.currency,
      });
    }
    const churnList = buildChurnCallList({
      month,
      cancellations,
      failedInvoices,
      identities,
    });

    const payload = {
      ...movement,
      history,
      churnList,
      coverage: {
        ...movement.coverage,
        /** GHL rows dropped as the same payment Stripe already reported. */
        ghlDuplicatesExcluded,
        /**
         * The first month any GHL payment exists for.
         *
         * The table holds nothing before 2026-07, so the combined figure for
         * every month before that is Stripe alone — and a reader has no way to
         * tell "GHL earned nothing" from "we have no GHL records" unless the
         * panel says which. Same reason `eventLogStartsOn` exists for the
         * webhook log.
         */
        ghlCollectedFromMonth: earliestFactMonth(ghlCollected),
        /** GHL rows whose amount was finer than its currency's minor unit. */
        ghlAmountsSkipped: history.ghlAmountsSkipped,
        knownSubscriptions: snapshots.length,
        undatableSubscriptions,
        /** Accounts with no datable subscription at all — the real blind spot. */
        undatableAccounts: [...undatableAccounts].filter(
          (key) => !datableAccounts.has(key),
        ).length,
      },
    };

    await writeCommandCache(cacheKey, payload, 120);
    sendSuccess(res, payload, "Command Stripe month movement");
  } catch (error: unknown) {
    sendError(res, "Failed to load Stripe month movement", 500, error);
  }
}
