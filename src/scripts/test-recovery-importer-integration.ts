import { createPrismaClient } from "../config/prisma-client.factory";
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import {
  computeRecoveryPackageDigest,
  getRecoveryRuntimeEnvironment,
  importRecoveryDraft,
  type RecoveryApprovedManifest,
  type RecoveryDraftPackage,
  type RecoveryImportOptions,
} from "../services/recovery-blog-importer.service";

function assertIsolatedTestRuntime(): void {
  const environment = getRecoveryRuntimeEnvironment();
  const environmentValues = [
    ...new Set(environment.markers.map((marker) => marker.value)),
  ];
  if (environmentValues.length !== 1 || environment.isProduction) {
    throw new Error("Refusing to run importer integration tests in production");
  }
  if (process.env.RECOVERY_TEST_DATABASE_CONFIRMED !== "true") {
    throw new Error(
      "Set RECOVERY_TEST_DATABASE_CONFIRMED=true only for an isolated local/development database",
    );
  }
  if (process.env.RECOVERY_DRAFT_IMPORT_ENABLED !== "true") {
    throw new Error(
      "RECOVERY_DRAFT_IMPORT_ENABLED=true is required for the isolated importer integration test",
    );
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const parsedDatabaseUrl = new URL(url);
  const hostname = parsedDatabaseUrl.hostname.toLocaleLowerCase();
  const databaseName = parsedDatabaseUrl.pathname.replace(/^\//, "");
  const confirmedTestHostname = process.env.RECOVERY_TEST_DATABASE_HOST
    ?.trim()
    .toLocaleLowerCase();
  const confirmedTestDatabaseName =
    process.env.RECOVERY_TEST_DATABASE_NAME?.trim();
  if (!confirmedTestHostname || hostname !== confirmedTestHostname) {
    throw new Error(
      "RECOVERY_TEST_DATABASE_HOST must exactly match the isolated database host",
    );
  }
  if (
    !confirmedTestDatabaseName ||
    databaseName !== confirmedTestDatabaseName
  ) {
    throw new Error(
      "RECOVERY_TEST_DATABASE_NAME must exactly match the isolated database name",
    );
  }
  const productionHostname = process.env.RECOVERY_PRODUCTION_DATABASE_HOST
    ?.trim()
    .toLocaleLowerCase();
  if (productionHostname && hostname === productionHostname) {
    throw new Error(
      "Refusing to run against the configured production database host",
    );
  }
}

function authorizedApplyOptions(
  pkg: RecoveryDraftPackage,
): RecoveryImportOptions {
  const manifest: RecoveryApprovedManifest = {
    schemaVersion: 1,
    manifestId: `integration-manifest-${pkg.packageId}`,
    batchId: pkg.batchId,
    mode: "canary",
    generatedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    approval: {
      status: "approved",
      approvedAt: new Date(Date.now() - 60_000).toISOString(),
      approvedBy: "Isolated Integration Test",
    },
    entries: [
      {
        packageId: pkg.packageId,
        planId: pkg.planId,
        userId: pkg.userId,
        businessId: pkg.businessId,
        route: "CREATE",
        generationAuthorized: true,
        validation: {
          status: "approved",
          blockers: [],
          validatorVersion: pkg.validation.validatorVersion,
        },
        approvedBusinessHost: "example.test",
        approvedCanonicalUrl: pkg.canonical?.url ?? null,
        packageDigest: computeRecoveryPackageDigest(pkg),
      },
    ],
  };
  return {
    apply: true,
    authorization: {
      manifest,
      confirmBatch: pkg.batchId,
      approval: "APPROVE_PRODUCTION_CANARY",
      invocationPackageCount: 1,
    },
  };
}

function packageFixture(input: {
  packageId: string;
  batchId: string;
  planId: string;
  userId: string;
  businessId: string;
  keyword: string;
  slug: string;
}): RecoveryDraftPackage {
  const researchRetrievedAt = new Date(Date.now() - 60_000);
  const validatedAt = new Date(researchRetrievedAt.getTime() + 30_000);

  return {
    schemaVersion: 1,
    packageId: input.packageId,
    batchId: input.batchId,
    planId: input.planId,
    userId: input.userId,
    businessId: input.businessId,
    route: {
      action: "create_blog",
      intentFingerprint: `integration:${input.businessId}:${input.keyword}`,
      rationale: "Dedicated recovery importer integration fixture.",
    },
    validation: {
      status: "approved",
      validatorVersion: "integration-validator-v1",
      validatedAt: validatedAt.toISOString(),
      blockers: [],
      warnings: [],
    },
    provenance: {
      engineVersion: "integration-test-v1",
      sourceUrls: ["https://example.test/services"],
      researchRetrievedAt: researchRetrievedAt.toISOString(),
      researchArtifactId: `research-${input.packageId}`,
    },
    canonical: {
      url: `https://example.test/blog/${input.slug}`,
      verified: true,
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "Recovery Importer Integration Test",
    },
    blog: {
      businessId: input.businessId,
      title: `Recovery Importer Integration ${input.slug}`,
      slug: input.slug,
      status: "PUBLISH",
      author: "Integration Test",
      content:
        "<article><h1>Recovery Importer Integration Test</h1><p>Isolated test content.</p></article>",
      excerpt: "Isolated recovery importer integration content.",
      categories: ["Integration Test"],
      tags: ["recovery importer"],
      featured_media: "https://example.test/images/recovery.jpg",
      seoScore: 100,
      meta: {
        seo_title: "Recovery Importer Integration Test",
        seo_description: "Verify the isolated recovery draft importer transaction.",
        focus_keyword: input.keyword,
        keywords: [input.keyword],
      },
      custom_fields: {
        reading_time: "1 min read",
        rating: 10,
      },
      blogPublishInfo: {
        date: "2099-12-31",
        time: "23:59",
      },
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  assertIsolatedTestRuntime();
  const prisma = createPrismaClient({ log: [] });
  const suffix = randomUUID();
  const userId = `recovery-test-user-${suffix}`;
  const businessId = `recovery-test-business-${suffix}`;
  const successPlanId = `recovery-test-plan-success-${suffix}`;
  const rollbackPlanId = `recovery-test-plan-rollback-${suffix}`;
  const batchId = `recovery-test-batch-${suffix}`;
  const createdMetaIds: string[] = [];
  const createdCustomFieldIds: string[] = [];

  try {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        name: "Recovery Import Test",
        role: "USER",
      },
    });
    await prisma.business.create({
      data: {
        id: businessId,
        userId,
        businessName: "Recovery Importer Test Business",
        businessType: "Integration Test",
        businessDescription: "Dedicated non-production importer fixture.",
        businessWebsiteUrl: "https://example.test",
        serviceAreaLocations: [],
        preferredContentTypes: [],
        supportedLanguages: ["en"],
        exampleBlogUrls: [],
        selectedServices: ["Integration Testing"],
        authorExpertise: ["Integration Testing"],
        isActive: true,
        websiteStatus: "active",
      },
    });
    await prisma.websiteSubscription.create({
      data: {
        businessId,
        status: "active",
        trialStatus: "none",
      },
    });
    await prisma.plan.createMany({
      data: [
        {
          id: successPlanId,
          userId,
          businessId,
          keyword: `integration success ${suffix}`,
          publishDate: "2026-07-14",
          publishTime: "08:00",
          keywordDiffculty: "0",
          keywordSearchVolume: "0",
        },
        {
          id: rollbackPlanId,
          userId,
          businessId,
          keyword: `integration rollback ${suffix}`,
          publishDate: "2026-07-15",
          publishTime: "09:00",
          keywordDiffculty: "0",
          keywordSearchVolume: "0",
        },
      ],
    });

    const successPackage = packageFixture({
      packageId: `success-${suffix}`,
      batchId,
      planId: successPlanId,
      userId,
      businessId,
      keyword: `integration success ${suffix}`,
      slug: `integration-success-${suffix}`,
    });
    const beforeDryRun = await prisma.blog.count({ where: { businessId } });
    const dryRun = await importRecoveryDraft(prisma, successPackage);
    const afterDryRun = await prisma.blog.count({ where: { businessId } });
    assert(dryRun.status === "ready", "Dry-run did not report ready");
    assert(beforeDryRun === afterDryRun, "Dry-run wrote a Blog row");
    assert(
      dryRun.mutationReceipt?.plan.before.blogId === null &&
        dryRun.mutationReceipt.plan.after.isUsed === true &&
        dryRun.mutationReceipt.blog?.status === "DRAFT",
      "Dry-run did not return the expected sanitized mutation preview",
    );

    const successApplyOptions = authorizedApplyOptions(successPackage);
    const imported = await importRecoveryDraft(
      prisma,
      successPackage,
      successApplyOptions,
    );
    assert(imported.status === "imported", "Apply did not import the fixture");
    assert(imported.blogId, "Apply did not return a Blog ID");
    assert(
      imported.mutationReceipt?.plan.after.blogId === imported.blogId &&
        imported.mutationReceipt.blog?.id === imported.blogId,
      "Apply did not return the expected sanitized before/after receipt",
    );

    const persisted = await prisma.blog.findUnique({
      where: { id: imported.blogId },
      include: { meta: true, customField: true, Plan: true },
    });
    assert(persisted?.status === "DRAFT", "Imported Blog was not forced to DRAFT");
    assert(
      persisted.blogPublishDate === "2026-07-14" &&
        persisted.blogPublishTime === "08:00",
      "Imported Blog did not use the Plan schedule",
    );
    assert(
      persisted.Plan.length === 1 && persisted.Plan[0]?.id === successPlanId,
      "Imported Blog was not linked to exactly one expected Plan",
    );
    createdMetaIds.push(persisted.metaId);
    createdCustomFieldIds.push(persisted.customFieldId);

    const rerun = await importRecoveryDraft(
      prisma,
      successPackage,
      successApplyOptions,
    );
    assert(rerun.status === "already_imported", "Rerun was not idempotent");
    assert(rerun.blogId === imported.blogId, "Rerun returned a different Blog ID");
    assert(
      rerun.mutationReceipt?.plan.before.blogId === imported.blogId &&
        rerun.mutationReceipt.plan.after.blogId === imported.blogId,
      "Idempotent rerun receipt did not preserve the linked Blog ID",
    );
    assert(
      (await prisma.blog.count({ where: { businessId } })) === 1,
      "Rerun created a duplicate Blog",
    );

    const rollbackPackage = packageFixture({
      packageId: `rollback-${suffix}`,
      batchId,
      planId: rollbackPlanId,
      userId,
      businessId,
      keyword: `integration rollback ${suffix}`,
      slug: `integration-rollback-${suffix}`,
    });
    const rollback = await importRecoveryDraft(prisma, rollbackPackage, {
      ...authorizedApplyOptions(rollbackPackage),
      simulateFailureAt: "after_blog_create",
    });
    assert(
      rollback.status === "blocked" &&
        rollback.blockCodes.includes("simulated_failure"),
      "Forced failure did not return the expected blocker",
    );
    assert(
      rollback.mutationReceipt === null,
      "Blocked rollback result should not claim a persisted mutation",
    );
    const rollbackPlan = await prisma.plan.findUnique({
      where: { id: rollbackPlanId },
      select: { blogId: true, isUsed: true, usedAt: true },
    });
    assert(
      rollbackPlan?.blogId === null &&
        rollbackPlan.isUsed === false &&
        rollbackPlan.usedAt === null,
      "Forced failure did not roll back the Plan",
    );
    assert(
      (await prisma.blog.count({ where: { businessId } })) === 1,
      "Forced failure persisted a second Blog",
    );

    console.log(
      JSON.stringify(
        {
          status: "passed",
          environment: "isolated_local_or_development",
          checks: {
            dryRunReadOnly: true,
            forcedDraft: true,
            planSchedulePreserved: true,
            exactPlanLink: true,
            idempotentRerun: true,
            forcedFailureRolledBack: true,
            sanitizedMutationReceipts: true,
          },
          externalSideEffectPathsInvoked: [],
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.blog.deleteMany({ where: { businessId } });
    await prisma.plan.deleteMany({ where: { businessId } });
    await prisma.websiteSubscription.deleteMany({ where: { businessId } });
    await prisma.business.deleteMany({ where: { id: businessId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    if (createdMetaIds.length > 0) {
      await prisma.meta.deleteMany({ where: { id: { in: createdMetaIds } } });
    }
    if (createdCustomFieldIds.length > 0) {
      await prisma.customField.deleteMany({
        where: { id: { in: createdCustomFieldIds } },
      });
    }
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
