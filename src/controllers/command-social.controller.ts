import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { sendError, sendSuccess } from "../utils/response.utils";
import {
  commandDayForDate,
  commandDayRange,
  shiftCommandDay,
} from "../command/toronto-period";
import {
  commandPaginationResult,
  parseCommandPagination,
} from "../command/pagination";
import {
  parseSocialPlatformFilter,
  parseSocialStatusFilter,
  previewCaption,
  rollUpSocialClients,
  rollUpSocialPlatforms,
  summariseAttemptStatuses,
  SOCIAL_ATTEMPT_STATUSES,
  type SocialClientIdentity,
} from "../command/social-posts";

/**
 * Which clients are posting socially, and every post that went out.
 *
 * This is the feed the Product Analysis "Social posts" tab was written around.
 * That tab shipped as an explanation of a gap, and the explanation ended on an
 * open question: does Uplift publish socially through its own pipeline, or
 * through GoHighLevel? Its own pipeline. `social_publish_attempt` holds one row
 * per attempt to place a post on a client's account, carrying the platform, the
 * target account, the client, the schedule, the outcome and the public URL —
 * exactly the row the tab asked for, in the database this service already reads.
 *
 * Modelled on attempts rather than on published posts. A feed of successes only
 * would answer "what went out" while hiding "what was supposed to go out and did
 * not", and the second question is the one that costs a client. Failures and
 * cancellations are rows here, with their provider error attached.
 *
 * The rollups cover the whole range; only the feed itself is paginated, so the
 * per-client and per-platform figures never depend on which page is open.
 */

/** A window wide enough to be useful, narrow enough to stay one screen. */
const DEFAULT_RANGE_DAYS = 30;

/** How far back a single request may reach. */
const MAX_RANGE_DAYS = 400;

/**
 * A ceiling on the per-client rollup.
 *
 * One row per client that posted in the window; the paying base is a few hundred
 * so this is generous, and it is reported when it bites so a truncated list
 * never passes for the whole roster.
 */
const CLIENT_ROW_CAP = 500;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * The requested window, defaulting to the last thirty Toronto days.
 *
 * Days rather than instants, and Toronto rather than UTC, because every other
 * date on the panel is a Toronto day and a feed that disagreed with the range
 * label above it would be read as missing posts.
 */
function parseRange(query: Request["query"]): {
  from: string;
  to: string;
  start: Date;
  end: Date;
  dayCount: number;
} {
  const today = commandDayForDate(new Date());
  const to = text(query.to) ?? today;
  const from = text(query.from) ?? shiftCommandDay(to, -(DEFAULT_RANGE_DAYS - 1));
  return commandDayRange(from, to);
}

