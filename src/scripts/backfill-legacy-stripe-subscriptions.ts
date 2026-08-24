import Stripe from "stripe";
import { BRAND } from "../config/brand.config";
import { prisma } from "../config/db.config";
import { isStripeConfigured, stripe } from "../config/stripe.config";
import {
  convertTrialToSubscription,
  getStripeMetadataBusinessIds,
  syncAddWebsiteSubscription,
} from "../services/billing-subscription.service";

type CliOptions = {
  apply: boolean;
  businessId: string | null;
  email: string | null;
  help: boolean;
  includeCanceled: boolean;
  limit: number;
  subscriptionId: string | null;
  userId: string | null;
};

type ParsedArg = {
  key: string;
  value: string;
};

type WebsiteRow = {
  id: string;
  businessName: string;
  businessWebsiteUrl: string;
  isPrimary: boolean;
  websiteStatus: string;
  agencyId: string | null;
  websiteSubscription: {
    id: string;
    status: string;
    trialStatus: string;
    stripeSubscriptionId: string | null;
    stripeSubscriptionItemId: string | null;
    stripePriceId: string | null;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
  } | null;
};

type ExistingLinkedWebsiteSubscription = {
  businessId: string;
  stripeSubscriptionItemId: string | null;
};

type StripeSubscriptionItemPeriodFields = Stripe.SubscriptionItem & {
  current_period_end?: number | null;
  current_period_start?: number | null;
};

type StripeSubscriptionWithPeriods = Stripe.Subscription & {
  billing_cycle_anchor?: number | null;
  start_date?: number | null;
  cancel_at_period_end?: boolean | null;
  canceled_at?: number | null;
  latest_invoice?: Stripe.Invoice | string | null;
};

type SyncTargetReason =
  | "item_metadata"
  | "existing_website_subscription"
  | "subscription_metadata"
  | "explicit_business"
  | "single_business_fallback"
  | "primary_business_fallback";

type SyncTarget = {
  businessId: string;
  reason: SyncTargetReason;
  subscriptionItem: Stripe.SubscriptionItem | null;
};

type ResolutionIssue =
  | {
      code:
        | "business_not_found"
        | "ambiguous_item_mapping"
        | "missing_subscription_item"
        | "duplicate_item_assignment";
      detail: string;
    }
  | {
      code: "no_target_business";
      detail: string;
    };

type ResolvedSyncTargets = {
  targets: SyncTarget[];
  issues: ResolutionIssue[];
};

type StripeSubscriptionPeriodState = {
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  priceId: string | null;
};

function parseKeyValueArg(arg: string): ParsedArg | null {
  if (!arg.startsWith("--")) {
    return null;
  }

  const normalizedArg = arg.slice(2);
  const separatorIndex = normalizedArg.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  const key = normalizedArg.slice(0, separatorIndex).trim();
  const value = normalizedArg.slice(separatorIndex + 1).trim();

  if (!key) {
    return null;
  }

  return { key, value };
}

function parseBoolean(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

function parsePositiveInt(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "bun run src/scripts/backfill-legacy-stripe-subscriptions.ts [options]",
      "",
      "Options:",
      "--apply=true                 Apply changes. Defaults to dry-run.",
      "--subscriptionId=<id>        Sync one Stripe subscription id.",
      "--userId=<id>                Sync one user.",
      "--email=<email>              Sync one user email.",
      "--businessId=<id>            Force one business within the matched user.",
      "--limit=<n>                  Max subscriptions to inspect. Default 50.",
      "--includeCanceled=true       Include canceled subscriptions.",
    ].join("\n"),
  );
}

