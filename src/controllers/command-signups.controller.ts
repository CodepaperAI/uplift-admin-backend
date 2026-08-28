import type { Request, Response } from "express";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import { readCommandCache, writeCommandCache } from "../utils/command-cache";
import {
  commandDayForDate,
  commandDayRange,
  COMMAND_TIME_ZONE,
} from "../command/toronto-period";
import {
  buildDailySignups,
  type SignupSubscriptionFact,
} from "../command/daily-signups";
import { classifyCountry, tallySegments } from "../command/signup-segments";
import { upliftPriceSets } from "../command/uplift-prices";
import type { InvoiceFact } from "../command/entry-path";

/**
 * One day's signups, with the money state attached, for a call list.
 *
 * Scoped to a single Toronto day on purpose. "Who came in today and has anyone
 * paid" is a question a rep asks once each morning and then acts on, and a range
 * filter would turn a worklist into a report.
 */

const LIVE_STATUSES = ["trialing", "active", "past_due"];

/**
 * How many signups the list itself will carry.
 *
 * Counts are computed over the whole range; only the rows are capped. Six months
 * reaches nearly the entire user base, and a table of several thousand rows is
 * not a call list — it is a page that takes seconds to render and that nobody
 * reads to the end. The cap is reported so a truncated list never passes for a
 * complete one.
 */
const SIGNUP_ROW_CAP = 500;

/** A day or a span of them, defaulting to today in Toronto. */
function parseSignupRange(query: Request["query"]) {
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  const today = commandDayForDate(new Date());
  // `date` stays supported: it is what the single-day links already carry.
  const single = text(query.date);
  const from = single ?? text(query.from) ?? today;
  const to = single ?? text(query.to) ?? today;
  try {
    const range = commandDayRange(from, to);
    if (range.dayCount > 400) {
      return {
        error: new Error("Range cannot exceed 400 days"),
      } as const;
    }
    return { range } as const;
  } catch (error) {
    return { error } as const;
  }
}

