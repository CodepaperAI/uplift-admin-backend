/**
 * Shaping and rollups for the social publishing feed.
 *
 * The pure half, kept out of the controller so the grouping and the status
 * arithmetic can be tested without a database.
 *
 * Context worth carrying: the Product Analysis "Social posts" tab spent its
 * life as a written explanation of why it could not be built, and the
 * explanation ended on an open question — does Uplift publish socially through
 * its own pipeline or through GoHighLevel? The answer is its own pipeline. Every
 * attempt to put a post on a client's account is recorded in
 * `social_publish_attempt`, in the same database this service already reads, and
 * that row carries the platform, the account it targeted, the client it belongs
 * to, the publish time, the outcome, and the public URL. Nothing external was
 * ever needed.
 */

/** Every state `social_publish_attempt.status` is written with. */
export const SOCIAL_ATTEMPT_STATUSES = [
  "PENDING",
  "SUBMITTING",
  "SCHEDULED",
  "PUBLISHED",
  "FAILED",
  "CANCELLED",
] as const;

export type SocialAttemptStatus = (typeof SOCIAL_ATTEMPT_STATUSES)[number];

const STATUS_SET = new Set<string>(SOCIAL_ATTEMPT_STATUSES);

/**
 * A status filter, or null for "no filter".
 *
 * Unknown values return null rather than an empty result set: a typo in a query
 * string should show the unfiltered feed, not an empty table that reads as "this
 * client has never posted".
 */
export function parseSocialStatusFilter(value: unknown): SocialAttemptStatus | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return STATUS_SET.has(upper) ? (upper as SocialAttemptStatus) : null;
}

/** Platforms are provider-defined strings, so this only normalises and bounds. */
export function parseSocialPlatformFilter(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 && trimmed.length <= 40 ? trimmed : null;
}

export type SocialStatusCount = { status: string; count: number };

export type SocialStatusTotals = {
  attempts: number;
  published: number;
  scheduled: number;
  failed: number;
  pending: number;
  cancelled: number;
  /** Published as a share of everything that reached a terminal state. */
  successRatePercent: string | null;
};

/**
 * Totals by outcome, with a success rate that excludes work still in flight.
 *
 * Dividing published by every attempt would punish a healthy account simply for
 * having posts scheduled for next week. Only PUBLISHED, FAILED and CANCELLED
 * have finished, so only those form the denominator, and a window containing
 * nothing finished reports null rather than a confident zero.
 */
export function summariseAttemptStatuses(
  rows: readonly SocialStatusCount[],
): SocialStatusTotals {
  const byStatus = new Map<string, number>();
  for (const row of rows) {
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + row.count);
  }
  const at = (status: string) => byStatus.get(status) ?? 0;
  const published = at("PUBLISHED");
  const failed = at("FAILED");
  const cancelled = at("CANCELLED");
  const settled = published + failed + cancelled;
  let attempts = 0;
  for (const count of byStatus.values()) attempts += count;
  return {
    attempts,
    published,
    scheduled: at("SCHEDULED"),
    failed,
    pending: at("PENDING") + at("SUBMITTING"),
    cancelled,
    successRatePercent:
      settled > 0 ? ((published * 100) / settled).toFixed(2) : null,
  };
}

export type SocialPlatformCount = {
  platform: string;
  status: string;
  count: number;
};

export type SocialPlatformRow = SocialStatusTotals & { platform: string };

/** One row per platform, busiest first, so the mix reads at a glance. */
export function rollUpSocialPlatforms(
  rows: readonly SocialPlatformCount[],
): SocialPlatformRow[] {
  const byPlatform = new Map<string, SocialStatusCount[]>();
  for (const row of rows) {
    const platform = row.platform || "unknown";
    const bucket = byPlatform.get(platform);
    if (bucket) bucket.push(row);
    else byPlatform.set(platform, [row]);
  }
  return [...byPlatform.entries()]
    .map(([platform, counts]) => ({
      platform,
      ...summariseAttemptStatuses(counts),
    }))
    .sort(
      (left, right) =>
        right.attempts - left.attempts || left.platform.localeCompare(right.platform),
    );
}

