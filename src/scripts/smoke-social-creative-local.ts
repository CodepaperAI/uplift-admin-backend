import { randomUUID } from "node:crypto";

import { prisma } from "../config/db.config";
import { resolveSocialCreativeFormat } from "../services/social-creative/formats";
import { socialCreativeImageCostUsd } from "../services/social-creative/constants";
import {
  checkpointSocialCreativeProviderResult,
  claimSocialCreativeAsset,
  completeSocialCreativeAsset,
  createOrGetSocialCreativeRun,
  finalizeSocialCreativeRun,
  getSocialCreativeRunForUser,
  persistSocialCreativePlan,
  recordSocialCreativeImageUsage,
} from "../services/social-creative/repository";

function assertLocalDatabase(): void {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) throw new Error("DATABASE_URL is required");
  const host = new URL(raw).hostname;
  if (!["localhost", "127.0.0.1", "host.docker.internal"].includes(host)) {
    throw new Error(`Refusing social creative smoke writes to non-local database host ${host}`);
  }
}

assertLocalDatabase();

const suffix = randomUUID();
const userId = randomUUID();
const businessId = randomUUID();

try {
  await prisma.user.create({
    data: {
      id: userId,
      email: `social-creative-smoke-${suffix}@example.test`,
      name: "Social Creative Smoke",
      emailVerified: true,
      business: {
        create: {
          id: businessId,
          businessName: "Local Social Creative Test",
          businessType: "Landscaping company",
          businessDescription: "A local fixture used only for backend smoke testing.",
          businessWebsiteUrl: "https://example.com",
          businessCity: "Toronto",
          businessCountry: "Canada",
          serviceAreaLocations: ["Toronto"],
          preferredContentTypes: ["guides"],
          supportedLanguages: ["en"],
          exampleBlogUrls: [],
          defaultLanguage: "en",
          defaultLocale: "en-CA",
          selectedServices: ["Garden maintenance"],
          websiteSubscription: {
            create: { status: "active", trialStatus: "none" },
          },
          BrandAnalysis: {
            create: {
              primaryColors: ["#22543d"],
              secondaryColors: ["#f0fff4"],
              fontFamily: "Montserrat",
            },
          },
        },
      },
    },
  });

  const format = resolveSocialCreativeFormat("instagram");
  const run = await createOrGetSocialCreativeRun({
    userId,
    businessId,
    topic: "Preparing garden beds for spring",
    kind: "single",
    source: "MANUAL",
    platforms: ["instagram"],
    estimatedBudgetUsd: socialCreativeImageCostUsd(format.sourceSize),
    idempotencyKey: `local-social-smoke:${suffix}`,
  });
  const assetIds = await persistSocialCreativePlan({
    runId: run.id,
    businessId,
    plan: {
      language: "en",
      locale: "en-CA",
      topic: "Preparing garden beds for spring",
      slides: [
        {
          slideIndex: 0,
          topic: "Preparing garden beds for spring",
          headline: "Preparing garden beds for spring",
          supportingLine: "",
          cta: "",
          caption: "Preparing garden beds for spring",
          visualConcept: "Provider-composed website campaign",
          campaignObjective: "conversion",
          archetype: "website-campaign",
          layoutFamily: "none",
        },
      ],
    },
    assets: [
      {
        slideIndex: 0,
        platform: "instagram",
        width: format.width,
        height: format.height,
        aspectRatio: format.aspectRatio,
        sourceSize: format.sourceSize,
        prompt: "Direct website campaign fixture prompt",
      },
    ],
  });
  const assetId = assetIds[0]!;
  if (!(await claimSocialCreativeAsset(assetId))) {
    throw new Error("Local asset could not be claimed");
  }
  await checkpointSocialCreativeProviderResult({
    assetId,
    providerRequestId: `local-image-${suffix}`,
    sha256: "0".repeat(64),
    estimatedUsd: socialCreativeImageCostUsd(format.sourceSize),
  });
  await recordSocialCreativeImageUsage({
    runId: run.id,
    assetId,
    providerRequestId: `local-image-${suffix}`,
    estimatedUsd: socialCreativeImageCostUsd(format.sourceSize),
    metadata: { localSmoke: true },
  });
  await completeSocialCreativeAsset({
    assetId,
    imageUrl: "https://uplift-ai-images.b-cdn.net/social-smoke.jpg",
    qualityResult: { ok: true, localSmoke: true },
    compositorDiagnostics: {
      mode: "provider-direct",
      compositorApplied: false,
      resized: false,
      reencoded: false,
    },
  });
  const summary = await finalizeSocialCreativeRun(run.id);
  const persisted = await getSocialCreativeRunForUser({ runId: run.id, userId });
  if (!persisted || summary.status !== "COMPLETE") {
    throw new Error("Local social creative run did not persist successfully");
  }
  console.log(
    JSON.stringify(
      {
        success: true,
        runStatus: persisted.status,
        posts: persisted.posts.length,
        assets: persisted.posts.flatMap((post) => post.assets).length,
        actualCostUsd: summary.actualCostUsd,
        database: "local-only",
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  await prisma.$disconnect();
}
