import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import { readCommandCache, writeCommandCache } from "../utils/command-cache";
import { currentCommandMonth } from "../command/toronto-period";
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

    const [invoices, subscriptions] = await Promise.all([
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
        },
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

    const currentMonth = currentCommandMonth();
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
        caveat:
          "Each cohort's survival is observed once, now, so age and cohort quality are entangled: March's customers differ from August's in more than age. Lifetime is summed only across ages actually observed, never extrapolated.",
      },
      /** The population lifetime value should read. */
      fullPricePayers: {
        summary: summariseChurn({
          histories: fullPriceHistories,
          cohorts: fullPriceCohorts,
        }),
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
