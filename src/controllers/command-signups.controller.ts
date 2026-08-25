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

/** A day, defaulting to today in Toronto. */
function parseSignupDay(query: Request["query"]) {
  const raw =
    typeof query.date === "string" && query.date.trim() !== ""
      ? query.date.trim()
      : commandDayForDate(new Date());
  try {
    return { range: commandDayRange(raw, raw) } as const;
  } catch (error) {
    return { error } as const;
  }
}

export async function getCommandDailySignups(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const parsed = parseSignupDay(req.query);
    if ("error" in parsed) {
      sendError(res, "Invalid date", 400, parsed.error);
      return;
    }
    const { range } = parsed;
    const cacheKey = `command-signups-v1:${range.from}`;
    const cached = await readCommandCache<Record<string, unknown>>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, "Command daily signups");
      return;
    }

    const users = await prisma.user.findMany({
      where: {
        createdAt: { gte: range.start, lt: range.end },
        // Staff accounts are not leads. Without this the list would tell a rep
        // to ring their own colleagues.
        role: "USER",
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    if (users.length === 0) {
      const empty = {
        day: {
          date: range.from,
          start: range.start.toISOString(),
          endExclusive: range.end.toISOString(),
          timeZone: COMMAND_TIME_ZONE,
        },
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
        start: range.start.toISOString(),
        endExclusive: range.end.toISOString(),
        timeZone: COMMAND_TIME_ZONE,
      },
      rows,
      totals,
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