function parseCliOptions(argv: string[]): CliOptions | null {
  const defaults: CliOptions = {
    apply: false,
    businessId: null,
    email: null,
    help: false,
    includeCanceled: false,
    limit: 50,
    subscriptionId: null,
    userId: null,
  };

  let options: CliOptions = { ...defaults };

  for (const arg of argv) {
    const parsed = parseKeyValueArg(arg);
    if (!parsed) {
      console.error(`Unknown argument format: ${arg}`);
      return null;
    }

    switch (parsed.key) {
      case "apply":
        options = { ...options, apply: parseBoolean(parsed.value) };
        break;
      case "businessId":
        options = { ...options, businessId: parsed.value || null };
        break;
      case "email":
        options = { ...options, email: parsed.value || null };
        break;
      case "help":
        options = { ...options, help: parseBoolean(parsed.value) };
        break;
      case "includeCanceled":
        options = { ...options, includeCanceled: parseBoolean(parsed.value) };
        break;
      case "limit": {
        const limit = parsePositiveInt(parsed.value);
        if (!limit) {
          console.error("Invalid --limit value. It must be a positive integer.");
          return null;
        }
        options = { ...options, limit };
        break;
      }
      case "subscriptionId":
        options = { ...options, subscriptionId: parsed.value || null };
        break;
      case "userId":
        options = { ...options, userId: parsed.value || null };
        break;
      default:
        console.error(`Unknown argument: --${parsed.key}`);
        return null;
    }
  }

  if (options.userId && options.email) {
    console.error("Use either --userId or --email, not both.");
    return null;
  }

  return options;
}

function unixTimestampToDate(value?: number | null): Date | null {
  return typeof value === "number" ? new Date(value * 1000) : null;
}

function getStripeSubscriptionPeriodState(
  stripeSubscription: Stripe.Subscription,
  subscriptionItem?: Stripe.SubscriptionItem | null,
): StripeSubscriptionPeriodState {
  const subscriptionWithPeriods =
    stripeSubscription as StripeSubscriptionWithPeriods;
  const item = (subscriptionItem ??
    stripeSubscription.items.data[0] ??
    null) as StripeSubscriptionItemPeriodFields | null;
  const latestInvoice =
    subscriptionWithPeriods.latest_invoice &&
    typeof subscriptionWithPeriods.latest_invoice === "object"
      ? (subscriptionWithPeriods.latest_invoice as Stripe.Invoice)
      : null;
  const firstInvoiceLine = latestInvoice?.lines?.data?.[0] ?? null;

  return {
    cancelAtPeriodEnd: Boolean(subscriptionWithPeriods.cancel_at_period_end),
    canceledAt: unixTimestampToDate(subscriptionWithPeriods.canceled_at),
    currentPeriodStart:
      unixTimestampToDate(item?.current_period_start) ??
      unixTimestampToDate(firstInvoiceLine?.period?.start ?? null) ??
      unixTimestampToDate(subscriptionWithPeriods.start_date) ??
      unixTimestampToDate(subscriptionWithPeriods.billing_cycle_anchor) ??
      null,
    currentPeriodEnd:
      unixTimestampToDate(item?.current_period_end) ??
      unixTimestampToDate(firstInvoiceLine?.period?.end ?? null) ??
      null,
    priceId: item?.price.id ?? null,
  };
}

function getReasonPriority(reason: SyncTargetReason): number {
  switch (reason) {
    case "item_metadata":
      return 6;
    case "explicit_business":
      return 5;
    case "existing_website_subscription":
      return 4;
    case "subscription_metadata":
      return 3;
    case "single_business_fallback":
      return 2;
    case "primary_business_fallback":
      return 1;
  }
}

function stringifyIssue(issue: ResolutionIssue): string {
  return `${issue.code}: ${issue.detail}`;
}

function getStripeCustomerId(
  stripeSubscription: Stripe.Subscription,
): string | null {
  if (typeof stripeSubscription.customer === "string") {
    return stripeSubscription.customer;
  }

  if (
    stripeSubscription.customer &&
    typeof stripeSubscription.customer === "object" &&
    "id" in stripeSubscription.customer
  ) {
    return stripeSubscription.customer.id;
  }

  return null;
}

