import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import { readCommandCache, writeCommandCache } from "../utils/command-cache";
import {
  commandMonthRange,
  commandMonthsEndingAt,
  currentCommandMonth,
} from "../command/toronto-period";
import { calculateLifetimeValueFromCohorts } from "../command/lifetime-value";
import { Prisma } from "@prisma/client";
import { upliftPriceSets } from "../command/uplift-prices";
import {
  buildCohorts,
  buildCustomerPaymentHistories,
  summariseChurn,
  FULL_PRICE_SHARE,
} from "../command/paying-churn";

/**
 * Churn among customers who actually paid.
 *
 * Its own endpoint rather than another block on the overview, which already
 * runs thirty aggregations and computes the whole Command payload. Adding this
 * there would put the main dashboard at risk for a metric only one card reads —
 * and a change to that endpoint took it down earlier today, which is the
 * argument made concretely.
 *
 * Two reads, both of facts rather than inferences: every settled invoice, and
 * every subscription's current status. That is deliberately all it needs. The
 * monthly churn series this exists to replace depends on a Stripe event log
 * that only begins on 2026-08-18, and on cancellation dates that are inferred
 * for everything before it.
 */

/** A minute, matching the rest of the Command surface. */
const CACHE_TTL_SECONDS = 60;

export async function getCommandPayingChurn(
  req: Request,
  res: Response,
): Promise<void> {
  const upliftOnly = req.query.scope !== "all";
  const cacheKey = `paying-churn-v1:${upliftOnly ? "uplift" : "all"}`;
  try {
    const cached = await readCommandCache<unknown>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command paying churn");
      return;
    }

    const prices = upliftPriceSets();
    const upliftPriceIds = [
      ...prices.corePriceIds,
      ...prices.socialPriceIds,
    ];

    /**
     * The last complete month, for the margin behind lifetime value.
     *
     * Not the current one, which is partial, and not a trailing blend: July's
     * delivery cost was fourteen times August's after the model migration, so
     * blending reports a margin for a cost structure no longer in force.
     */
    const currentMonthKey = currentCommandMonth();
    const marginMonth = commandMonthsEndingAt(currentMonthKey, 2)[1]!;
    const marginWindow = commandMonthRange(marginMonth);

    const [invoices, subscriptions, marginDeliveryCosts] = await Promise.all([
      /**
       * Every settled invoice, narrowly selected.
       *
       * No date floor: the whole point is the oldest cohort, and a floor would
       * silently cap the lifetime this can observe.
       */
      prisma.commandStripeInvoice.findMany({
        where: { status: "paid", paidAt: { not: null } },
        select: {
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          amountPaidMinor: true,
          paidAt: true,
          currency: true,
        },
      }),
      prisma.commandStripeSubscriptionSnapshot.findMany({
        select: {
          stripeSubscriptionId: true,
          stripeCustomerId: true,
          status: true,
          monthlyRecurringMinor: true,
          currency: true,
          stripePriceIds: true,
          pauseCollectionBehavior: true,
        },
      }),
      /**
       * The only extra read lifetime value needs. Everything else it wants —
       * recurring revenue, collections, the paying customer count — is already
       * in memory from the two reads above.
       */
      prisma.commandCostEntry.groupBy({
        by: ["currency"],
        where: {
          deletedAt: null,
          category: "delivery",
          occurredAt: { gte: marginWindow.start, lt: marginWindow.end },
        },
        _sum: { amountMinor: true },
      }),
    ]);

    /**
     * Restricted to Uplift product plans by default, so this reconciles with
     * the snapshot card that reads it. `scope=all` lifts it, which is worth
     * having: the difference is what agency retainers do to the figure.
     *
     * Falls back to every subscription when no price ids are configured, rather
     * than reporting an empty book as perfect retention.
     */
    const upliftSubscriptionIds = new Set(
      upliftPriceIds.length > 0
        ? subscriptions
            .filter((row) =>
              row.stripePriceIds.some((priceId) =>
                upliftPriceIds.includes(priceId),
              ),
            )
            .map((row) => row.stripeSubscriptionId)
        : subscriptions.map((row) => row.stripeSubscriptionId),
    );
    const scoped = upliftOnly && upliftPriceIds.length > 0;
    const consideredSubscriptions = scoped
      ? subscriptions.filter((row) =>
          upliftSubscriptionIds.has(row.stripeSubscriptionId),
        )
      : subscriptions;
    const consideredInvoices = scoped
      ? invoices.filter(
          (row) =>
            row.stripeSubscriptionId !== null &&
            upliftSubscriptionIds.has(row.stripeSubscriptionId),
        )
      : invoices;

    const currentMonth = currentMonthKey;
    const histories = buildCustomerPaymentHistories({
      invoices: consideredInvoices,
      subscriptions: consideredSubscriptions,
    });
    const fullPriceHistories = histories.filter((row) => row.reachedFullPrice);

    const allCohorts = buildCohorts({ histories, currentMonth });
    const fullPriceCohorts = buildCohorts({
      histories: fullPriceHistories,
      currentMonth,
    });

    /**
     * Lifetime value, owned here because this is where the churn is measured.
     *
     * The overview used to compute its own from two churn estimates that
     * disagreed sixfold — a monthly series distorted by an incomplete event log,
     * and a cumulative rate spread across the months of trading. Both are
     * superseded by the cohort survival above, and leaving the old block in
     * place would have left two sources of one number free to drift apart.
     *
     * Uplift plans only and per customer, matching the card that reads it.
     */
    const fullPriceSummary = summariseChurn({
      histories: fullPriceHistories,
      cohorts: fullPriceCohorts,
    });
    /**
     * Recurring revenue from exactly the customers the denominator counts.
     *
     * The first version divided *all* live recurring revenue by full-price
     * paying customers only, which is two different populations either side of
     * the divide: the numerator carried trialing subscriptions, failing cards
     * and customers who never reached full price, the denominator did not. It
     * reported ARPU of $167.69 where the honest figure is nearer $130, and ARPU
     * is a direct multiplier on lifetime value.
     *
     * Both sides now come from the same set: customers who reached full price
     * and are collecting today.
     */
    const payingFullPriceCustomerIds = new Set(
      fullPriceHistories
        .filter((history) => history.state === "paying")
        .map((history) => history.stripeCustomerId),
    );
    const liveMrrByCurrency = new Map<string, Prisma.Decimal>();
    const payingCustomerIdsByCurrency = new Map<string, Set<string>>();
    for (const row of consideredSubscriptions) {
      if (!row.currency || !row.stripeCustomerId) continue;
      if (row.status !== "active") continue;
      if (row.pauseCollectionBehavior !== null) continue;
      if (!payingFullPriceCustomerIds.has(row.stripeCustomerId)) continue;
      const key = row.currency.toLowerCase();
      liveMrrByCurrency.set(
        key,
        (liveMrrByCurrency.get(key) ?? new Prisma.Decimal(0)).add(
          row.monthlyRecurringMinor,
        ),
      );
      const customers =
        payingCustomerIdsByCurrency.get(key) ?? new Set<string>();
      customers.add(row.stripeCustomerId);
      payingCustomerIdsByCurrency.set(key, customers);
    }
    const marginCollectedByCurrency = new Map<string, Prisma.Decimal>();
    for (const invoice of consideredInvoices) {
      if (!invoice.paidAt) continue;
      if (invoice.paidAt < marginWindow.start || invoice.paidAt >= marginWindow.end) {
        continue;
      }
      const key = invoice.currency.toLowerCase();
      marginCollectedByCurrency.set(
        key,
        (marginCollectedByCurrency.get(key) ?? new Prisma.Decimal(0)).add(
          invoice.amountPaidMinor,
        ),
      );
    }
    const marginDeliveryByCurrency = new Map<string, Prisma.Decimal>();
    for (const row of marginDeliveryCosts) {
      const key = (row.currency ?? "").toLowerCase();
      if (!key) continue;
      marginDeliveryByCurrency.set(
        key,
        (marginDeliveryByCurrency.get(key) ?? new Prisma.Decimal(0)).add(
          row._sum.amountMinor ?? 0,
        ),
      );
    }
    const lifetimeValueByCurrency = Object.fromEntries(
      [...liveMrrByCurrency.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, mrr]) => [
          currency,
          calculateLifetimeValueFromCohorts({
            mrrMinor: mrr,
            payingCustomers:
              payingCustomerIdsByCurrency.get(currency)?.size ?? 0,
            collectedMinor:
              marginCollectedByCurrency.get(currency) ?? new Prisma.Decimal(0),
            deliveryCostMinor:
              marginDeliveryByCurrency.get(currency) ?? new Prisma.Decimal(0),
            floorMonths: fullPriceSummary.observedLifetimeMonths,
            expectedMonths: fullPriceSummary.impliedLifetimeMonths,
            monthlyChurnPercent: fullPriceSummary.impliedMonthlyChurnPercent,
            observedThroughMonths: fullPriceSummary.oldestCohortAgeMonths,
            marginMonth,
          }),
        ]),
    );

    const payload = {
      asOf: new Date().toISOString(),
      currentMonth,
      timeZone: "America/Toronto",
      scope: scoped ? "uplift_plans" : "all_subscriptions",
      definition: {
        payer:
          "A customer with at least one settled invoice above zero. Cohort month is that first payment.",
        fullPricePayer: `A payer whose largest settled invoice reached ${Math.round(FULL_PRICE_SHARE * 100)}% of their plan's monthly price, or who settled more than one invoice when no live plan remains to compare against.`,
        stillPaying:
          "Holds a subscription Stripe reports as active. A past-due card is reported separately as at risk, because it is neither paying nor certainly lost.",
        method:
          "Cohort survival read at today's date, from settled invoices and current subscription status. Nothing is inferred from the event log, so nothing depends on when that log begins.",
        arpuPopulation:
          "Recurring revenue from customers who reached full price and are collecting today, divided by that same count. Narrower than the snapshot's ARPU, which spreads all recurring revenue across every paying subscription.",
        caveat:
          "Each cohort's survival is observed once, now, so age and cohort quality are entangled: March's customers differ from August's in more than age. Lifetime is summed only across ages actually observed, never extrapolated.",
      },
      /**
       * Lifetime value, from the full-price cohorts above. Owned here so one
       * place computes it and the snapshot card cannot disagree with it.
       */
      lifetimeValue: {
        byCurrency: lifetimeValueByCurrency,
        marginMonth,
        observedThroughMonths: fullPriceSummary.oldestCohortAgeMonths,
      },
      /** The population lifetime value should read. */
      fullPricePayers: {
        summary: fullPriceSummary,
        cohorts: fullPriceCohorts,
      },
      /** Everyone who ever paid anything, trials included. */
      allPayers: {
        summary: summariseChurn({ histories, cohorts: allCohorts }),
        cohorts: allCohorts,
      },
      coverage: {
        settledInvoices: consideredInvoices.length,
        subscriptions: consideredSubscriptions.length,
        /**
         * Payers who never reached full price. The gap between the two curves
         * is how much of the apparent churn is trial washout rather than
         * customers leaving.
         */
        trialOnlyPayers: histories.length - fullPriceHistories.length,
      },
    };

    await writeCommandCache(cacheKey, payload, CACHE_TTL_SECONDS);
    sendSuccess(res, payload, "Command paying churn");
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "command-paying-churn",
        event: "paying_churn_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    sendError(res, "Failed to measure paying churn", 500);
  }
}
