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
    const cacheKey = `command-signups-v2:${range.from}:${range.to}`;
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
    const [signupsInRange, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: SIGNUP_ROW_CAP,
      }),
    ]);

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
    const [businesses, snapshots, appSubscriptions] = await Promise.all([
      prisma.business.findMany({
        where: { userId: { in: userIds } },
        select: {
          userId: true,
          businessName: true,
          businessWebsiteUrl: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.commandStripeSubscriptionSnapshot.findMany({
        where: { userId: { in: userIds } },
        select: {
          userId: true,
          status: true,
          monthlyRecurringMinor: true,
          currency: true,
          stripeSubscriptionId: true,
          currentPeriodEnd: true,
        },
      }),
      // The plan name lives on the app's own record, not on the Stripe snapshot.
      prisma.subscription.findMany({
        where: { userId: { in: userIds } },
        select: { stripeSubscriptionId: true, planName: true },
      }),
    ]);

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
      { businessName: string; businessWebsiteUrl: string }[]
    >();
    for (const business of businesses) {
      const list = businessesByUser.get(business.userId) ?? [];
      list.push({
        businessName: business.businessName,
        businessWebsiteUrl: business.businessWebsiteUrl,
      });
      businessesByUser.set(business.userId, list);
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

    const { rows, totals } = buildDailySignups({
      users,
      businessesByUser,
      subscriptionsByUser,
      invoicesBySubscription,
      planNameBySubscription,
    });

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
      rows,
      totals,
      /**
       * Signups in the whole range, which is what the headline should say.
       * `totals.signups` counts the rows actually loaded, so on a long range the
       * two differ and the panel has to show this one.
       */
      signupsInRange,
      rowCap: SIGNUP_ROW_CAP,
      truncated: signupsInRange > rows.length,
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