function dedupeSyncTargets(targets: SyncTarget[]): ResolvedSyncTargets {
  const issues: ResolutionIssue[] = [];
  const dedupedByBusinessId = new Map<string, SyncTarget>();

  for (const target of targets) {
    const existing = dedupedByBusinessId.get(target.businessId);
    if (!existing) {
      dedupedByBusinessId.set(target.businessId, target);
      continue;
    }

    const existingPriority = getReasonPriority(existing.reason);
    const nextPriority = getReasonPriority(target.reason);

    if (nextPriority > existingPriority) {
      dedupedByBusinessId.set(target.businessId, target);
      continue;
    }

    if (!existing.subscriptionItem && target.subscriptionItem) {
      dedupedByBusinessId.set(target.businessId, target);
    }
  }

  const targetsWithUniqueItems = Array.from(dedupedByBusinessId.values());
  const assignedItemIds = new Map<string, string>();
  const validTargets: SyncTarget[] = [];

  for (const target of targetsWithUniqueItems) {
    const itemId = target.subscriptionItem?.id ?? null;
    if (!itemId) {
      validTargets.push(target);
      continue;
    }

    const existingBusinessId = assignedItemIds.get(itemId);
    if (existingBusinessId && existingBusinessId !== target.businessId) {
      issues.push({
        code: "duplicate_item_assignment",
        detail: `Stripe item ${itemId} resolved to both ${existingBusinessId} and ${target.businessId}`,
      });
      continue;
    }

    assignedItemIds.set(itemId, target.businessId);
    validTargets.push(target);
  }

  return { targets: validTargets, issues };
}

function resolveSyncTargets({
  existingLinkedWebsiteSubscriptions,
  explicitBusinessId,
  stripeSubscription,
  userBusinesses,
}: {
  existingLinkedWebsiteSubscriptions: ExistingLinkedWebsiteSubscription[];
  explicitBusinessId?: string | null;
  stripeSubscription: Stripe.Subscription;
  userBusinesses: WebsiteRow[];
}): ResolvedSyncTargets {
  const issues: ResolutionIssue[] = [];
  const targets: SyncTarget[] = [];
  const businessMap = new Map(userBusinesses.map((business) => [business.id, business]));
  const subscriptionItems = stripeSubscription.items.data;
  const soleSubscriptionItem =
    subscriptionItems.length === 1 ? subscriptionItems[0]! : null;
  const itemsById = new Map(subscriptionItems.map((item) => [item.id, item]));
  const existingByBusinessId = new Map(
    existingLinkedWebsiteSubscriptions.map((item) => [item.businessId, item]),
  );

  const addTarget = (
    businessId: string,
    reason: SyncTargetReason,
    subscriptionItem: Stripe.SubscriptionItem | null,
  ) => {
    const business = businessMap.get(businessId);
    if (!business) {
      issues.push({
        code: "business_not_found",
        detail: `Business ${businessId} is not owned by the matched user`,
      });
      return;
    }

    if (!subscriptionItem) {
      issues.push({
        code: "missing_subscription_item",
        detail: `Could not resolve a Stripe subscription item for business ${business.businessName} (${businessId})`,
      });
      return;
    }

    targets.push({
      businessId,
      reason,
      subscriptionItem,
    });
  };

  for (const item of subscriptionItems) {
    const businessId = item.metadata?.businessId;
    if (businessId) {
      addTarget(businessId, "item_metadata", item);
    }
  }

  for (const existingLinked of existingLinkedWebsiteSubscriptions) {
    const matchedItem = existingLinked.stripeSubscriptionItemId
      ? itemsById.get(existingLinked.stripeSubscriptionItemId) ?? null
      : soleSubscriptionItem;

    if (!matchedItem && subscriptionItems.length > 1) {
      issues.push({
        code: "ambiguous_item_mapping",
        detail: `Existing linked website ${existingLinked.businessId} has no stripeSubscriptionItemId, and Stripe subscription ${stripeSubscription.id} has multiple items`,
      });
      continue;
    }

    addTarget(
      existingLinked.businessId,
      "existing_website_subscription",
      matchedItem,
    );
  }

  for (const businessId of getStripeMetadataBusinessIds(stripeSubscription.metadata)) {
    const existingLinked = existingByBusinessId.get(businessId);
    const matchedItem =
      (existingLinked?.stripeSubscriptionItemId
        ? itemsById.get(existingLinked.stripeSubscriptionItemId) ?? null
        : null) ??
      soleSubscriptionItem;

    if (!matchedItem && subscriptionItems.length > 1) {
      issues.push({
        code: "ambiguous_item_mapping",
        detail: `Subscription metadata pointed to business ${businessId}, but subscription ${stripeSubscription.id} has multiple items`,
      });
      continue;
    }

    addTarget(businessId, "subscription_metadata", matchedItem);
  }

  if (explicitBusinessId) {
    const existingLinked = existingByBusinessId.get(explicitBusinessId);
    const matchedItem =
      (existingLinked?.stripeSubscriptionItemId
        ? itemsById.get(existingLinked.stripeSubscriptionItemId) ?? null
        : null) ??
      soleSubscriptionItem;

    if (!matchedItem && subscriptionItems.length > 1) {
      issues.push({
        code: "ambiguous_item_mapping",
        detail: `Explicit business ${explicitBusinessId} could not be matched because subscription ${stripeSubscription.id} has multiple items`,
      });
    } else if (matchedItem) {
      addTarget(explicitBusinessId, "explicit_business", matchedItem);
    }
  }

  if (targets.length === 0 && soleSubscriptionItem) {
    if (userBusinesses.length === 1) {
      const onlyBusiness = userBusinesses[0]!;
      addTarget(
        onlyBusiness.id,
        "single_business_fallback",
        soleSubscriptionItem,
      );
    } else {
      const primaryBusinesses = userBusinesses.filter((business) => business.isPrimary);
      if (primaryBusinesses.length === 1) {
        const primaryBusiness = primaryBusinesses[0]!;
        addTarget(
          primaryBusiness.id,
          "primary_business_fallback",
          soleSubscriptionItem,
        );
      }
    }
  }

  const deduped = dedupeSyncTargets(targets);
  const combinedIssues = [...issues, ...deduped.issues];

  if (deduped.targets.length === 0) {
    combinedIssues.push({
      code: "no_target_business",
      detail:
        "No unambiguous business mapping could be resolved from Stripe metadata, existing website rows, or safe fallback rules",
    });
  }

  return {
    targets: deduped.targets,
    issues: combinedIssues,
  };
}

