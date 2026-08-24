import { prisma } from "../config/db.config";

type WebsiteSubscriptionLike = {
  status: string;
  trialStatus: string | null;
  trialEndDate: Date | null;
};

type ExpectedBusinessState = {
  websiteStatus: string;
  isActive: boolean;
  entitlement:
    | "paid"
    | "trial"
    | "expired"
    | "suspended"
    | "canceled"
    | "not_subscribed";
  reason: string;
};

function getArg(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function deriveExpectedBusinessState(
  websiteSubscription: WebsiteSubscriptionLike | null,
): ExpectedBusinessState {
  if (!websiteSubscription) {
    return {
      websiteStatus: "pending",
      isActive: false,
      entitlement: "not_subscribed",
      reason: "No WebsiteSubscription row exists for this business.",
    };
  }

  const now = new Date();
  const trialExpired =
    websiteSubscription.trialEndDate != null &&
    websiteSubscription.trialEndDate <= now;

  if (
    websiteSubscription.trialStatus === "expired" ||
    websiteSubscription.status === "expired" ||
    ((websiteSubscription.trialStatus === "trialing" ||
      websiteSubscription.status === "trialing") &&
      trialExpired)
  ) {
    return {
      websiteStatus: "expired",
      isActive: false,
      entitlement: "expired",
      reason: "WebsiteSubscription trial has expired.",
    };
  }

  if (
    websiteSubscription.trialStatus === "trialing" &&
    (!websiteSubscription.trialEndDate || websiteSubscription.trialEndDate > now)
  ) {
    return {
      websiteStatus: "trial",
      isActive: true,
      entitlement: "trial",
      reason: "WebsiteSubscription is actively trialing.",
    };
  }

  switch (websiteSubscription.status) {
    case "active":
      return {
        websiteStatus: "active",
        isActive: true,
        entitlement: "paid",
        reason: "WebsiteSubscription is active for this business.",
      };
    case "past_due":
    case "unpaid":
    case "incomplete":
    case "suspended":
      return {
        websiteStatus: "suspended",
        isActive: false,
        entitlement: "suspended",
        reason: `WebsiteSubscription is ${websiteSubscription.status}.`,
      };
    case "canceled":
    case "incomplete_expired":
      return {
        websiteStatus: "canceled",
        isActive: false,
        entitlement: "canceled",
        reason: `WebsiteSubscription is ${websiteSubscription.status}.`,
      };
    default:
      return {
        websiteStatus: "pending",
        isActive: false,
        entitlement: "not_subscribed",
        reason: `WebsiteSubscription status ${websiteSubscription.status} does not grant site entitlement.`,
      };
  }
}

async function main() {
  const shouldRepair = process.argv.includes("--repair");
  const email = getArg("email");
  const userId = getArg("userId");
  const businessId = getArg("businessId");

  const businesses = await prisma.business.findMany({
    where: {
      ...(businessId ? { id: businessId } : {}),
      ...(userId || email
        ? {
            User: {
              ...(userId ? { id: userId } : {}),
              ...(email ? { email } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      businessName: true,
      businessWebsiteUrl: true,
      websiteStatus: true,
      isActive: true,
      isPrimary: true,
      userId: true,
      websiteSubscription: {
        select: {
          status: true,
          trialStatus: true,
          trialEndDate: true,
          stripeSubscriptionId: true,
          stripeSubscriptionItemId: true,
          stripePriceId: true,
        },
      },
      User: {
        select: {
          email: true,
          Subscription: {
            select: {
              status: true,
              stripeSubscriptionId: true,
            },
          },
        },
      },
    },
  });

  const flagged = businesses
    .map((business) => {
      const expected = deriveExpectedBusinessState(business.websiteSubscription);
      const inheritedAccountSubscription =
        business.User.Subscription?.status === "active" &&
        !business.websiteSubscription;
      const statusMismatch = business.websiteStatus !== expected.websiteStatus;
      const activeMismatch = business.isActive !== expected.isActive;
      const inheritedEntitlementMismatch =
        inheritedAccountSubscription &&
        (business.websiteStatus === "active" || business.websiteStatus === "trial");

      if (!statusMismatch && !activeMismatch && !inheritedEntitlementMismatch) {
        return null;
      }

      return {
        businessId: business.id,
        businessName: business.businessName,
        businessWebsiteUrl: business.businessWebsiteUrl,
        userId: business.userId,
        userEmail: business.User.email,
        isPrimary: business.isPrimary,
        currentWebsiteStatus: business.websiteStatus,
        expectedWebsiteStatus: expected.websiteStatus,
        currentIsActive: business.isActive,
        expectedIsActive: expected.isActive,
        entitlement: expected.entitlement,
        reason: expected.reason,
        inheritedAccountSubscription,
        accountSubscriptionStatus: business.User.Subscription?.status ?? null,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  console.log(
    JSON.stringify(
      {
        dryRun: !shouldRepair,
        filters: { email, userId, businessId },
        scannedBusinesses: businesses.length,
        flaggedBusinesses: flagged.length,
        flagged,
      },
      null,
      2,
    ),
  );

  if (!shouldRepair || flagged.length === 0) {
    await prisma.$disconnect();
    return;
  }

  let repaired = 0;

  for (const item of flagged) {
    await prisma.business.update({
      where: { id: item.businessId },
      data: {
        websiteStatus: item.expectedWebsiteStatus,
        isActive: item.expectedIsActive,
      },
    });
    repaired++;
  }

  console.log(
    JSON.stringify(
      {
        repaired,
        note:
          "This script only repairs Business.websiteStatus/isActive from WebsiteSubscription truth. It never links sibling sites to a paid subscription.",
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("[audit-website-subscription-truth] failed:", error);
  await prisma.$disconnect();
  process.exit(1);
});
