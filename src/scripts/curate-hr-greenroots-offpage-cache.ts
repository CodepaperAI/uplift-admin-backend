import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

const BUSINESS_ID = "34849719-ef87-4e98-bb6c-3a8e6904677d";
const EMAIL = "hrgreenrootslandscapingltd@gmail.com";
const prisma = createPrismaClient();
const now = new Date();
const checkedAt = now.toISOString();

type JsonObject = Record<string, any>;

function directoryOpportunity(input: {
  key: string;
  title: string;
  url: string;
  priority: number;
  rationale: string;
  pricingModel: "free" | "paid" | "freemium";
  sourceType: "marketplace" | "business_profile" | "review_platform" | "association";
  submissionUrlType: "add_business" | "direct_claim" | "membership_application";
  qualitySignals: string[];
}) {
  return {
    key: input.key,
    url: input.url,
    title: input.title,
    action: `${input.submissionUrlType === "membership_application" ? "Apply for" : "Create or claim"} this profile. Keep the business name, address, phone, website, services, and service area consistent with the verified business profile.`,
    source: "researched",
    status: "todo",
    grounded: true,
    leverKey: "directory",
    priority: input.priority,
    rationale: input.rationale,
    confidence: 100,
    sourceType: input.sourceType,
    pricingModel: input.pricingModel,
    lastCheckedAt: checkedAt,
    submissionUrl: input.url,
    submissionUrlType: input.submissionUrlType,
    qualitySignals: [
      "Official destination checked",
      "Current signup or membership path",
      "Strong landscaping category fit",
      "Relevant to Ontario or Canadian homeowners",
      ...input.qualitySignals,
    ],
    whyRecommended: input.rationale,
    businessTypeFit: "local / multi-location",
    confidenceLevel: "high",
    evidenceSources: ["official_site", "manual_public_research"],
    qualityWarnings: [],
    validatorScore: 1,
    validatorReason: "Manually retained after current official-site and market-fit review.",
  };
}

function redditOpportunity(input: {
  key: string;
  subreddit: string;
  title: string;
  url: string;
  priority: number;
  rationale: string;
  createdAt: string;
  locationFit: string;
  draft: string;
}) {
  const ageDays = Math.max(
    0,
    Math.floor((now.getTime() - new Date(input.createdAt).getTime()) / 86_400_000),
  );
  return {
    key: input.key,
    url: input.url,
    draft: input.draft,
    title: `Reply in ${input.subreddit}: "${input.title}"`,
    action:
      "Answer the homeowner's question with practical Ontario landscaping guidance. Do not mention the business, add links, solicit work, or use promotional language.",
    source: "researched",
    status: "todo",
    threads: [
      {
        url: input.url,
        draft: input.draft,
        title: input.title,
        locked: false,
        source: "public_search",
        ageDays,
        deleted: false,
        archived: false,
        createdAt: input.createdAt,
        buyerIntent: /quote|service|contractor|landscap/i.test(input.title),
        unavailable: false,
        commentCount: null,
        qualityScore: ageDays <= 45 ? 90 : 80,
        qualitySignals: ["Recent thread", "Ontario market fit", input.locationFit],
        detailCheckedAt: checkedAt,
        qualityWarnings: ["Comment activity not independently verified"],
      },
    ],
    grounded: true,
    leverKey: "reddit",
    priority: input.priority,
    rationale: input.rationale,
    confidence: ageDays <= 45 ? 95 : 90,
    sourceType: "reddit_thread",
    threadTitle: input.title,
    lastCheckedAt: checkedAt,
    qualitySignals: [
      "Recent public thread",
      "Ontario or Mississauga relevance",
      "Service-topic match",
      "Non-promotional expert reply prepared",
      "Manually reviewed",
    ],
    validatorScore: 1,
    whyRecommended: input.rationale,
    businessTypeFit: "local service business",
    confidenceLevel: "high",
    evidenceSources: ["public_search", "manual_public_research"],
    qualityWarnings: ["Confirm the thread remains open before replying"],
    validatorReason: "Recent, relevant public discussion with a useful non-promotional response angle.",
  };
}