async function upsertAccountSubscriptionSummary({
  activeWebsiteCount,
  existingSubscription,
  stripeSubscription,
  userId,
}: {
  activeWebsiteCount: number;
  existingSubscription: {
    id: string;
    currentPeriodEnd: Date | null;
    maxWebsites: number;
    planId: string | null;
    planName: string | null;
    startDate: Date;
    stripeCustomerId: string | null;
    stripePriceId: string | null;
  } | null;
  stripeSubscription: Stripe.Subscription;
  userId: string;
}): Promise<void> {
  const primaryItem =
    stripeSubscription.items.data[0] ??
    null;
  const periodState = getStripeSubscriptionPeriodState(
    stripeSubscription,
    primaryItem,
  );
  const stripeCustomerId =
    getStripeCustomerId(stripeSubscription) ??
    existingSubscription?.stripeCustomerId ??
    null;
  const nextMaxWebsites = Math.max(
    existingSubscription?.maxWebsites ?? 1,
    activeWebsiteCount || 1,
  );

  await prisma.subscription.upsert({
    where: { userId },
    create: {
      userId,
      planId: periodState.priceId ?? existingSubscription?.planId ?? null,
      planName: existingSubscription?.planName ?? BRAND.name,
      status: stripeSubscription.status,
      startDate: new Date(stripeSubscription.created * 1000),
      currentPeriodEnd:
        periodState.currentPeriodEnd ?? existingSubscription?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: periodState.cancelAtPeriodEnd,
      canceledAt: periodState.canceledAt,
      stripeCustomerId,
      stripeSubscriptionId: stripeSubscription.id,
      stripePriceId:
        periodState.priceId ?? existingSubscription?.stripePriceId ?? null,
      stripeCurrentPeriodEnd:
        periodState.currentPeriodEnd ?? existingSubscription?.currentPeriodEnd ?? null,
      stripeCancelAtPeriodEnd: periodState.cancelAtPeriodEnd,
      stripeStatus: stripeSubscription.status,
      websiteCount: activeWebsiteCount,
      maxWebsites: nextMaxWebsites,
    },
    update: {
      planId: periodState.priceId ?? existingSubscription?.planId ?? null,
      planName: existingSubscription?.planName ?? BRAND.name,
      status: stripeSubscription.status,
      startDate: existingSubscription?.startDate ?? new Date(stripeSubscription.created * 1000),
      currentPeriodEnd:
        periodState.currentPeriodEnd ?? existingSubscription?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: periodState.cancelAtPeriodEnd,
      canceledAt: periodState.canceledAt,
      stripeCustomerId,
      stripeSubscriptionId: stripeSubscription.id,
      stripePriceId:
        periodState.priceId ?? existingSubscription?.stripePriceId ?? null,
      stripeCurrentPeriodEnd:
        periodState.currentPeriodEnd ?? existingSubscription?.currentPeriodEnd ?? null,
      stripeCancelAtPeriodEnd: periodState.cancelAtPeriodEnd,
      stripeStatus: stripeSubscription.status,
      websiteCount: activeWebsiteCount,
      maxWebsites: nextMaxWebsites,
    },
  });
}