export type SocialClientCount = {
  businessId: string;
  status: string;
  count: number;
};

export type SocialClientIdentity = {
  businessId: string;
  businessName: string | null;
  websiteUrl: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
};

export type SocialClientRow = SocialStatusTotals &
  SocialClientIdentity & {
    platforms: string[];
    connectedAccounts: number;
    lastPublishedAt: string | null;
    lastAttemptAt: string | null;
  };

/**
 * One row per client, busiest first.
 *
 * A client that has attempted a post appears even when every attempt failed —
 * that is the row most worth seeing, and dropping it would turn a delivery
 * failure into an absence.
 */
export function rollUpSocialClients(input: {
  counts: readonly SocialClientCount[];
  identities: ReadonlyMap<string, SocialClientIdentity>;
  platformsByBusiness?: ReadonlyMap<string, readonly string[]>;
  connectedAccountsByBusiness?: ReadonlyMap<string, number>;
  lastPublishedByBusiness?: ReadonlyMap<string, Date | null>;
  lastAttemptByBusiness?: ReadonlyMap<string, Date | null>;
}): SocialClientRow[] {
  const byBusiness = new Map<string, SocialClientCount[]>();
  for (const row of input.counts) {
    const bucket = byBusiness.get(row.businessId);
    if (bucket) bucket.push(row);
    else byBusiness.set(row.businessId, [row]);
  }
  return [...byBusiness.entries()]
    .map(([businessId, counts]) => {
      const identity = input.identities.get(businessId);
      return {
        businessId,
        businessName: identity?.businessName ?? null,
        websiteUrl: identity?.websiteUrl ?? null,
        ownerEmail: identity?.ownerEmail ?? null,
        ownerName: identity?.ownerName ?? null,
        platforms: [...(input.platformsByBusiness?.get(businessId) ?? [])].sort(),
        connectedAccounts: input.connectedAccountsByBusiness?.get(businessId) ?? 0,
        lastPublishedAt:
          input.lastPublishedByBusiness?.get(businessId)?.toISOString() ?? null,
        lastAttemptAt:
          input.lastAttemptByBusiness?.get(businessId)?.toISOString() ?? null,
        ...summariseAttemptStatuses(counts),
      };
    })
    .sort(
      (left, right) =>
        right.attempts - left.attempts ||
        (left.businessName ?? "").localeCompare(right.businessName ?? ""),
    );
}

/**
 * A ceiling on caption text, so one pathological row cannot bloat a page.
 *
 * Generous on purpose. This used to cut at 240 characters for the table cell,
 * which was right until the post preview needed the caption the client will
 * actually read — a preview showing two thirds of a caption is worse than no
 * preview, because it looks complete. The API returns the caption; the table
 * decides how much of it to show.
 */
export const SOCIAL_CAPTION_MAX_LENGTH = 4_000;

export function boundedCaption(caption: string | null | undefined): string {
  const value = (caption ?? "").trim();
  return value.length <= SOCIAL_CAPTION_MAX_LENGTH
    ? value
    : `${value.slice(0, SOCIAL_CAPTION_MAX_LENGTH)}…`;
}

/**
 * Whether a failed attempt was the provider refusing a duplicate.
 *
 * This matters more than it looks. The publisher rejects content already
 * scheduled, publishing, or posted to the same account within 24 hours, and on a
 * live month those rejections are the large majority of everything marked
 * FAILED. They are not undelivered posts — the content is already on the account
 * or already queued for it — so counting them as delivery failures makes a
 * healthy pipeline read as a broken one, and hides the genuine failures
 * underneath a number ten times their size.
 *
 * Matched on the 409 the client derives from the HTTP status, with the message
 * as a fallback for the day the provider starts sending a named code instead.
 */
export function isDuplicateSuppression(
  code: string | null | undefined,
  message: string | null | undefined,
): boolean {
  if (typeof code === "string" && /(^|_)409$/.test(code.trim())) return true;
  if (typeof code === "string" && /duplicate/i.test(code)) return true;
  return (
    typeof message === "string" &&
    /already (scheduled|publishing|posted)/i.test(message)
  );
}
