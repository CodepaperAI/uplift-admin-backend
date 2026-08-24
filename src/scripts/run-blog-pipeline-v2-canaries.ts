import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const APPROVED_DATABASE_HOST =
  "ep-tiny-credit-adztmoai-pooler.c-2.us-east-1.aws.neon.tech";
const APPROVAL = "APPROVE_STAGED_V3_PRODUCTION_V1_10_CANARIES";
const PIPELINE_VERSION = "staged-v3-production-v1" as const;
const MAX_PROVIDER_SPEND_USD = 5;
const EXACT_CANARY_COUNT = 10;

function argument(name: string): string | null {
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3).trim() || null;
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : null;
  return value && !value.startsWith("--") ? value.trim() : null;
}

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().replace(/^export\s+/, "");
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

async function loadLocalProviderSecrets(): Promise<void> {
  const local = parseEnv(await readFile(resolve(process.cwd(), ".env"), "utf8"));
  const allowed = [
    "OPENAI_API_KEY",
    "PINECONE_API_KEY",
    "BUNNY_STORAGE_ZONE",
    "BUNNY_STORAGE_ACCESS_KEY",
    "BUNNY_STORAGE_ENDPOINT",
    "BUNNY_CDN_BASE_URL",
    "BUNNY_VERIFY_PUBLIC_UPLOADS",
    "SCRAPER_API_KEY",
    "CONTEXT_API_KEY",
    "CONTEXT_DEV_API_KEY",
  ];
  for (const key of allowed) {
    if (local[key]) process.env[key] = local[key];
  }
}

function productionGuard(mode: string): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const host = new URL(databaseUrl).hostname;
  if (host !== APPROVED_DATABASE_HOST) {
    throw new Error(`Unexpected database host ${host}`);
  }
  if (process.env.RECOVERY_PRODUCTION_READ_CONFIRMED !== "true") {
    throw new Error("RECOVERY_PRODUCTION_READ_CONFIRMED=true is required");
  }
  if (mode === "run") {
    if (process.env.RECOVERY_PRODUCTION_WRITE_CONFIRMED !== "true") {
      throw new Error("RECOVERY_PRODUCTION_WRITE_CONFIRMED=true is required");
    }
    if (process.env.BLOG_PIPELINE_V2_CANARY_APPROVAL !== APPROVAL) {
      throw new Error(`BLOG_PIPELINE_V2_CANARY_APPROVAL must equal ${APPROVAL}`);
    }
  }
}

function torontoDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function metadataRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function arrayValue(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

async function checkImageUrl(url: string) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    return {
      url,
      working: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type"),
    };
  } catch (error) {
    return {
      url,
      working: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const mode = argument("mode") ?? "select";
  if (!new Set(["select", "run"]).has(mode)) {
    throw new Error("--mode must be select or run");
  }
  await loadLocalProviderSecrets();
  productionGuard(mode);
  process.env.PINECONE_DEAD_VECTOR_PRUNE_ENABLED = "false";

  const [{ prisma }, pipeline, editorial, { inngest }] = await Promise.all([
    import("../config/db.config"),
    import("../services/blog-pipeline-v2"),
    import("../services/blog-pipeline-v2/staged-writer"),
    import("../inngest/client"),
  ]);
  const requestedPlanIds = new Set(
    (argument("plan-ids") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (requestedPlanIds.size > 0 && requestedPlanIds.size !== EXACT_CANARY_COUNT) {
    throw new Error(`--plan-ids must contain exactly ${EXACT_CANARY_COUNT} IDs`);
  }
  if (mode === "run" && requestedPlanIds.size !== EXACT_CANARY_COUNT) {
    throw new Error(
      `--mode=run requires the exact approved cohort through --plan-ids (${EXACT_CANARY_COUNT} IDs)`,
    );
  }
  const running = await prisma.blogGenerationRun.findMany({
    where: { status: "RUNNING" },
    select: { correlationId: true, metadata: true },
  });
  const runningPlanIds = new Set(
    running.flatMap((run) => {
      const planId = metadataRecord(run.metadata).planId;
      return typeof planId === "string" && planId ? [planId] : [];
    }),
  );
  const candidates = await prisma.plan.findMany({
    where: {
      ...(requestedPlanIds.size > 0 ? { id: { in: [...requestedPlanIds] } } : {}),
      deletedAt: null,
      ...(requestedPlanIds.size > 0
        ? {}
        : { blogId: null, isUsed: false, usedAt: null }),
      businessId: { not: null },
      publishDate: { lte: torontoDate() },
      business: {
        is: {
          isActive: true,
          websiteStatus: "active",
          User: { role: { notIn: ["ADMIN", "SUPERADMIN"] } },
        },
      },
      OR: [
        {
          business: {
            is: {
              websiteSubscription: {
                is: { status: "active", trialStatus: { in: ["none", "converted"] } },
              },
            },
          },
        },
        { user: { is: { Subscription: { is: { status: "active" } } } } },
      ],
    },
    select: {
      id: true,
      userId: true,
      businessId: true,
      keyword: true,
      publishDate: true,
      publishTime: true,
      blogId: true,
      isUsed: true,
      usedAt: true,
      blog: {
        select: {
          id: true,
          userId: true,
          businessId: true,
          status: true,
          analytics: true,
        },
      },
      business: {
        select: {
          businessName: true,
          businessWebsiteUrl: true,
          defaultLocale: true,
        },
      },
    },
    orderBy: [{ publishDate: "asc" }, { createdAt: "asc" }],
    take: requestedPlanIds.size > 0 ? EXACT_CANARY_COUNT : 500,
  });
  if (requestedPlanIds.size > 0 && candidates.length !== EXACT_CANARY_COUNT) {
    throw new Error(
      `Expected all ${EXACT_CANARY_COUNT} approved Plan IDs to remain active and paid; found ${candidates.length}`,
    );
  }
  const cohort: typeof candidates = [];
  const selectedBusinessIds = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.businessId) continue;
    if (runningPlanIds.has(candidate.id)) {
      if (requestedPlanIds.size > 0) {
        throw new Error(`Approved Plan ${candidate.id} still has a RUNNING generation`);
      }
      continue;
    }
    if (requestedPlanIds.size === 0 && selectedBusinessIds.has(candidate.businessId)) {
      continue;
    }
    if (candidate.blogId) {
      const analytics = metadataRecord(candidate.blog?.analytics);
      const productionPipeline = metadataRecord(analytics.productionPipeline);
      if (
        !candidate.isUsed ||
        !candidate.usedAt ||
        candidate.blog?.id !== candidate.blogId ||
        candidate.blog?.userId !== candidate.userId ||
        candidate.blog?.businessId !== candidate.businessId ||
        candidate.blog?.status !== "PUBLISH" ||
        productionPipeline.version !== PIPELINE_VERSION ||
        productionPipeline.planId !== candidate.id ||
        productionPipeline.correlationId !== `${PIPELINE_VERSION}:${candidate.id}`
      ) {
        throw new Error(
          `Approved Plan ${candidate.id} is linked by a different or inconsistent pipeline`,
        );
      }
      cohort.push(candidate);
      selectedBusinessIds.add(candidate.businessId);
      continue;
    }
    if (candidate.isUsed || candidate.usedAt) {
      throw new Error(`Approved Plan ${candidate.id} is unlinked but already marked used`);
    }
    const duplicate = await prisma.blog.findFirst({
      where: {
        businessId: candidate.businessId,
        meta: {
          is: {
            focus_keyword: { equals: candidate.keyword, mode: "insensitive" },
          },
        },
      },
      select: { id: true },
    });
    if (duplicate) {
      if (requestedPlanIds.size > 0) {
        throw new Error(
          `Approved Plan ${candidate.id} conflicts with existing Blog ${duplicate.id}`,
        );
      }
      continue;
    }
    cohort.push(candidate);
    selectedBusinessIds.add(candidate.businessId);
    if (cohort.length === EXACT_CANARY_COUNT) break;
  }
  if (cohort.length !== EXACT_CANARY_COUNT) {
    throw new Error(
      `Expected exactly ${EXACT_CANARY_COUNT} genuinely missing or exact-v2-resumable paid Plans; found ${cohort.length}`,
    );
  }
  const pending = cohort.filter((plan) => !plan.blogId);
  console.log(
    JSON.stringify(
      {
        mode,
        pipelineVersion: PIPELINE_VERSION,
        databaseHost: APPROVED_DATABASE_HOST,
        count: cohort.length,
        pendingCount: pending.length,
        completedWithoutProviderReplay: cohort.length - pending.length,
        plans: cohort.map((plan) => ({
          id: plan.id,
          userId: plan.userId,
          businessId: plan.businessId,
          keyword: plan.keyword,
          publishDate: plan.publishDate,
          publishTime: plan.publishTime,
          business: plan.business,
          blogId: plan.blogId,
        })),
        productionWritesPerformed: 0,
        providerCallsPerformed: 0,
      },
      null,
      2,
    ),
  );
  if (mode === "select") {
    await prisma.$disconnect();
    return;
  }

  const results: any[] = cohort
    .filter((plan) => Boolean(plan.blogId))
    .map((plan) => ({
      planId: plan.id,
      blogId: plan.blogId,
      success: true,
      alreadyExisted: true,
      skippedProviderWork: true,
    }));
  for (const [index, plan] of pending.entries()) {
    const before = await pipeline.getProductionBlogPipelineCostReport({
      planIds: cohort.map((item) => item.id),
      prisma,
    });
    if (before.totals.estimatedUsd >= MAX_PROVIDER_SPEND_USD) {
      throw new Error(
        `Canary spend guard reached $${before.totals.estimatedUsd.toFixed(6)}`,
      );
    }
    console.log(
      `[${index + 1}/${pending.length}] ${plan.id} ${plan.business?.businessName}: ${plan.keyword}`,
    );
    try {
      const generated = await pipeline.generateProductionV2Blog({
        planId: plan.id,
        userId: plan.userId,
        businessId: plan.businessId!,
        pipelineVersion: PIPELINE_VERSION,
        prisma,
      });
      const handoff = await inngest.send({
        name: "publishing/auto-publish",
        data: { blogId: generated.blogId },
      });
      await prisma.blogGenerationRun.updateMany({
        where: {
          correlationId: `${PIPELINE_VERSION}:${plan.id}`,
          blogId: generated.blogId,
        },
        data: { finalSaveStatus: "PUBLISH_HANDOFF_QUEUED" },
      });
      results.push({
        planId: plan.id,
        ...generated,
        handoffQueued: true,
        handoffEventIds: handoff.ids,
        generatedThisInvocation: true,
      });
    } catch (error) {
      results.push({
        planId: plan.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const after = await pipeline.getProductionBlogPipelineCostReport({
      planIds: cohort.map((item) => item.id),
      prisma,
    });
    if (after.totals.estimatedUsd > MAX_PROVIDER_SPEND_USD) {
      throw new Error(
        `Canary spend exceeded $${MAX_PROVIDER_SPEND_USD}: $${after.totals.estimatedUsd.toFixed(6)}`,
      );
    }
    if (results.at(-1)?.success === false) break;
  }
  const report = await pipeline.getProductionBlogPipelineCostReport({
    planIds: cohort.map((item) => item.id),
    prisma,
  });
  const verification = await prisma.plan.findMany({
    where: { id: { in: cohort.map((item) => item.id) } },
    select: {
      id: true,
      blogId: true,
      isUsed: true,
      usedAt: true,
      businessId: true,
      blog: {
        select: {
          id: true,
          title: true,
          status: true,
          content: true,
          featured_media: true,
          seoScore: true,
          analytics: true,
          meta: true,
          customField: true,
          publishedBlogs: {
            select: { status: true, externalPostUrl: true, lastError: true },
          },
        },
      },
    },
    orderBy: { id: "asc" },
  });
  const verificationResults = await Promise.all(
    verification.map(async (plan) => {
      const blockers: string[] = [];
      const blog = plan.blog;
      if (!plan.blogId || !plan.isUsed || !plan.usedAt || !blog) {
        blockers.push("plan_not_atomically_linked");
      }
      if (!blog) {
        return {
          planId: plan.id,
          blogId: plan.blogId,
          passed: false,
          blockers,
          externalPublishing: [],
        };
      }
      const analytics = metadataRecord(blog.analytics);
      const productionPipeline = metadataRecord(analytics.productionPipeline);
      const images = arrayValue(productionPipeline.images);
      const approvedLinks = arrayValue(productionPipeline.approvedLinks);
      const normalizedContent = blog.content.replaceAll("&amp;", "&");
      const wordCount = editorial.stagedVisibleWordCount(blog.content);
      const run = report.rows.find((row) => row.planId === plan.id);
      const recentTitles = await prisma.blog.findMany({
        where: { businessId: plan.businessId!, id: { not: blog.id } },
        select: { title: true },
        orderBy: { createdAt: "desc" },
        take: 12,
      });
      blockers.push(
        ...editorial
          .stagedTitleEditorialIssues(blog.title, blog.meta?.focus_keyword ?? "")
          .map((issue) => `title:${issue}`),
        ...editorial
          .agentTestingAdjacentTitleHistoryIssues(
            blog.title,
            recentTitles.map((item) => item.title),
            blog.meta?.focus_keyword ?? "",
          )
          .map((issue) => `title_history:${issue}`),
        ...editorial
          .agentTestingArticleLanguageIssues(
            blog.content,
            String(productionPipeline.locale ?? ""),
          )
          .map((issue) => `language:${issue}`),
      );
      if (blog.status !== "PUBLISH") blockers.push(`blog_status:${blog.status}`);
      if (blog.seoScore !== 100) blockers.push(`seo_score:${blog.seoScore}`);
      const contentQualityScore = Number(analytics.contentQualityScore);
      if (
        !Number.isInteger(contentQualityScore) ||
        contentQualityScore < 91 ||
        contentQualityScore > 100
      ) {
        blockers.push(
          `content_quality_score:${String(analytics.contentQualityScore ?? "missing")}`,
        );
      }
      if (blog.customField?.rating !== 10) {
        blockers.push(`rating:${blog.customField?.rating ?? "missing"}`);
      }
      if (!blog.meta?.focus_keyword) blockers.push("focus_keyword_missing");
      if (wordCount < 1_200 || wordCount > 1_800) {
        blockers.push(`word_count_outside_1200_1800:${wordCount}`);
      }
      if (
        productionPipeline.version !== PIPELINE_VERSION ||
        productionPipeline.planId !== plan.id ||
        productionPipeline.correlationId !== `${PIPELINE_VERSION}:${plan.id}`
      ) {
        blockers.push("pipeline_identity_mismatch");
      }
      if (
        analytics.rankingPotential !== "HIGH" ||
        analytics.conversionPotential !== "HIGH"
      ) {
        blockers.push("ranking_or_conversion_potential_not_high");
      }
      if (
        images.length !== 3 ||
        new Set(images.map((image) => image.url)).size !== 3 ||
        !["featured", "internal-1", "internal-2"].every((role) =>
          images.some((image) => image.role === role),
        )
      ) {
        blockers.push("three_unique_image_roles_missing");
      }
      if (!images.some((image) => image.url === blog.featured_media)) {
        blockers.push("featured_image_mismatch");
      }
      const imageChecks = await Promise.all(
        images
          .map((image) => String(image.url ?? ""))
          .filter(Boolean)
          .map(checkImageUrl),
      );
      if (imageChecks.length !== 3 || imageChecks.some((image) => !image.working)) {
        blockers.push("image_url_not_working");
      }
      for (const link of approvedLinks) {
        if (!link.url || !normalizedContent.includes(String(link.url))) {
          blockers.push(`approved_link_missing:${String(link.url ?? "unknown")}`);
        }
        if (
          link.kind === "managed_backlink" &&
          Number(link.score ?? 0) < pipeline.BLOG_PIPELINE_V2_MANAGED_LINK_MINIMUM_SCORE
        ) {
          blockers.push(`managed_link_below_threshold:${String(link.url ?? "unknown")}`);
        }
      }
      const publicText = `${blog.title}\n${blog.content}`;
      for (const pattern of pipeline.BLOG_PIPELINE_V2_INTERNAL_TERMS) {
        if (pattern.test(publicText)) {
          blockers.push(`internal_terminology:${pattern.source}`);
        }
      }
      if (
        !run ||
        run.status !== "ACCEPTED" ||
        run.finalSaveStatus !== "PUBLISH_HANDOFF_QUEUED" ||
        !run.blogId ||
        Number(run.estimatedUsd) <= 0
      ) {
        blockers.push("generation_run_or_cost_receipt_incomplete");
      }
      return {
        planId: plan.id,
        blogId: blog.id,
        title: blog.title,
        locale: productionPipeline.locale ?? null,
        wordCount,
        contentQualityScore,
        imageChecks,
        approvedLinks,
        estimatedUsd: run?.estimatedUsd ?? null,
        externalPublishing: blog.publishedBlogs,
        passed: blockers.length === 0,
        blockers: [...new Set(blockers)],
      };
    }),
  );
  const passed = verificationResults.filter((item) => item.passed).length;
  const summary = {
    pipelineVersion: PIPELINE_VERSION,
    maxSpendUsd: MAX_PROVIDER_SPEND_USD,
    canaryCount: cohort.length,
    passed,
    failed: verificationResults.length - passed,
    results,
    report,
    verification: verificationResults,
    productionWritesPerformed: results.filter(
      (result) => result.generatedThisInvocation,
    ).length,
    directWordPressPublishingPerformed: 0,
  };
  console.log(
    JSON.stringify(summary, null, 2),
  );
  await Bun.write(
    "/tmp/staged-v3-production-v1-canary-report.json",
    JSON.stringify(summary, null, 2),
  );
  await prisma.$disconnect();
  if (
    results.some((result) => !result.success) ||
    passed !== EXACT_CANARY_COUNT
  ) {
    process.exitCode = 1;
  }
}

await main();