async function main(): Promise<void> {
  if (!isStripeConfigured) {
    throw new Error(
      "STRIPE_SECRET_KEY is required. Run this script with the correct live or test env file.",
    );
  }

  const options = parseCliOptions(process.argv.slice(2));
  if (!options) {
    printUsage();
    process.exit(1);
  }

  if (options.help) {
    printUsage();
    return;
  }

  let scopedUserId = options.userId;
  if (options.email) {
    const scopedUser = await prisma.user.findUnique({
      where: { email: options.email },
      select: { id: true },
    });

    if (!scopedUser) {
      throw new Error(`No user found for email ${options.email}`);
    }

    scopedUserId = scopedUser.id;
  }

  if (options.businessId) {
    const business = await prisma.business.findUnique({
      where: { id: options.businessId },
      select: { id: true, userId: true, businessName: true },
    });

    if (!business) {
      throw new Error(`No business found for id ${options.businessId}`);
    }

    if (scopedUserId && scopedUserId !== business.userId) {
      throw new Error(
        `Business ${options.businessId} does not belong to the scoped user`,
      );
    }

    scopedUserId = business.userId;
  }

  const where = {
    stripeSubscriptionId: { not: null },
    ...(options.subscriptionId
      ? { stripeSubscriptionId: options.subscriptionId }
      : {}),
    ...(scopedUserId ? { userId: scopedUserId } : {}),
    ...(!options.includeCanceled
      ? {
          OR: [
            { status: { in: ["active", "trialing", "past_due", "unpaid", "incomplete"] } },
            {
              stripeStatus: {
                in: ["active", "trialing", "past_due", "unpaid", "incomplete"],
              },
            },
          ],
        }
      : {}),
  } as const;

  const candidates = await prisma.subscription.findMany({
    where,
    include: {
      user: {
        select: {
          email: true,
          name: true,
          trialStatus: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: options.limit,
  });

  console.log(
    `[Legacy Stripe Sync] Mode=${options.apply ? "apply" : "dry-run"} candidates=${candidates.length}`,
  );

  let processed = 0;
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    processed++;
    const stripeSubscriptionId = candidate.stripeSubscriptionId;

    if (!stripeSubscriptionId) {
      skipped++;
      continue;
    }

    try {
      const [userBusinesses, existingLinkedWebsiteSubscriptions] = await Promise.all([
        prisma.business.findMany({
          where: { userId: candidate.userId },
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
            isPrimary: true,
            websiteStatus: true,
            agencyId: true,
            websiteSubscription: {
              select: {
                id: true,
                status: true,
                trialStatus: true,
                stripeSubscriptionId: true,
                stripeSubscriptionItemId: true,
                stripePriceId: true,
                currentPeriodStart: true,
                currentPeriodEnd: true,
              },
            },
          },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        }),
        prisma.websiteSubscription.findMany({
          where: {
            business: { userId: candidate.userId },
            stripeSubscriptionId,
          },
          select: {
            businessId: true,
            stripeSubscriptionItemId: true,
          },
        }),
      ]);

      const liveStripeSubscription = await stripe.subscriptions.retrieve(
        stripeSubscriptionId,
        {
          expand: ["latest_invoice"],
        },
      );

      const resolution = resolveSyncTargets({
        existingLinkedWebsiteSubscriptions,
        explicitBusinessId: options.businessId,
        stripeSubscription: liveStripeSubscription,
        userBusinesses,
      });

      const preview = {
        userId: candidate.userId,
        email: candidate.user.email,
        subscriptionId: stripeSubscriptionId,
        stripeStatus: liveStripeSubscription.status,
        stripeItemIds: liveStripeSubscription.items.data.map((item) => item.id),
        targetBusinesses: resolution.targets.map((target) => {
          const business = userBusinesses.find((item) => item.id === target.businessId);
          return {
            businessId: target.businessId,
            businessName: business?.businessName ?? "Unknown business",
            reason: target.reason,
            stripeSubscriptionItemId: target.subscriptionItem?.id ?? null,
            currentWebsiteStatus: business?.websiteStatus ?? null,
            currentWebsiteSubscription: business?.websiteSubscription
              ? {
                  status: business.websiteSubscription.status,
                  trialStatus: business.websiteSubscription.trialStatus,
                  stripeSubscriptionId:
                    business.websiteSubscription.stripeSubscriptionId,
                  stripeSubscriptionItemId:
                    business.websiteSubscription.stripeSubscriptionItemId,
                  currentPeriodEnd:
                    business.websiteSubscription.currentPeriodEnd?.toISOString() ??
                    null,
                }
              : null,
          };
        }),
        issues: resolution.issues.map(stringifyIssue),
      };

      console.log(
        `[Legacy Stripe Sync] Candidate ${processed}/${candidates.length}\n${JSON.stringify(
          preview,
          null,
          2,
        )}`,
      );

      if (!options.apply) {
        if (resolution.targets.length === 0) {
          skipped++;
        }
        continue;
      }

      if (resolution.targets.length === 0) {
        skipped++;
        console.warn(
          `[Legacy Stripe Sync] Skipping ${stripeSubscriptionId} because no safe business target could be resolved`,
        );
        continue;
      }

      for (const target of resolution.targets) {
        await syncAddWebsiteSubscription({
          userId: candidate.userId,
          businessId: target.businessId,
          stripeSubscription: liveStripeSubscription,
          subscriptionItem: target.subscriptionItem,
          agencyId: liveStripeSubscription.metadata?.agencyId,
          agencyPricingConfigId:
            liveStripeSubscription.metadata?.agencyPricingConfigId ?? null,
        });
      }

      await convertTrialToSubscription(
        candidate.userId,
        resolution.targets.map((target) => target.businessId),
      );

      const activeWebsiteCount = await prisma.websiteSubscription.count({
        where: {
          business: { userId: candidate.userId },
          status: { in: ["active", "trialing"] },
        },
      });

      await upsertAccountSubscriptionSummary({
        activeWebsiteCount,
        existingSubscription: {
          id: candidate.id,
          currentPeriodEnd: candidate.currentPeriodEnd,
          maxWebsites: candidate.maxWebsites,
          planId: candidate.planId,
          planName: candidate.planName,
          startDate: candidate.startDate,
          stripeCustomerId: candidate.stripeCustomerId,
          stripePriceId: candidate.stripePriceId,
        },
        stripeSubscription: liveStripeSubscription,
        userId: candidate.userId,
      });

      synced++;
      console.log(
        `[Legacy Stripe Sync] Synced ${stripeSubscriptionId} for ${candidate.user.email} -> ${resolution.targets
          .map((target) => target.businessId)
          .join(", ")}`,
      );
    } catch (error) {
      failed++;
      console.error(
        `[Legacy Stripe Sync] Failed for subscription ${stripeSubscriptionId}:`,
        error,
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: options.apply ? "apply" : "dry-run",
        processed,
        synced,
        skipped,
        failed,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error("[Legacy Stripe Sync] Fatal error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