export async function getCommandDailySignups(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const parsed = parseSignupRange(req.query);
    if ("error" in parsed) {
      sendError(res, "Invalid date range", 400, parsed.error);
      return;
    }
    const { range } = parsed;
    const stageFilter = typeof req.query.stage === "string" ? req.query.stage : null;
    const planFilter = typeof req.query.plan === "string" ? req.query.plan : null;
    const countryFilter =
      typeof req.query.country === "string" ? req.query.country : null;

    /**
     * The filters are part of the key, because the response is filtered.
     *
     * They were not, and the two directions of that are both wrong: a filtered
     * request served the unfiltered payload from cache — which is how a page
     * asking for `stage=churned` came back with 500 unfiltered rows and
     * `appliedFilters.stage: null` — and, worse, a filtered request landing
     * first would serve its narrow list to every unfiltered reader for the next
     * minute.
     */
    const cacheKey = [
      "command-signups-v5",
      range.from,
      range.to,
      stageFilter ?? "-",
      planFilter ?? "-",
      countryFilter ?? "-",
    ].join(":");
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command daily signups");
      return;
    }

    const where = {
      createdAt: { gte: range.start, lt: range.end },
      // Staff accounts are not leads. Without this the list would tell a rep
      // to ring their own colleagues.
      role: "USER" as const,
    };
    /**
     * Every signup in the range, newest first — ids and contact fields only.
     *
     * Loaded in full rather than capped because the state counts have to cover
     * the whole range. Capping here is what made "Paid 15" identical for 30
     * days, 90 days and 6 months: the newest 500 rows are the same 500 in all
     * three, so the counts stopped moving while the headline kept growing. The
     * *table* is still capped further down; the counts no longer are.
     *
     * The fields are small and this is one indexed query with no joins, so at
     * the current book — a couple of thousand rows — it is cheaper than the
     * second count query it replaces.
     */

    const rangeUsers = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    const signupsInRange = rangeUsers.length;
    const users = rangeUsers.slice(0, SIGNUP_ROW_CAP);

    if (users.length === 0) {
      const empty = {
        day: {
          date: range.from,
          from: range.from,
          to: range.to,
          dayCount: range.dayCount,
          start: range.start.toISOString(),
          endExclusive: range.end.toISOString(),
          timeZone: COMMAND_TIME_ZONE,
        },
        signupsInRange: 0,
        rowCap: SIGNUP_ROW_CAP,
        truncated: false,
        rows: [],
        totals: {
          signups: 0,
          paid: 0,
          trial: 0,
          discounted: 0,
          pending: 0,
          cancelled: 0,
          none: 0,
          reachable: 0,
        },
      };
      await writeCommandCache(cacheKey, empty, 60);
      sendSuccess(res, empty, "Command daily signups");
      return;
    }

    const userIds = users.map((user) => user.id);
    const rangeUserIds = new Set(rangeUsers.map((user) => user.id));
    const [businesses, allBusinessCountries, allSnapshots, appSubscriptions] =
      await Promise.all([
      prisma.business.findMany({
        where: { userId: { in: userIds } },
        select: {
          userId: true,
          businessName: true,
          businessWebsiteUrl: true,
          businessCountry: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      // Country for every business, two small columns and no where clause.
      // The country segment has to cover the whole range — it is the one
      // dimension that means something for people who never paid — and the
      // full business list is smaller than the id list needed to filter it.
      prisma.business.findMany({
        select: { userId: true, businessCountry: true },
      }),
      // Every snapshot, not just the table's page. The table is a few hundred
      // rows at most, and filtering it in memory against the range beats
      // sending a couple of thousand ids to the database.
      prisma.commandStripeSubscriptionSnapshot.findMany({
        select: {
          userId: true,
          status: true,
          monthlyRecurringMinor: true,
          currency: true,
          stripeSubscriptionId: true,
          currentPeriodEnd: true,
          stripePriceIds: true,
        },
      }),
      // The plan name lives on the app's own record, not on the Stripe snapshot.
      prisma.subscription.findMany({
        where: { userId: { in: userIds } },
        select: { stripeSubscriptionId: true, planName: true },
      }),
    ]);

    // Subscriptions belonging to somebody who signed up inside the range.
    const snapshots = allSnapshots.filter(
      (row) => row.userId && rangeUserIds.has(row.userId),
    );
    const subscriptionIds = snapshots.map((row) => row.stripeSubscriptionId);
    const invoices = subscriptionIds.length
      ? await prisma.commandStripeInvoice.findMany({
          where: { stripeSubscriptionId: { in: subscriptionIds } },
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

    const businessesByUser = new Map<
      string,
      {
        businessName: string;
        businessWebsiteUrl: string;
        businessCountry: string | null;
      }[]
    >();
    const coveredBusinessUserIds = new Set(userIds);
    for (const business of businesses) {
      const list = businessesByUser.get(business.userId) ?? [];
      list.push({
        businessName: business.businessName,
        businessWebsiteUrl: business.businessWebsiteUrl,
        businessCountry: business.businessCountry,
      });
      businessesByUser.set(business.userId, list);
    }

    /**
     * Business details for subscription-holders that the capped page missed.
     *
     * `businesses` above is scoped to the newest 500 signups, and the rows the
     * filters actually need are the subscription-holders — who, on a busy range,
     * are mostly older than that. Without this top-up a churned row comes back
     * with no business name, no site and no country, which is precisely the row
     * a rep is trying to act on.
     *
     * Skipped entirely unless the cap bit, and even then it is a handful of ids:
     * subscription-holders in range number in the tens, not the thousands.
     */
    const capBit = signupsInRange > users.length;
    const uncoveredSubscribedIds = capBit
      ? [...new Set(snapshots.flatMap((row) => (row.userId ? [row.userId] : [])))]
          .filter((id) => rangeUserIds.has(id) && !coveredBusinessUserIds.has(id))
      : [];
    if (uncoveredSubscribedIds.length > 0) {
      const extra = await prisma.business.findMany({
        where: { userId: { in: uncoveredSubscribedIds } },
        select: {
          userId: true,
          businessName: true,
          businessWebsiteUrl: true,
          businessCountry: true,
        },
        orderBy: { createdAt: "asc" },
      });
      for (const business of extra) {
        const list = businessesByUser.get(business.userId) ?? [];
        list.push({
          businessName: business.businessName,
          businessWebsiteUrl: business.businessWebsiteUrl,
          businessCountry: business.businessCountry,
        });
        businessesByUser.set(business.userId, list);
      }
    }

    const subscriptionsByUser = new Map<string, SignupSubscriptionFact[]>();
    for (const snapshot of snapshots) {
      if (!snapshot.userId) continue;
      const list = subscriptionsByUser.get(snapshot.userId) ?? [];
      list.push(snapshot as SignupSubscriptionFact);
      subscriptionsByUser.set(snapshot.userId, list);
    }

    const invoicesBySubscription = new Map<string, InvoiceFact[]>();
    for (const invoice of invoices) {
      if (!invoice.stripeSubscriptionId) continue;
      const list = invoicesBySubscription.get(invoice.stripeSubscriptionId) ?? [];
      list.push(invoice as InvoiceFact);
      invoicesBySubscription.set(invoice.stripeSubscriptionId, list);
    }

    const planNameBySubscription = new Map(
      appSubscriptions.flatMap((row) =>
        row.stripeSubscriptionId
          ? ([[row.stripeSubscriptionId, row.planName]] as const)
          : [],
      ),
    );

    const prices = upliftPriceSets();
    const { rows } = buildDailySignups({
      users,
      businessesByUser,
      subscriptionsByUser,
      invoicesBySubscription,
      planNameBySubscription,
      socialPriceIds: prices.socialPriceIds,
      annualPriceIds: prices.annualPriceIds,
    });

    /**
     * State counts over the whole range.
     *
     * Only signups that actually hold a subscription need classifying, and
     * across the entire book that is a couple of hundred people — so this runs
     * over that subset and derives `none` by subtraction rather than
     * classifying two thousand accounts that have no subscription to classify.
     */
    const subscribedRangeUsers = rangeUsers.filter((user) =>
      subscriptionsByUser.has(user.id),
    );
    const classified = buildDailySignups({
      users: subscribedRangeUsers,
      businessesByUser,
      subscriptionsByUser,
      invoicesBySubscription,
      planNameBySubscription,
      socialPriceIds: prices.socialPriceIds,
      annualPriceIds: prices.annualPriceIds,
    });
    const totals = {
      ...classified.totals,
      signups: signupsInRange,
      none: signupsInRange - subscribedRangeUsers.length,
      // Reachability is a property of the whole range, not of the loaded page:
      // it is what a rep can actually work through.
      reachable: rangeUsers.filter((user) => (user.phone ?? "").trim() !== "")
        .length,
    };

    /**
     * Filter first, cap second. The other way round is a lie.
     *
     * `rows` covers the newest 500 signups in the range and `classified.rows`
     * covers every signup that holds a subscription, uncapped — so the two
     * together are every row that could possibly match a stage or plan filter,
     * because a signup with no subscription can only ever be `signed_up` /
     * `none`.
     *
     * It used to filter `rows` alone, which meant the cap discarded candidates
     * before the filter ever saw them. That is not a rounding error on a busy
     * range, it is systematically worst for exactly the segment worth looking
     * at: churn is old by construction — you sign up, then cancel days later —
     * so churned rows sit at the bottom of a newest-first list and are the first
     * thing a cap throws away. Measured on a 7-day range of 625 signups: the
     * pill said 5 churned and the list could show none of them.
     */
    const byUserId = new Map<string, (typeof rows)[number]>();
    for (const row of [...classified.rows, ...rows]) {
      // Identical for a user in both sets — same builder, same maps — so first
      // write wins and the uncapped set is preferred.
      if (!byUserId.has(row.userId)) byUserId.set(row.userId, row);
    }
    const matching = [...byUserId.values()]
      .filter(
        (row) =>
          (stageFilter === null || row.stage === stageFilter) &&
          (planFilter === null || row.planTag === planFilter) &&
          (countryFilter === null || row.country === countryFilter),
      )
      // Newest first, as the table promises. Merging two sorted lists does not
      // preserve the order, so it is restored here rather than assumed.
      .sort((left, right) => right.signedUpAt.localeCompare(left.signedUpAt));

    const payload = {
      day: {
        date: range.from,
        from: range.from,
        to: range.to,
        dayCount: range.dayCount,
        start: range.start.toISOString(),
        endExclusive: range.end.toISOString(),
        timeZone: COMMAND_TIME_ZONE,
      },
      rows: matching.slice(0, SIGNUP_ROW_CAP),
      /**
       * How many rows match in the whole range, before the cap. The panel needs
       * this to say "5 of 5" honestly instead of reporting the length of what it
       * happens to be holding.
       */
      matchingInRange: matching.length,
      appliedFilters: {
        stage: stageFilter,
        plan: planFilter,
        country: countryFilter,
      },
      totals,
      /**
       * Signups in the whole range, which is what the headline should say.
       * `totals.signups` counts the rows actually loaded, so on a long range the
       * two differ and the panel has to show this one.
       */
      signupsInRange,
      rowCap: SIGNUP_ROW_CAP,
      /**
       * True when the range holds more signups than the page carries. Derived
       * from the *unfiltered* page, not from the returned rows: with a filter
       * applied the returned list is legitimately short, and calling that
       * truncated would put a warning on a complete answer.
       */
      truncated: capBit,
      /**
       * Stage, plan and country counts over the whole range.
       *
       * The subscription-holding subset is classified properly; everyone else
       * is a `signed_up` row with no plan, so they are added in rather than run
       * through the classifier. Country needs the whole range though — it is
       * the one segment that means something for people who never paid — so
       * those rows are built for it.
       */
      segments: (() => {
        const countryByUser = new Map<string, string | null>();
        for (const row of allBusinessCountries) {
          const existing = countryByUser.get(row.userId);
          // First non-empty wins; a business with no country set is not an
          // answer, so keep looking through that user's other businesses.
          if (!existing && (row.businessCountry ?? "").trim()) {
            countryByUser.set(row.userId, row.businessCountry);
          }
        }
        const subscribedIds = new Set(
          classified.rows.map((row) => row.userId),
        );
        // Everyone without a subscription is the same shape — signed up, no
        // plan — so they are counted directly rather than pushed back through
        // the classifier that would only tell us that again.
        const unsubscribed = rangeUsers
          .filter((user) => !subscribedIds.has(user.id))
          .map((user) => ({
            stage: "signed_up" as const,
            planTag: "none" as const,
            country: classifyCountry({
              businessCountry: countryByUser.get(user.id) ?? null,
              phone: user.phone,
            }).country,
          }));
        return tallySegments([...classified.rows, ...unsubscribed]);
      })(),
      /**
       * Live subscription count for the same users, so the panel can say when
       * its own state derivation and the raw Stripe state disagree rather than
       * quietly presenting one of them.
       */
      liveSubscriptionCount: snapshots.filter((row) =>
        LIVE_STATUSES.includes(row.status),
      ).length,
    };

    // Short TTL: this is the one panel someone refreshes waiting for a signup.
    await writeCommandCache(cacheKey, payload, 60);
    sendSuccess(res, payload, "Command daily signups");
  } catch (error: unknown) {
    sendError(res, "Failed to load daily signups", 500, error);
  }
}