export async function getCommandSocialPosts(
  req: Request,
  res: Response,
): Promise<void> {
  let range: ReturnType<typeof parseRange>;
  try {
    range = parseRange(req.query);
  } catch {
    sendError(res, "Invalid date range. Use from and to as YYYY-MM-DD.", 400);
    return;
  }
  if (range.dayCount > MAX_RANGE_DAYS) {
    sendError(res, `Date range must not exceed ${MAX_RANGE_DAYS} days.`, 400);
    return;
  }

  const status = parseSocialStatusFilter(req.query.status);
  const platform = parseSocialPlatformFilter(req.query.platform);
  const client = text(req.query.client);
  const { page, pageSize, skip } = parseCommandPagination({
    page: req.query.page,
    pageSize: req.query.pageSize,
    defaultPageSize: 50,
    maxPageSize: 200,
  });

  /**
   * The client filter searches the business and its owner, because the row the
   * reader clicked through from might have shown either. Case-insensitive
   * contains on both, which is what every other search box on the panel does.
   */
  const clientWhere: Prisma.SocialPublishAttemptWhereInput | null = client
    ? {
        business: {
          OR: [
            { businessName: { contains: client, mode: "insensitive" } },
            { businessWebsiteUrl: { contains: client, mode: "insensitive" } },
            { User: { email: { contains: client, mode: "insensitive" } } },
          ],
        },
      }
    : null;

  const where: Prisma.SocialPublishAttemptWhereInput = {
    createdAt: { gte: range.start, lt: range.end },
    ...(status ? { status } : {}),
    ...(platform ? { platform } : {}),
    ...(clientWhere ?? {}),
  };

  try {
    const [
      attempts,
      total,
      statusCounts,
      platformCounts,
      clientCounts,
      lastPerClient,
      coverage,
      connectedAccounts,
      clientPlatformRows,
      duplicates,
    ] = await Promise.all([
      /**
       * Narrow select on purpose. A wide read of this table pulls unbounded
       * caption text and every provider field for fifty rows, and one row this
       * client cannot deserialise would throw the whole query rather than
       * degrade — the fewer columns crossing the wire, the smaller both risks.
       */
      prisma.socialPublishAttempt.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: pageSize,
        select: {
          id: true,
          businessId: true,
          runId: true,
          platform: true,
          status: true,
          mode: true,
          caption: true,
          hashtags: true,
          mediaUrl: true,
          externalPostId: true,
          externalStatus: true,
          externalPostUrl: true,
          lastErrorCode: true,
          lastErrorMessage: true,
          attemptCount: true,
          scheduledFor: true,
          timezone: true,
          submittedAt: true,
          publishedAt: true,
          createdAt: true,
          business: {
            select: {
              businessName: true,
              businessWebsiteUrl: true,
              User: { select: { email: true, name: true } },
            },
          },
          publisherAccount: {
            select: {
              platform: true,
              username: true,
              displayName: true,
              profileUrl: true,
              isActive: true,
            },
          },
        },
      }),
      prisma.socialPublishAttempt.count({ where }),
      prisma.socialPublishAttempt.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
      }),
      prisma.socialPublishAttempt.groupBy({
        by: ["platform", "status"],
        where,
        _count: { _all: true },
      }),
      prisma.socialPublishAttempt.groupBy({
        by: ["businessId", "status"],
        where,
        _count: { _all: true },
      }),
      prisma.socialPublishAttempt.groupBy({
        by: ["businessId"],
        where,
        _max: { publishedAt: true, createdAt: true },
      }),
      /**
       * Unfiltered on purpose: how far back the record goes is a property of the
       * table, not of the window being viewed. Without it an empty range reads
       * as "nothing was posted" when it may mean "this feature started last
       * week".
       */
      prisma.socialPublishAttempt.aggregate({
        _min: { createdAt: true },
        _max: { createdAt: true },
        _count: { _all: true },
      }),
      prisma.socialPublisherAccount.groupBy({
        by: ["businessId"],
        where: { isActive: true },
        _count: { _all: true },
      }),
      prisma.socialPublishAttempt.groupBy({
        by: ["businessId", "platform"],
        where,
        _count: { _all: true },
      }),
      /**
       * Failures the provider refused as duplicates, counted separately.
       *
       * On a live month these are the large majority of everything marked
       * FAILED, and they are not undelivered posts — the content is already on
       * the account or already queued for it. Folding them into the failure
       * figure makes a healthy pipeline read as a broken one and buries the
       * genuine failures under a number ten times their size.
       */
      prisma.socialPublishAttempt.aggregate({
        _count: { _all: true },
        // When the most recent one happened, which is the difference between a
        // live problem and one that was fixed and is ageing out of the window.
        _max: { createdAt: true },
        where: {
          ...where,
          status: "FAILED",
          OR: [
            { lastErrorCode: { endsWith: "_409" } },
            { lastErrorCode: { contains: "duplicate", mode: "insensitive" } },
            { lastErrorMessage: { contains: "already scheduled", mode: "insensitive" } },
            { lastErrorMessage: { contains: "already posted", mode: "insensitive" } },
            { lastErrorMessage: { contains: "already publishing", mode: "insensitive" } },
          ],
        },
      }),
    ]);

    // Which platforms each client posted to, folded from the grouped read
    // rather than one query per client.
    const platformsByBusiness = new Map<string, Set<string>>();
    for (const row of clientPlatformRows) {
      const bucket = platformsByBusiness.get(row.businessId) ?? new Set<string>();
      bucket.add(row.platform || "unknown");
      platformsByBusiness.set(row.businessId, bucket);
    }

    const businessIds = [...new Set(clientCounts.map((row) => row.businessId))];
    const businesses =
      businessIds.length > 0
        ? await prisma.business.findMany({
            where: { id: { in: businessIds } },
            select: {
              id: true,
              businessName: true,
              businessWebsiteUrl: true,
              User: { select: { email: true, name: true } },
            },
          })
        : [];
    const identities = new Map<string, SocialClientIdentity>(
      businesses.map((business) => [
        business.id,
        {
          businessId: business.id,
          businessName: business.businessName,
          websiteUrl: business.businessWebsiteUrl,
          ownerEmail: business.User?.email ?? null,
          ownerName: business.User?.name ?? null,
        },
      ]),
    );

    const clients = rollUpSocialClients({
      counts: clientCounts.map((row) => ({
        businessId: row.businessId,
        status: row.status,
        count: row._count._all,
      })),
      identities,
      platformsByBusiness: new Map(
        [...platformsByBusiness].map(([id, set]) => [id, [...set]]),
      ),
      connectedAccountsByBusiness: new Map(
        connectedAccounts.map((row) => [row.businessId, row._count._all]),
      ),
      lastPublishedByBusiness: new Map(
        lastPerClient.map((row) => [row.businessId, row._max.publishedAt]),
      ),
      lastAttemptByBusiness: new Map(
        lastPerClient.map((row) => [row.businessId, row._max.createdAt]),
      ),
    });

    sendSuccess(
      res,
      {
        range: {
          from: range.from,
          to: range.to,
          dayCount: range.dayCount,
          timeZone: "America/Toronto",
        },
        filters: {
          status,
          platform,
          client,
          statusOptions: [...SOCIAL_ATTEMPT_STATUSES],
        },
        totals: (() => {
          const totals = summariseAttemptStatuses(
            statusCounts.map((row) => ({
              status: row.status,
              count: row._count._all,
            })),
          );
          const duplicateSuppressed = duplicates._count._all;
          return {
            ...totals,
            duplicateSuppressed,
            duplicateSuppressedLastAt:
              duplicates._max.createdAt?.toISOString() ?? null,
            /** Failures that actually cost the client a post. */
            deliveryFailed: Math.max(0, totals.failed - duplicateSuppressed),
          };
        })(),
        byPlatform: rollUpSocialPlatforms(
          platformCounts.map((row) => ({
            platform: row.platform,
            status: row.status,
            count: row._count._all,
          })),
        ),
        clients: clients.slice(0, CLIENT_ROW_CAP),
        clientCount: clients.length,
        clientRowsTruncated: clients.length > CLIENT_ROW_CAP,
        /**
         * What exists at all, independent of the window. A tab showing an empty
         * range needs to distinguish "nothing this month" from "nothing ever".
         */
        coverage: {
          firstAttemptAt: coverage._min.createdAt?.toISOString() ?? null,
          lastAttemptAt: coverage._max.createdAt?.toISOString() ?? null,
          attemptsAllTime: coverage._count._all,
          clientsWithConnectedAccounts: connectedAccounts.length,
          connectedAccounts: connectedAccounts.reduce(
            (sum, row) => sum + row._count._all,
            0,
          ),
        },
        pagination: commandPaginationResult({ page, pageSize, total }),
        posts: attempts.map((attempt) => {
          const caption = previewCaption(attempt.caption);
          return {
            id: attempt.id,
            runId: attempt.runId,
            client: {
              businessId: attempt.businessId,
              businessName: attempt.business?.businessName ?? null,
              websiteUrl: attempt.business?.businessWebsiteUrl ?? null,
              ownerEmail: attempt.business?.User?.email ?? null,
              ownerName: attempt.business?.User?.name ?? null,
            },
            platform: attempt.platform,
            account: attempt.publisherAccount
              ? {
                  username: attempt.publisherAccount.username,
                  displayName: attempt.publisherAccount.displayName,
                  profileUrl: attempt.publisherAccount.profileUrl,
                  isActive: attempt.publisherAccount.isActive,
                }
              : null,
            status: attempt.status,
            mode: attempt.mode,
            caption: caption.text,
            captionTruncated: caption.truncated,
            hashtags: attempt.hashtags,
            mediaUrl: attempt.mediaUrl,
            postUrl: attempt.externalPostUrl,
            externalPostId: attempt.externalPostId,
            externalStatus: attempt.externalStatus,
            error:
              attempt.lastErrorCode || attempt.lastErrorMessage
                ? {
                    code: attempt.lastErrorCode,
                    message: attempt.lastErrorMessage,
                  }
                : null,
            attemptCount: attempt.attemptCount,
            scheduledFor: attempt.scheduledFor?.toISOString() ?? null,
            timezone: attempt.timezone,
            submittedAt: attempt.submittedAt?.toISOString() ?? null,
            publishedAt: attempt.publishedAt?.toISOString() ?? null,
            createdAt: attempt.createdAt.toISOString(),
          };
        }),
      },
      "Command social posts",
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "command-social",
        event: "social_posts_failed",
        from: range.from,
        to: range.to,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    sendError(res, "Failed to load social posts", 500);
  }
}
