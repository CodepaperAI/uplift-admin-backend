import { prisma } from "../config/db.config";
import {
  buildGhlSignupPayloadPreview,
  syncSignupToGhl,
} from "../services/ghl-signup-sync.service";

function readEnv(name: string) {
  return process.env[name]?.trim() || "";
}

function readPositiveInt(name: string, fallback: number) {
  const parsed = Number.parseInt(readEnv(name), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readDate(name: string) {
  const raw = readEnv(name);
  if (!raw) return null;

  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${name} must be a valid date or ISO timestamp.`);
  }

  return parsed;
}

function maskEmail(email: string) {
  if (readEnv("GHL_SIGNUP_BACKFILL_SHOW_EMAILS") === "true") {
    return email;
  }

  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  return `${local.slice(0, 2)}${"*".repeat(Math.max(2, local.length - 2))}@${domain}`;
}

function toIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return new Date(value).toISOString();
}

const commit = readEnv("GHL_SIGNUP_BACKFILL_COMMIT") === "true";
const includeOpportunities =
  readEnv("GHL_SIGNUP_BACKFILL_CREATE_OPPORTUNITIES") === "true";
const onlyTrial = readEnv("GHL_SIGNUP_BACKFILL_ONLY_TRIAL") === "true";
const originalOpportunitySync = process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED;

if (!includeOpportunities) {
  process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED = "false";
}

const limit = Math.min(readPositiveInt("GHL_SIGNUP_BACKFILL_LIMIT", 25), 500);
const recentDays = readPositiveInt("GHL_SIGNUP_BACKFILL_RECENT_DAYS", 0);
const explicitCreatedAfter = readDate("GHL_SIGNUP_BACKFILL_CREATED_AFTER");
const createdAfter =
  explicitCreatedAfter ||
  (recentDays > 0
    ? new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000)
    : null);
const createdBefore = readDate("GHL_SIGNUP_BACKFILL_CREATED_BEFORE");
const onlyEmail = readEnv("GHL_SIGNUP_BACKFILL_EMAIL").toLowerCase();

const createdAt =
  createdAfter || createdBefore
    ? {
        ...(createdAfter ? { gte: createdAfter } : {}),
        ...(createdBefore ? { lte: createdBefore } : {}),
      }
    : undefined;

try {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    where: {
      ...(onlyEmail ? { email: onlyEmail } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(onlyTrial
        ? {
            OR: [
              { trialStatus: "active" },
              {
                business: {
                  some: {
                    OR: [
                      { websiteStatus: "trial" },
                      {
                        websiteSubscription: {
                          is: {
                            OR: [
                              { status: "trialing" },
                              { trialStatus: "trialing" },
                            ],
                          },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      trialStatus: true,
      business: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: {
          id: true,
          businessCountry: true,
          businessName: true,
          businessWebsiteUrl: true,
          onboardingStatus: true,
          websiteStatus: true,
        },
      },
    },
  });

  const results = [];

  for (const user of users) {
    const signupUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
      country: user.business[0]?.businessCountry,
      businessName: user.business[0]?.businessName,
      businessWebsite: user.business[0]?.businessWebsiteUrl,
    };
    const preview = buildGhlSignupPayloadPreview(signupUser);
    const base = {
      business: user.business[0]
        ? {
            id: user.business[0].id,
            country: user.business[0].businessCountry,
            name: user.business[0].businessName,
            onboardingStatus: user.business[0].onboardingStatus,
            website: user.business[0].businessWebsiteUrl,
            websiteStatus: user.business[0].websiteStatus,
          }
        : null,
      createdAt: toIso(user.createdAt),
      email: maskEmail(user.email),
      id: user.id,
      preview:
        preview.status === "ready"
          ? {
              contactEndpoint: preview.endpoint,
              contactTags: preview.payload.tags,
              customFieldCount: Array.isArray(preview.payload.customFields)
                ? preview.payload.customFields.length
                : 0,
              opportunity:
                preview.opportunity?.status === "ready"
                  ? {
                      endpoint: preview.opportunity.endpoint,
                      name: preview.opportunity.payload.name,
                      pipelineId: preview.opportunity.payload.pipelineId,
                      pipelineStageId: preview.opportunity.payload.pipelineStageId,
                      status: preview.opportunity.payload.status,
                    }
                  : preview.opportunity,
            }
          : preview,
      trialStatus: user.trialStatus,
    };

    if (!commit) {
      results.push({ ...base, action: "dry-run" });
      continue;
    }

    const syncResult = await syncSignupToGhl(signupUser);
    results.push({
      ...base,
      action: "synced",
      syncResult,
    });
  }

  console.log(
    JSON.stringify(
      {
        commit,
        count: users.length,
        createOpportunities: includeOpportunities,
        createdAfter: toIso(createdAfter),
        createdBefore: toIso(createdBefore),
        limit,
        onlyTrial,
        recentDays,
        note: commit
          ? "Committed to GHL. Emails are masked in this output unless GHL_SIGNUP_BACKFILL_SHOW_EMAILS=true."
          : "Dry run only. Set GHL_SIGNUP_BACKFILL_COMMIT=true to upsert contacts into GHL. Set GHL_SIGNUP_BACKFILL_CREATE_OPPORTUNITIES=true to also create opportunities.",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  if (originalOpportunitySync === undefined) {
    delete process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED;
  } else {
    process.env.GHL_SIGNUP_OPPORTUNITY_SYNC_ENABLED = originalOpportunitySync;
  }

  await prisma.$disconnect();
}