function validate(opportunities: JsonObject[]) {
  const keys = opportunities.map((item) => item.key);
  const directories = opportunities.filter((item) => item.leverKey === "directory");
  const reddit = opportunities.filter((item) => item.leverKey === "reddit");
  const malformed = opportunities.filter((item) => {
    if (
      typeof item.key !== "string" ||
      typeof item.title !== "string" ||
      typeof item.priority !== "number" ||
      !["directory", "reddit"].includes(item.leverKey)
    ) {
      return true;
    }
    try {
      const url = new URL(item.submissionUrl ?? item.url);
      return !["http:", "https:"].includes(url.protocol);
    } catch {
      return true;
    }
  });
  return {
    ok:
      opportunities.length >= 8 &&
      directories.length >= 5 &&
      reddit.length >= 3 &&
      new Set(keys).size === keys.length &&
      malformed.length === 0,
    total: opportunities.length,
    directories: directories.length,
    reddit: reddit.length,
    duplicateKeys: keys.length - new Set(keys).size,
    malformed: malformed.length,
  };
}

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: EMAIL },
    select: {
      id: true,
      business: {
        where: { id: BUSINESS_ID },
        select: {
          id: true,
          isActive: true,
          websiteSubscription: { select: { status: true, trialStatus: true } },
        },
      },
    },
  });
  const business = user?.business[0];
  if (!business || !business.isActive) throw new Error("Target ownership check failed.");
  if (
    business.websiteSubscription?.status !== "active" ||
    ["trialing", "expired"].includes(business.websiteSubscription.trialStatus)
  ) {
    throw new Error("Target business is not paid-active.");
  }

  const before = await prisma.offPageResearchCache.findUnique({
    where: { businessId: BUSINESS_ID },
  });
  if (!before || !before.payload || typeof before.payload !== "object") {
    throw new Error("Existing cache row is unavailable; refusing blind replacement.");
  }
  const oldPayload = before.payload as JsonObject;
  const oldOpportunities = Array.isArray(oldPayload.opportunities)
    ? (oldPayload.opportunities as JsonObject[])
    : [];
  const statusesBefore = await prisma.offPageOpportunity.findMany({
    where: { businessId: BUSINESS_ID },
    orderBy: { opportunityKey: "asc" },
  });

  const directories = [
    directoryOpportunity({
      key: "directory:homestars-canada",
      title: "Create a landscaping contractor profile on HomeStars Canada",
      url: "https://www.homestars.com/pro/register",
      priority: 92,
      rationale:
        "Current Canadian home-services marketplace with a dedicated Landscaping Company category, professional verification, homeowner leads, and a free profile entry point.",
      pricingModel: "freemium",
      sourceType: "marketplace",
      submissionUrlType: "add_business",
      qualitySignals: ["Dedicated landscaping category", "Canadian homeowner lead channel"],
    }),
    directoryOpportunity({
      key: "directory:landscape-ontario-green-trade",
      title: "Apply for Landscape Ontario Green Trade membership",
      url: "https://members.landscapeontario.com/membership/",
      priority: 90,
      rationale:
        "Ontario's specialist landscape and horticulture association offers member profiles, consumer referrals, professional credibility, education, and a Mississauga-area market fit.",
      pricingModel: "paid",
      sourceType: "association",
      submissionUrlType: "membership_application",
      qualitySignals: ["Specialist Ontario authority", "Consumer referral profile included"],
    }),
    directoryOpportunity({
      key: "directory:houzz-canada",
      title: "Create a landscape contractor portfolio on Houzz Canada",
      url: "https://www.houzz.com/getStartedPro",
      priority: 86,
      rationale:
        "Houzz currently supports Canadian professional profiles and is well suited to visual sod, interlock, deck, fence, retaining-wall, and full-yard project portfolios.",
      pricingModel: "freemium",
      sourceType: "marketplace",
      submissionUrlType: "add_business",
      qualitySignals: ["Canadian professional profiles confirmed", "Strong visual project fit"],
    }),
    directoryOpportunity({
      key: "directory:apple-business-connect",
      title: "Claim and complete Apple Business Connect",
      url: "https://businessconnect.apple.com/",
      priority: 81,
      rationale:
        "Improves business information and discovery across Apple Maps and Apple devices for local service searches and navigation.",
      pricingModel: "free",
      sourceType: "business_profile",
      submissionUrlType: "direct_claim",
      qualitySignals: ["Major map ecosystem", "Free direct claim path"],
    }),
    directoryOpportunity({
      key: "directory:bing-places-for-business",
      title: "Claim and complete Bing Places for Business",
      url: "https://www.bingplaces.com/",
      priority: 77,
      rationale:
        "Adds a consistent local profile across Bing and Microsoft search surfaces and can import verified Google Business information.",
      pricingModel: "free",
      sourceType: "business_profile",
      submissionUrlType: "direct_claim",
      qualitySignals: ["Major search ecosystem", "Free local profile"],
    }),
    directoryOpportunity({
      key: "directory:yelp-canada",
      title: "Claim and complete the Yelp business profile",
      url: "https://biz.yelp.com/",
      priority: 72,
      rationale:
        "Provides an additional review and local-service discovery surface; use the free claimed profile and avoid unnecessary paid upgrades until lead quality is measured.",
      pricingModel: "freemium",
      sourceType: "review_platform",
      submissionUrlType: "direct_claim",
      qualitySignals: ["Review platform", "Local-service category fit"],
    }),
  ];

  const reddit = [
    redditOpportunity({
      key: "reddit:r-mississauga-property-grading",
      subreddit: "r/Mississauga",
      title: "Landscaping - property grading",
      url: "https://www.reddit.com/r/mississauga/comments/1u0kzxj/landscaping_property_grading/",
      priority: 90,
      rationale:
        "Recent Mississauga homeowner request directly related to grading, drainage, sod preparation, and quote evaluation.",
      createdAt: "2026-06-08T21:12:32.000Z",
      locationFit: "Mississauga buyer-intent discussion",
      draft:
        "For grading quotes, ask each contractor to document the proposed slope away from the house, how they will handle existing low spots and downspouts, how much soil will be removed or added, and whether compaction and final drainage testing are included. A low quote can cover only surface levelling, while a complete scope may include excavation, screened topsoil, disposal, compaction, and sod preparation. Compare those line items rather than only the total price.",
    }),
    redditOpportunity({
      key: "reddit:r-lawncare-canada-mississauga-sod-grading",
      subreddit: "r/lawncare_canada",
      title: "Solutions for my lawn?",
      url: "https://www.reddit.com/r/lawncare_canada/comments/1t5s96d/solutions_for_my_lawn/",
      priority: 88,
      rationale:
        "Current Mississauga discussion about pooling, grading, sod versus seed, and evaluating an unusually low installed-sod quote.",
      createdAt: "2026-05-06T00:00:00.000Z",
      locationFit: "Mississauga and GTA service match",
      draft:
        "The pooling should be solved before sod or seed goes down. Ask whether the quote includes removing failed material, correcting the subgrade, adding screened topsoil to a specified depth, disposal, final slope verification, and watering instructions. A per-square-foot number can be reasonable for sod placement but still exclude meaningful grading and drainage work, so get the scope in writing before comparing prices.",
    }),
    redditOpportunity({
      key: "reddit:r-lawncare-canada-new-sod-care",
      subreddit: "r/lawncare_canada",
      title: "Advice needed for new lawn",
      url: "https://www.reddit.com/r/lawncare_canada/comments/1ul70qj/advice_needed_for_new_lawn/",
      priority: 83,
      rationale:
        "Very recent Ontario new-sod discussion where practical establishment and maintenance advice can demonstrate genuine expertise without promotion.",
      createdAt: "2026-07-02T00:00:00.000Z",
      locationFit: "Ontario climate and sod-installation fit",
      draft:
        "If the sod is rooted enough that the corners no longer lift, the first mow is usually appropriate. Use a sharp blade, mow when the surface is firm rather than saturated, and remove no more than one-third of the blade height. Keep it on the taller side during hot weather. Water deeply enough to reach the soil below the sod, but reduce frequency as roots establish so the lawn is not constantly waterlogged. Fertilizer timing should follow the sod grower's recommendation and local conditions rather than a fixed schedule.",
    }),
    redditOpportunity({
      key: "reddit:r-lawncare-canada-ontario-interlock",
      subreddit: "r/lawncare_canada",
      title: "DIY Help Needed",
      url: "https://www.reddit.com/r/lawncare_canada/comments/1uvn41s/diy_help_needed/",
      priority: 80,
      rationale:
        "Current Ontario discussion involving grading, landscape fabric, and interlock preparation—directly aligned with hardscaping expertise.",
      createdAt: "2026-07-13T00:00:00.000Z",
      locationFit: "Ontario interlock and grading topic",
      draft:
        "For an interlock area, focus first on excavation depth, a properly compacted granular base in lifts, edge restraint, and a slight slope away from structures. Landscape fabric is not a substitute for base preparation and is not always needed between the bedding layer and compacted aggregate. Confirm the paver manufacturer's base and bedding specifications, especially for Ontario freeze-thaw conditions, before buying materials.",
    }),
  ];

  const curated = [...directories, ...reddit].sort(
    (a, b) => b.priority - a.priority,
  );
  const validation = validate(curated);
  if (!validation.ok) {
    throw new Error(`Curated payload failed validation: ${JSON.stringify(validation)}`);
  }

  const removed = oldOpportunities
    .filter((item) => !curated.some((candidate) => candidate.key === item.key))
    .map((item) => ({
      key: item.key,
      leverKey: item.leverKey,
      title: item.title,
      reason: "Removed during manual current-relevance and destination-quality review.",
      score: 0,
    }));
  const payload = {
    ...oldPayload,
    opportunities: curated,
    appliedLevers: ["directory", "reddit"],
    generatedAt: checkedAt,
    qualitySummary: {
      totalCandidates: curated.length + removed.length,
      shown: curated.length,
      rejected: removed.length,
      hiddenLowConfidence: 0,
      averageConfidence: Math.round(
        curated.reduce((sum, item) => sum + item.confidence, 0) / curated.length,
      ),
      byLever: {
        directory: directories.length,
        reddit: reddit.length,
      },
      curationMode: "manual_public_research_no_customer_export",
      curatedAt: checkedAt,
    },
    rejectedOpportunities: removed,
    manualCuration: {
      curatedAt: checkedAt,
      reason:
        "Removed invalid, redundant, old, out-of-market, or unverified opportunities and added current official directories plus recent Ontario Reddit discussions.",
      externalCustomerDataShared: false,
    },
  };

  const reportDir = join(process.cwd(), "reports");
  await mkdir(reportDir, { recursive: true });
  const stamp = checkedAt.replaceAll(":", "-");
  const backupPath = join(
    reportDir,
    `hr-greenroots-offpage-cache-pre-curation-${stamp}.json`,
  );
  await writeFile(
    backupPath,
    JSON.stringify({ capturedAt: checkedAt, cache: before, statusesBefore }, null, 2),
  );

  await prisma.$transaction(async (tx) => {
    const statusCount = await tx.offPageOpportunity.count({
      where: { businessId: BUSINESS_ID },
    });
    if (statusCount !== statusesBefore.length) {
      throw new Error("Opportunity status rows changed during curation; aborting.");
    }
    await tx.offPageResearchCache.update({
      where: { businessId: BUSINESS_ID },
      data: {
        payload: payload as Prisma.InputJsonValue,
        generatedAt: now,
        expiresAt: new Date(now.getTime() + 7 * 86_400_000),
      },
    });
  });

  const after = await prisma.offPageResearchCache.findUnique({
    where: { businessId: BUSINESS_ID },
  });
  const statusesAfter = await prisma.offPageOpportunity.findMany({
    where: { businessId: BUSINESS_ID },
    orderBy: { opportunityKey: "asc" },
  });
  const afterOpportunities =
    after?.payload &&
    typeof after.payload === "object" &&
    Array.isArray((after.payload as JsonObject).opportunities)
      ? ((after.payload as JsonObject).opportunities as JsonObject[])
      : [];
  const afterValidation = validate(afterOpportunities);
  if (
    !afterValidation.ok ||
    JSON.stringify(statusesAfter) !== JSON.stringify(statusesBefore)
  ) {
    await prisma.offPageResearchCache.update({
      where: { businessId: BUSINESS_ID },
      data: {
        inputHash: before.inputHash,
        payload: before.payload as Prisma.InputJsonValue,
        generatedAt: before.generatedAt,
        expiresAt: before.expiresAt,
      },
    });
    throw new Error("Post-write verification failed; prior cache restored.");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        businessId: BUSINESS_ID,
        backupPath,
        before: {
          generatedAt: before.generatedAt,
          opportunities: oldOpportunities.length,
        },
        after: {
          generatedAt: after?.generatedAt,
          expiresAt: after?.expiresAt,
          validation: afterValidation,
          keys: afterOpportunities.map((item) => item.key),
        },
        removed: removed.map((item) => item.key),
        statusRowsUnchanged: statusesAfter.length,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
