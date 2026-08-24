import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import {
  computeRecoveryPackageDigest,
  importRecoveryDraft,
  RECOVERY_DRAFT_PACKAGE,
  type RecoveryApprovedManifest,
  type RecoveryDraftPackage,
  type RecoveryImportOptions,
} from "../services/recovery-blog-importer.service";

const ORIGINAL_ENV = {
  APP_ENV: process.env.APP_ENV,
  DEPLOY_ENV: process.env.DEPLOY_ENV,
  ENVIRONMENT: process.env.ENVIRONMENT,
  NODE_ENV: process.env.NODE_ENV,
  RECOVERY_DRAFT_IMPORT_ENABLED: process.env.RECOVERY_DRAFT_IMPORT_ENABLED,
  RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED:
    process.env.RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED,
};

function restoreEnvironment(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  process.env.APP_ENV = "test";
  process.env.NODE_ENV = "test";
  delete process.env.DEPLOY_ENV;
  delete process.env.ENVIRONMENT;
  process.env.RECOVERY_DRAFT_IMPORT_ENABLED = "true";
  delete process.env.RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED;
});

afterAll(restoreEnvironment);

type MemoryState = {
  plan: Record<string, any>;
  business: Record<string, any>;
  blogs: Array<Record<string, any>>;
  metas: Array<Record<string, any>>;
  customFields: Array<Record<string, any>>;
};

function packageFixture(
  overrides: Partial<RecoveryDraftPackage> = {},
): RecoveryDraftPackage {
  const base: RecoveryDraftPackage = {
    schemaVersion: 1,
    packageId: "pkg-1",
    batchId: "batch-1",
    planId: "plan-1",
    userId: "user-1",
    businessId: "business-1",
    route: {
      action: "create_blog",
      intentFingerprint: "local-cost-guide:service:city",
      rationale: "SERP and site-gap review support a new cost guide.",
    },
    validation: {
      status: "approved",
      validatorVersion: "validator-v1",
      validatedAt: "2026-07-16T20:00:00.000Z",
      blockers: [],
      warnings: [],
    },
    provenance: {
      engineVersion: "v3-test",
      sourceUrls: ["https://example.com/services"],
      researchRetrievedAt: "2026-07-16T19:00:00.000Z",
      researchArtifactId: "research-business-1-v1",
    },
    canonical: {
      url: "https://example.com/blog/service-cost-city",
      verified: true,
    },
    structuredData: {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "Service Cost in City",
    },
    blog: {
      businessId: "business-1",
      title: "Service Cost in City",
      slug: "service-cost-city",
      status: "PUBLISH",
      author: "Business Expert",
      content: "<article><h1>Service Cost in City</h1><p>Useful content.</p></article>",
      excerpt: "A practical local cost guide.",
      categories: ["Cost Guides"],
      tags: ["service cost", "city"],
      featured_media: "https://example.com/images/service.jpg",
      seoScore: 91,
      meta: {
        seo_title: "Service Cost in City",
        seo_description: "Understand the factors that influence service cost in City.",
        focus_keyword: "service cost city",
        keywords: ["service cost city", "local service pricing"],
      },
      custom_fields: {
        reading_time: "8 min read",
        rating: 9,
      },
      blogPublishInfo: {
        date: "2099-01-01",
        time: "23:59",
      },
    },
  };

  return {
    ...base,
    ...overrides,
    route: { ...base.route, ...(overrides.route ?? {}) },
    validation: { ...base.validation, ...(overrides.validation ?? {}) },
    provenance: { ...base.provenance, ...(overrides.provenance ?? {}) },
    blog: {
      ...base.blog,
      ...(overrides.blog ?? {}),
      meta: { ...base.blog.meta, ...(overrides.blog?.meta ?? {}) },
      custom_fields: {
        ...base.blog.custom_fields,
        ...(overrides.blog?.custom_fields ?? {}),
      },
      blogPublishInfo: {
        ...base.blog.blogPublishInfo,
        ...(overrides.blog?.blogPublishInfo ?? {}),
      },
    },
  };
}

function approvedManifest(
  pkg: RecoveryDraftPackage,
  overrides: Partial<RecoveryApprovedManifest> = {},
): RecoveryApprovedManifest {
  const base: RecoveryApprovedManifest = {
    schemaVersion: 1,
    manifestId: "manifest-1",
    batchId: pkg.batchId,
    mode: "canary",
    generatedAt: "2026-07-16T19:30:00.000Z",
    expiresAt: "2099-12-31T23:59:59.000Z",
    approval: {
      status: "approved",
      approvedAt: "2026-07-16T19:45:00.000Z",
      approvedBy: "Independent Recovery Approver",
    },
    entries: [
      {
        packageId: pkg.packageId,
        planId: pkg.planId,
        userId: pkg.userId,
        businessId: pkg.businessId,
        ...(pkg.entitlement ? { entitlement: pkg.entitlement } : {}),
        ...(pkg.billingCohort ? { billingCohort: pkg.billingCohort } : {}),
        ...(pkg.planTier !== undefined ? { planTier: pkg.planTier } : {}),
        route: "CREATE",
        generationAuthorized: true,
        validation: {
          status: "approved",
          blockers: [],
          validatorVersion: pkg.validation.validatorVersion,
        },
        approvedBusinessHost: "example.com",
        approvedCanonicalUrl: pkg.canonical?.url ?? null,
        packageDigest: computeRecoveryPackageDigest(pkg),
      },
    ],
  };
  return {
    ...base,
    ...overrides,
    approval: { ...base.approval, ...(overrides.approval ?? {}) },
    entries: overrides.entries ?? base.entries,
  };
}

function authorizedApplyOptions(
  pkg: RecoveryDraftPackage,
  overrides: Partial<RecoveryImportOptions> = {},
  manifestOverrides: Partial<RecoveryApprovedManifest> = {},
): RecoveryImportOptions {
  const manifest = approvedManifest(pkg, manifestOverrides);
  return {
    apply: true,
    authorization: {
      manifest,
      confirmBatch: pkg.batchId,
      approval:
        manifest.mode === "canary"
          ? "APPROVE_PRODUCTION_CANARY"
          : "APPROVE_PRODUCTION_BATCH_IMPORT",
      invocationPackageCount: 1,
    },
    ...overrides,
  };
}

function initialState(
  options: {
    userId?: string;
    businessUserId?: string;
    businessActive?: boolean;
    websiteStatus?: string;
    subscriptionStatus?: string;
    trialStatus?: string;
    stripeSubscriptionId?: string | null;
    planTier?: "SEO" | "SEO_SOCIAL";
    websiteTrialStartDate?: Date | null;
    websiteTrialEndDate?: Date | null;
    userTrialStatus?: string | null;
    userTrialStartDate?: Date | null;
    userTrialEndDate?: Date | null;
    userRole?: string;
    userSubscriptionStatus?: string | null;
    planKeyword?: string;
    deletedAt?: Date | null;
    isUsed?: boolean;
    usedAt?: Date | null;
    businessWebsiteUrl?: string;
    existingBlogs?: Array<Record<string, any>>;
  } = {},
): MemoryState {
  const metas = (options.existingBlogs ?? []).map((blog, index) => ({
    id: blog.metaId ?? `existing-meta-${index + 1}`,
    focus_keyword: blog.focusKeyword ?? "another keyword",
  }));
  const blogs = (options.existingBlogs ?? []).map((blog, index) => ({
    id: blog.id ?? `existing-blog-${index + 1}`,
    userId: "user-1",
    businessId: "business-1",
    title: blog.title ?? "Another Article",
    slug: blog.slug ?? `another-article-${index + 1}`,
    canonicalUrl: blog.canonicalUrl ?? null,
    analytics: blog.analytics ?? null,
    metaId: metas[index]!.id,
    status: "DRAFT",
  }));

  return {
    plan: {
      id: "plan-1",
      keyword: options.planKeyword ?? "service cost city",
      publishDate: "2026-07-13",
      publishTime: "09:30",
      blogId: null,
      userId: options.userId ?? "user-1",
      businessId: "business-1",
      deletedAt: options.deletedAt ?? null,
      isUsed: options.isUsed ?? false,
      usedAt: options.usedAt ?? null,
    },
    business: {
      id: "business-1",
      userId: options.businessUserId ?? "user-1",
      businessName: "Example Business",
      businessWebsiteUrl: options.businessWebsiteUrl ?? "https://example.com",
      defaultLocale: "en-CA",
      authorName: "Verified Author",
      authorBio: "Verified author biography.",
      authorImage: "https://example.com/author.jpg",
      authorSocialLinks: { website: "https://example.com/about" },
      isActive: options.businessActive ?? true,
      websiteStatus: options.websiteStatus ?? "active",
      websiteSubscription: {
        stripeSubscriptionId: options.stripeSubscriptionId ?? null,
        planTier: options.planTier ?? "SEO",
        status: options.subscriptionStatus ?? "active",
        trialStatus: options.trialStatus ?? "none",
        trialStartDate: options.websiteTrialStartDate ?? null,
        trialEndDate: options.websiteTrialEndDate ?? null,
      },
      User: {
        id: options.businessUserId ?? "user-1",
        role: options.userRole ?? "USER",
        trialStatus: options.userTrialStatus ?? "none",
        trialStartDate: options.userTrialStartDate ?? null,
        trialEndDate: options.userTrialEndDate ?? null,
        Subscription: options.userSubscriptionStatus
          ? { status: options.userSubscriptionStatus }
          : null,
      },
    },
    blogs,
    metas,
    customFields: [],
  };
}

function memoryPrisma(
  startingState = initialState(),
  options: { forceStalePlanRace?: boolean } = {},
) {
  let state = structuredClone(startingState);
  let idCounter = 0;

  function transactionClient(working: MemoryState) {
    return {
      plan: {
        findUnique: async ({ where }: any) => {
          if (where.id !== working.plan.id) return null;
          const linkedBlog = working.blogs.find(
            (blog) => blog.id === working.plan.blogId,
          );
          return {
            ...working.plan,
            business: {
              ...working.business,
              websiteSubscription: working.business.websiteSubscription,
              User: working.business.User,
            },
            blog: linkedBlog ? { ...linkedBlog } : null,
          };
        },
        updateMany: async ({ where, data }: any) => {
          if (options.forceStalePlanRace) return { count: 0 };
          const matches =
            where.id === working.plan.id &&
            where.userId === working.plan.userId &&
            where.businessId === working.plan.businessId &&
            working.plan.deletedAt === null &&
            working.plan.blogId === null &&
            working.plan.isUsed === false &&
            working.plan.usedAt === null;
          if (!matches) return { count: 0 };
          Object.assign(working.plan, data);
          return { count: 1 };
        },
      },
      blog: {
        findMany: async ({ where }: any) =>
          working.blogs
            .filter(
              (blog) =>
                blog.userId === where.userId &&
                blog.businessId === where.businessId,
            )
            .map((blog) => ({
              id: blog.id,
              title: blog.title,
              slug: blog.slug,
              canonicalUrl: blog.canonicalUrl,
              analytics: blog.analytics,
              meta: {
                focus_keyword:
                  working.metas.find((meta) => meta.id === blog.metaId)
                    ?.focus_keyword ?? "",
              },
            })),
        create: async ({ data }: any) => {
          const blog = { id: `blog-${++idCounter}`, ...data };
          working.blogs.push(blog);
          return blog;
        },
      },
      meta: {
        create: async ({ data }: any) => {
          const meta = { id: `meta-${++idCounter}`, ...data };
          working.metas.push(meta);
          return meta;
        },
      },
      customField: {
        create: async ({ data }: any) => {
          const customField = { id: `custom-${++idCounter}`, ...data };
          working.customFields.push(customField);
          return customField;
        },
      },
    };
  }

  const prisma = {
    $transaction: async (callback: (tx: any) => Promise<any>) => {
      const working = structuredClone(state);
      const result = await callback(transactionClient(working));
      state = working;
      return result;
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    getState: () => structuredClone(state),
    mutateState: (mutate: (current: MemoryState) => void) => {
      mutate(state);
    },
  };
}

describe("recovery draft importer", () => {
  it("defaults to a read-only dry run", async () => {
    const db = memoryPrisma();
    const result = await importRecoveryDraft(db.prisma, packageFixture());

    expect(result.status).toBe("ready");
    expect(result.mode).toBe("dry-run");
    expect(result.proposedMutation.createBlog).toBe(true);
    expect(result.mutationReceipt?.plan.before.blogId).toBeNull();
    expect(result.mutationReceipt?.plan.after.isUsed).toBe(true);
    expect(result.mutationReceipt?.blog?.status).toBe("DRAFT");
    expect(db.getState().blogs).toHaveLength(0);
    expect(db.getState().plan.blogId).toBeNull();
  });

  it("atomically imports a forced draft and uses the Plan schedule", async () => {
    const db = memoryPrisma();
    const now = new Date("2026-07-16T21:00:00.000Z");
    const pkg = packageFixture();
    const result = await importRecoveryDraft(
      db.prisma,
      pkg,
      authorizedApplyOptions(pkg, { now }),
    );
    const state = db.getState();

    expect(result.status).toBe("imported");
    expect(state.blogs).toHaveLength(1);
    expect(state.blogs[0]?.status).toBe("DRAFT");
    expect(state.blogs[0]?.blogPublishDate).toBe("2026-07-13");
    expect(state.blogs[0]?.blogPublishTime).toBe("09:30");
    expect(state.plan.blogId).toBe(result.blogId);
    expect(state.plan.isUsed).toBe(true);
    expect(new Date(state.plan.usedAt).toISOString()).toBe(now.toISOString());
    expect(state.blogs[0]?.analytics.recovery.planId).toBe("plan-1");
    expect(state.blogs[0]?.analytics.recovery.manifestId).toBe("manifest-1");
    expect(state.blogs[0]?.analytics.recovery.packageDigest).toBe(
      computeRecoveryPackageDigest(pkg),
    );
    expect(state.blogs[0]?.seoScore).toBe(91);
    expect(state.blogs[0]?.analytics.rankingPotential).toBe("HIGH");
    expect(state.blogs[0]?.analytics.conversionPotential).toBe("LOW");
    expect(state.blogs[0]?.analytics.externalLinksCount).toBe(0);
    expect(result.authorizationReceipt).toEqual({
      manifestId: "manifest-1",
      batchId: "batch-1",
      mode: "canary",
      packageDigest: computeRecoveryPackageDigest(pkg),
    });
    expect(result.mutationReceipt?.plan.after.blogId).toBe(result.blogId);
    expect(result.mutationReceipt?.plan.after.usedAt).toBe(now.toISOString());
    expect(result.mutationReceipt?.blog?.publishDate).toBe("2026-07-13");
  });

  it("is idempotent when the same Plan is imported again", async () => {
    const db = memoryPrisma();
    const pkg = packageFixture();
    const options = authorizedApplyOptions(pkg);
    const first = await importRecoveryDraft(db.prisma, pkg, options);
    const second = await importRecoveryDraft(db.prisma, pkg, options);

    expect(first.status).toBe("imported");
    expect(second.status).toBe("already_imported");
    expect(second.blogId).toBe(first.blogId);
    expect(second.mutationReceipt?.plan.before.blogId).toBe(first.blogId);
    expect(second.mutationReceipt?.plan.after.blogId).toBe(first.blogId);
    expect(db.getState().blogs).toHaveLength(1);
  });

  it("reports persisted values on an idempotent rerun", async () => {
    const db = memoryPrisma();
    const pkg = packageFixture();
    const options = authorizedApplyOptions(pkg);
    const first = await importRecoveryDraft(db.prisma, pkg, options);
    expect(first.status).toBe("imported");

    db.mutateState((state) => {
      const blog = state.blogs[0]!;
      blog.status = "PUBLISH";
      blog.blogPublishDate = "2026-08-01";
      blog.blogPublishTime = "12:45";
      blog.canonicalUrl = "https://example.com/blog/persisted-canonical";
    });
    const rerun = await importRecoveryDraft(db.prisma, pkg, options);

    expect(rerun.status).toBe("already_imported");
    expect(rerun.mutationReceipt?.blog).toEqual({
      id: first.blogId,
      status: "PUBLISH",
      publishDate: "2026-08-01",
      publishTime: "12:45",
      canonicalUrl: "https://example.com/blog/persisted-canonical",
    });
  });

  it("rolls back Meta, CustomField, Blog, and Plan after a forced failure", async () => {
    const db = memoryPrisma();
    const pkg = packageFixture();
    const result = await importRecoveryDraft(
      db.prisma,
      pkg,
      authorizedApplyOptions(pkg, { simulateFailureAt: "after_blog_create" }),
    );
    const state = db.getState();

    expect(result.status).toBe("blocked");
    expect(result.blockCodes).toContain("simulated_failure");
    expect(result.mutationReceipt).toBeNull();
    expect(state.blogs).toHaveLength(0);
    expect(state.metas).toHaveLength(0);
    expect(state.customFields).toHaveLength(0);
    expect(state.plan.blogId).toBeNull();
  });

  it("rolls back when the Plan changes before linkage", async () => {
    const db = memoryPrisma(initialState(), { forceStalePlanRace: true });
    const pkg = packageFixture();
    const result = await importRecoveryDraft(
      db.prisma,
      pkg,
      authorizedApplyOptions(pkg),
    );

    expect(result.status).toBe("blocked");
    expect(result.blockCodes).toContain("stale_plan_race");
    expect(db.getState().blogs).toHaveLength(0);
    expect(db.getState().plan.blogId).toBeNull();
  });

  it("blocks incorrect ownership and inactive paid access", async () => {
    const ownershipDb = memoryPrisma(initialState({ userId: "other-user" }));
    const ownership = await importRecoveryDraft(
      ownershipDb.prisma,
      packageFixture(),
    );
    expect(ownership.blockCodes).toContain("ownership_mismatch");

    const inactiveDb = memoryPrisma(
      initialState({ subscriptionStatus: "canceled" }),
    );
    const inactive = await importRecoveryDraft(
      inactiveDb.prisma,
      packageFixture(),
    );
    expect(inactive.blockCodes).toContain("paid_subscription_inactive");
  });

  it("blocks trial subscriptions from the paid-business recovery queue", async () => {
    const db = memoryPrisma(initialState({ trialStatus: "trialing" }));
    const result = await importRecoveryDraft(db.prisma, packageFixture());

    expect(result.status).toBe("blocked");
    expect(result.blockCodes).toContain("paid_subscription_inactive");
  });

  it("allows the same active user subscription fallback as the scheduler", async () => {
    const db = memoryPrisma(
      initialState({
        subscriptionStatus: "canceled",
        userSubscriptionStatus: "active",
      }),
    );
    const result = await importRecoveryDraft(
      db.prisma,
      packageFixture({
        entitlement: "paid",
        billingCohort: "legacy_user_paid",
        planTier: null,
      }),
    );

    expect(result.status).toBe("ready");
  });

  it("allows the same staff bypass as the scheduler", async () => {
    const db = memoryPrisma(
      initialState({
        subscriptionStatus: "canceled",
        userRole: "SUPERADMIN",
      }),
    );
    const result = await importRecoveryDraft(db.prisma, packageFixture());

    expect(result.status).toBe("ready");
  });

  it("allows an explicitly bound active user trial from the fresh User relation", async () => {
    const now = new Date("2026-07-16T21:00:00.000Z");
    const pkg = packageFixture({ entitlement: "trial" });
    const db = memoryPrisma(
      initialState({
        subscriptionStatus: "canceled",
        userTrialStatus: "active",
        userTrialStartDate: new Date("2026-07-10T00:00:00.000Z"),
        userTrialEndDate: new Date("2026-07-18T00:00:00.000Z"),
      }),
    );

    const result = await importRecoveryDraft(
      db.prisma,
      pkg,
      authorizedApplyOptions(pkg, { now }),
    );

    expect(result.status).toBe("imported");
    expect(db.getState().blogs[0]?.analytics.recovery.entitlement).toBe(
      "trial",
    );
  });

  it("allows an explicitly bound active website trial", async () => {
    const now = new Date("2026-07-16T21:00:00.000Z");
    const pkg = packageFixture({ entitlement: "trial" });
    const db = memoryPrisma(
      initialState({
        subscriptionStatus: "trialing",
        trialStatus: "trialing",
        websiteTrialStartDate: new Date("2026-07-10T00:00:00.000Z"),
        websiteTrialEndDate: new Date("2026-07-18T00:00:00.000Z"),
      }),
    );

    const result = await importRecoveryDraft(
      db.prisma,
      pkg,
      authorizedApplyOptions(pkg, { now }),
    );

    expect(result.status).toBe("imported");
  });

  it("allows a Stripe-backed paid intro on either website plan tier", async () => {
    const now = new Date("2026-07-16T21:00:00.000Z");
    for (const planTier of ["SEO", "SEO_SOCIAL"] as const) {
      const pkg = packageFixture({
        entitlement: "trial",
        billingCohort: "website_paid_intro",
        planTier,
      });
      const db = memoryPrisma(
        initialState({
          websiteStatus: "trial",
          subscriptionStatus: "trialing",
          trialStatus: "trialing",
          stripeSubscriptionId: `sub_paid_intro_${planTier}`,
          planTier,
          websiteTrialStartDate: new Date("2026-07-10T00:00:00.000Z"),
          websiteTrialEndDate: new Date("2026-07-18T00:00:00.000Z"),
        }),
      );

      const result = await importRecoveryDraft(
        db.prisma,
        pkg,
        authorizedApplyOptions(pkg, { now }),
      );

      expect(result.status).toBe("imported");
    }
  });

  it("blocks an unbacked trial from the paid-intro recovery cohort", async () => {
    const now = new Date("2026-07-16T21:00:00.000Z");
    const pkg = packageFixture({
      entitlement: "trial",
      billingCohort: "website_paid_intro",
      planTier: "SEO",
    });
    const db = memoryPrisma(
      initialState({
        websiteStatus: "trial",
        subscriptionStatus: "trialing",
        trialStatus: "trialing",
        websiteTrialStartDate: new Date("2026-07-10T00:00:00.000Z"),
        websiteTrialEndDate: new Date("2026-07-18T00:00:00.000Z"),
      }),
    );

    const result = await importRecoveryDraft(
      db.prisma,
      pkg,
      authorizedApplyOptions(pkg, { now }),
    );

    expect(result.status).toBe("blocked");
    expect(result.blockCodes).toContain("trial_entitlement_inactive");
  });

  it("blocks a frozen website plan tier that drifted before import", async () => {
    const pkg = packageFixture({
      entitlement: "paid",
      billingCohort: "website_paid",
      planTier: "SEO_SOCIAL",
    });
    const db = memoryPrisma(initialState({ planTier: "SEO" }));

    const result = await importRecoveryDraft(db.prisma, pkg);

    expect(result.status).toBe("blocked");
    expect(result.blockCodes).toContain("plan_tier_drift");
  });

  it("blocks an explicitly bound expired trial", async () => {
    const now = new Date("2026-07-16T21:00:00.000Z");
    const pkg = packageFixture({ entitlement: "trial" });
    const db = memoryPrisma(
      initialState({
        subscriptionStatus: "trialing",
        trialStatus: "trialing",
        websiteTrialStartDate: new Date("2026-07-01T00:00:00.000Z"),
        websiteTrialEndDate: new Date("2026-07-16T20:59:59.000Z"),
        userTrialStatus: "active",
        userTrialStartDate: new Date("2026-07-01T00:00:00.000Z"),
        userTrialEndDate: new Date("2026-07-16T20:59:59.000Z"),
      }),
    );

    const result = await importRecoveryDraft(
      db.prisma,
      pkg,
      authorizedApplyOptions(pkg, { now }),
    );

    expect(result.status).toBe("blocked");
    expect(result.blockCodes).toContain("trial_entitlement_inactive");
    expect(db.getState().blogs).toHaveLength(0);
  });

  it("blocks stale active subscriptions with expired trial state", async () => {
    const db = memoryPrisma(
      initialState({ subscriptionStatus: "active", trialStatus: "expired" }),
    );
    const result = await importRecoveryDraft(db.prisma, packageFixture());

    expect(result.status).toBe("blocked");
    expect(result.blockCodes).toContain("paid_subscription_inactive");
  });

  it("allows active paid subscriptions converted from trial", async () => {
    const db = memoryPrisma(
      initialState({ subscriptionStatus: "active", trialStatus: "converted" }),
    );
    const result = await importRecoveryDraft(db.prisma, packageFixture());

    expect(result.status).toBe("ready");
  });

  it("preserves legacy paid behavior when entitlement is omitted", async () => {
    const legacyPackage = packageFixture();
    const explicitUndefined = {
      ...legacyPackage,
      entitlement: undefined,
    };
    const parsed = RECOVERY_DRAFT_PACKAGE.parse(legacyPackage);

    expect("entitlement" in parsed).toBe(false);
    expect(computeRecoveryPackageDigest(explicitUndefined)).toBe(
      computeRecoveryPackageDigest(legacyPackage),
    );
    expect(
      (
        await importRecoveryDraft(
          memoryPrisma().prisma,
          legacyPackage,
        )
      ).status,
    ).toBe("ready");
  });

  it("blocks used or timestamped Plans whose blog link is missing", async () => {
    const used = memoryPrisma(initialState({ isUsed: true }));
    const usedResult = await importRecoveryDraft(used.prisma, packageFixture());
    expect(usedResult.blockCodes).toContain("plan_state_inconsistent");

    const timestamped = memoryPrisma(
      initialState({ usedAt: new Date("2026-07-15T12:00:00.000Z") }),
    );
    const timestampedResult = await importRecoveryDraft(
      timestamped.prisma,
      packageFixture(),
    );
    expect(timestampedResult.blockCodes).toContain("plan_state_inconsistent");
    expect(timestamped.getState().blogs).toHaveLength(0);
  });

  it("blocks linked Plans whose used state is incomplete", async () => {
    const pkg = packageFixture();

    for (const mutate of [
      (state: MemoryState) => {
        state.plan.isUsed = false;
      },
      (state: MemoryState) => {
        state.plan.usedAt = null;
      },
    ]) {
      const db = memoryPrisma();
      const options = authorizedApplyOptions(pkg);
      expect((await importRecoveryDraft(db.prisma, pkg, options)).status).toBe(
        "imported",
      );
      db.mutateState(mutate);

      const result = await importRecoveryDraft(db.prisma, pkg, options);
      expect(result.status).toBe("blocked");
      expect(result.blockCodes).toContain("plan_state_inconsistent");
      expect(db.getState().blogs).toHaveLength(1);
    }
  });

  it("blocks duplicate slug, focus keyword, canonical, and intent", async () => {
    const duplicate = {
      title: "Different Existing Title",
      slug: "service-cost-city",
      focusKeyword: "service cost city",
      canonicalUrl: "https://example.com/blog/service-cost-city/",
      analytics: {
        recovery: { intentFingerprint: "local-cost-guide:service:city" },
      },
    };
    const db = memoryPrisma(initialState({ existingBlogs: [duplicate] }));
    const result = await importRecoveryDraft(db.prisma, packageFixture());

    expect(result.status).toBe("blocked");
    expect(result.blockCodes).toContain("duplicate_slug");
    expect(result.blockCodes).toContain("duplicate_focus_keyword");
    expect(result.blockCodes).toContain("duplicate_canonical");
    expect(result.blockCodes).toContain("duplicate_intent");
  });

  it("blocks a duplicate title alone", async () => {
    const db = memoryPrisma(
      initialState({
        existingBlogs: [
          {
            title: "  SERVICE   COST IN CITY ",
            slug: "different-slug",
            focusKeyword: "different keyword",
            canonicalUrl: "https://example.com/blog/different-slug",
          },
        ],
      }),
    );
    const result = await importRecoveryDraft(db.prisma, packageFixture());

    expect(result.blockCodes).toEqual(["duplicate_title"]);
  });

  it("allows an exact focus-keyword overlap for a distinct fresh-create Plan obligation", async () => {
    const db = memoryPrisma(
      initialState({
        existingBlogs: [
          {
            title: "An Existing Article With a Different Angle",
            slug: "existing-different-angle",
            focusKeyword: "service cost city",
            canonicalUrl: "https://example.com/blog/existing-different-angle",
          },
        ],
      }),
    );
    const result = await importRecoveryDraft(
      db.prisma,
      packageFixture({
        provenance: {
          engineVersion: "fresh-create-recovery-v1",
          sourceUrls: ["https://example.com/services"],
          researchRetrievedAt: "2026-07-16T19:00:00.000Z",
          researchArtifactId: "research-business-1-v1",
        },
        route: {
          action: "create_blog",
          intentFingerprint: "fresh-create:unique-plan-bound-fingerprint",
          rationale: "A distinct frozen Plan requires its own recovery article.",
        },
      }),
    );

    expect(result.status).toBe("ready");
    expect(result.blockCodes).toEqual([]);
  });

  it("requires independently bound authorization for direct apply", async () => {
    const db = memoryPrisma();
    const pkg = packageFixture();

    await expect(
      importRecoveryDraft(db.prisma, pkg, { apply: true }),
    ).rejects.toThrow("approved recovery manifest authorization is required");
    expect(db.getState().blogs).toHaveLength(0);
  });

  it("requires exact direct-service batch, approval, and current manifest", async () => {
    const pkg = packageFixture();
    const db = memoryPrisma();

    const wrongBatch = authorizedApplyOptions(pkg);
    wrongBatch.authorization!.confirmBatch = "different-batch";
    await expect(importRecoveryDraft(db.prisma, pkg, wrongBatch)).rejects.toThrow(
      "confirmed batch does not match",
    );

    const wrongApproval = authorizedApplyOptions(pkg);
    wrongApproval.authorization!.approval = "APPROVE";
    await expect(
      importRecoveryDraft(db.prisma, pkg, wrongApproval),
    ).rejects.toThrow("approval phrase does not match");

    const expired = authorizedApplyOptions(pkg, {}, {
      expiresAt: "2026-07-16T20:00:00.000Z",
    });
    await expect(importRecoveryDraft(db.prisma, pkg, expired)).rejects.toThrow(
      "manifest is not currently valid",
    );
    expect(db.getState().blogs).toHaveLength(0);
  });

  it("blocks package and manifest entitlement mismatches", async () => {
    const pkg = packageFixture({ entitlement: "trial" });
    const manifest = approvedManifest(pkg);
    manifest.entries[0]!.entitlement = "paid";

    await expect(
      importRecoveryDraft(
        memoryPrisma(
          initialState({
            userTrialStatus: "active",
            userTrialStartDate: new Date("2026-07-10T00:00:00.000Z"),
            userTrialEndDate: new Date("2026-07-18T00:00:00.000Z"),
          }),
        ).prisma,
        pkg,
        {
          apply: true,
          now: new Date("2026-07-16T21:00:00.000Z"),
          authorization: {
            manifest,
            confirmBatch: pkg.batchId,
            approval: "APPROVE_PRODUCTION_CANARY",
            invocationPackageCount: 1,
          },
        },
      ),
    ).rejects.toThrow("package identity or route does not match");
  });

  it("binds billing cohort and plan tier into the approved manifest", async () => {
    const pkg = packageFixture({
      entitlement: "paid",
      billingCohort: "website_paid",
      planTier: "SEO",
    });
    const manifest = approvedManifest(pkg);
    manifest.entries[0]!.planTier = "SEO_SOCIAL";

    await expect(
      importRecoveryDraft(memoryPrisma().prisma, pkg, {
        apply: true,
        authorization: {
          manifest,
          confirmBatch: pkg.batchId,
          approval: "APPROVE_PRODUCTION_CANARY",
          invocationPackageCount: 1,
        },
      }),
    ).rejects.toThrow("package identity or route does not match");
  });

  it("rejects package digest and manifest identity tampering", async () => {
    const db = memoryPrisma();
    const approved = packageFixture();
    const options = authorizedApplyOptions(approved);
    const tampered = packageFixture({
      blog: { ...approved.blog, title: "Tampered" },
    });

    await expect(importRecoveryDraft(db.prisma, tampered, options)).rejects.toThrow(
      "package digest does not match",
    );

    const wrongIdentity = approvedManifest(approved);
    wrongIdentity.entries[0]!.planId = "different-plan";
    await expect(
      importRecoveryDraft(db.prisma, approved, {
        apply: true,
        authorization: {
          manifest: wrongIdentity,
          confirmBatch: approved.batchId,
          approval: "APPROVE_PRODUCTION_CANARY",
          invocationPackageCount: 1,
        },
      }),
    ).rejects.toThrow("identity or route does not match");
  });

  it("rejects non-CREATE or generation-disabled manifest entries", async () => {
    const db = memoryPrisma();
    const pkg = packageFixture();
    const manifest = approvedManifest(pkg) as any;
    manifest.entries[0].route = "UPDATE";
    manifest.entries[0].generationAuthorized = false;

    await expect(
      importRecoveryDraft(db.prisma, pkg, {
        apply: true,
        authorization: {
          manifest,
          confirmBatch: pkg.batchId,
          approval: "APPROVE_PRODUCTION_CANARY",
          invocationPackageCount: 1,
        },
      }),
    ).rejects.toThrow("approved manifest is invalid");
  });

  it("rejects canonical and database business-host mismatches", async () => {
    const pkg = packageFixture();
    const canonicalManifest = approvedManifest(pkg);
    canonicalManifest.entries[0]!.approvedBusinessHost = "other.example";
    canonicalManifest.entries[0]!.approvedCanonicalUrl =
      "https://other.example/blog/service-cost-city";

    await expect(
      importRecoveryDraft(memoryPrisma().prisma, pkg, {
        apply: true,
        authorization: {
          manifest: canonicalManifest,
          confirmBatch: pkg.batchId,
          approval: "APPROVE_PRODUCTION_CANARY",
          invocationPackageCount: 1,
        },
      }),
    ).rejects.toThrow("canonical does not match");

    const hostDb = memoryPrisma(
      initialState({ businessWebsiteUrl: "https://changed.example" }),
    );
    const result = await importRecoveryDraft(
      hostDb.prisma,
      pkg,
      authorizedApplyOptions(pkg),
    );
    expect(result.blockCodes).toContain("business_host_mismatch");
    expect(hostDb.getState().blogs).toHaveLength(0);
  });

  it("fails closed for production, conflicting environments, and canary cardinality", async () => {
    const pkg = packageFixture();
    const db = memoryPrisma();

    process.env.APP_ENV = "production";
    process.env.NODE_ENV = "production";
    await expect(
      importRecoveryDraft(db.prisma, pkg, authorizedApplyOptions(pkg)),
    ).rejects.toThrow("RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED");

    process.env.RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED = "true";
    process.env.APP_ENV = "staging";
    process.env.NODE_ENV = "production";
    await expect(
      importRecoveryDraft(db.prisma, pkg, authorizedApplyOptions(pkg)),
    ).rejects.toThrow("runtime environment markers are contradictory");

    process.env.APP_ENV = "test";
    process.env.NODE_ENV = "test";
    const manifest = approvedManifest(pkg);
    manifest.entries.push({
      ...manifest.entries[0]!,
      packageId: "another-package",
      planId: "another-plan",
      packageDigest: "a".repeat(64),
    });
    await expect(
      importRecoveryDraft(db.prisma, pkg, {
        apply: true,
        authorization: {
          manifest,
          confirmBatch: pkg.batchId,
          approval: "APPROVE_PRODUCTION_CANARY",
          invocationPackageCount: 1,
        },
      }),
    ).rejects.toThrow("canary manifest must authorize exactly one package");
  });

  it("allows production apply only when every independent guard is present", async () => {
    process.env.APP_ENV = "production";
    process.env.NODE_ENV = "production";
    process.env.RECOVERY_PRODUCTION_DRAFT_IMPORT_ENABLED = "true";
    const db = memoryPrisma();
    const pkg = packageFixture();

    const result = await importRecoveryDraft(
      db.prisma,
      pkg,
      authorizedApplyOptions(pkg),
    );

    expect(result.status).toBe("imported");
    expect(result.authorizationReceipt?.manifestId).toBe("manifest-1");
    expect(db.getState().blogs).toHaveLength(1);
  });

  it("uses the batch-specific phrase while retaining one-package apply semantics", async () => {
    const db = memoryPrisma();
    const pkg = packageFixture();
    const result = await importRecoveryDraft(
      db.prisma,
      pkg,
      authorizedApplyOptions(pkg, {}, { mode: "batch" }),
    );

    expect(result.status).toBe("imported");
    expect(result.authorizationReceipt?.mode).toBe("batch");
    expect(db.getState().blogs).toHaveLength(1);
  });

  it("requires one package per apply invocation", async () => {
    const pkg = packageFixture();
    const options = authorizedApplyOptions(pkg);
    options.authorization!.invocationPackageCount = 2;

    await expect(
      importRecoveryDraft(memoryPrisma().prisma, pkg, options),
    ).rejects.toThrow("exactly one package is allowed");
  });

  it("strictly rejects unknown, unbounded, and malformed package fields", async () => {
    const db = memoryPrisma();
    const unknown = { ...packageFixture(), unexpected: true };
    await expect(importRecoveryDraft(db.prisma, unknown)).rejects.toThrow();

    const analytics = packageFixture() as any;
    analytics.blog.analytics = { arbitrary: "value" };
    await expect(importRecoveryDraft(db.prisma, analytics)).rejects.toThrow();

    const malformedSlug = packageFixture({
      blog: { ...packageFixture().blog, slug: "Not / A / Slug" },
    });
    await expect(importRecoveryDraft(db.prisma, malformedSlug)).rejects.toThrow();

    const oversized = packageFixture({
      blog: { ...packageFixture().blog, title: "x".repeat(201) },
    });
    await expect(importRecoveryDraft(db.prisma, oversized)).rejects.toThrow();
    expect(db.getState().blogs).toHaveLength(0);
  });

  it("accepts complete strict Article structured data used by recovery packages", () => {
    const pkg = packageFixture({
      structuredData: {
        "@context": "https://schema.org",
        "@type": "Article",
        "@id": "https://example.com/blog/service-cost-city#article",
        url: "https://example.com/blog/service-cost-city",
        headline: "Service Cost in City",
        description: "A practical local guide to service cost decisions.",
        mainEntityOfPage: {
          "@type": "WebPage",
          "@id": "https://example.com/blog/service-cost-city",
        },
        author: {
          "@type": "Organization",
          name: "Example Business",
          url: "https://example.com",
        },
        image: {
          "@type": "ImageObject",
          url: "https://example.com/images/service-cost-city.jpg",
          caption: "Service planning notes and a project estimate.",
          width: 1600,
          height: 900,
        },
        publisher: {
          "@type": "Organization",
          name: "Example Business",
          url: "https://example.com",
          logo: "https://example.com/images/logo.png",
        },
        datePublished: "2026-07-16",
        dateModified: "2026-07-17T12:00:00.000Z",
        inLanguage: "en-CA",
        wordCount: 1750,
        about: [
          "Local service pricing",
          "Quote scope",
          "Project planning",
        ],
      },
    });

    const parsed = RECOVERY_DRAFT_PACKAGE.parse(pkg);

    expect(parsed.structuredData?.author?.["@type"]).toBe("Organization");
    expect(parsed.structuredData?.publisher?.["@type"]).toBe("Organization");
    expect(parsed.structuredData?.wordCount).toBe(1750);
    expect(parsed.structuredData?.about).toEqual([
      "Local service pricing",
      "Quote scope",
      "Project planning",
    ]);
  });

  it("accepts the bounded batch title-allocation provenance", () => {
    const pkg = packageFixture({
      provenance: {
        ...packageFixture().provenance,
        titleStrategy: {
          playbookVersion: "uplift-blog-topic-playbook-v1",
          archetype: "comparison",
          label: "Option comparison",
          rationale: "The query compares two options.",
          variationFamily: "question",
          allocation: {
            schemaVersion: "recovery-title-strategy-assignments-v1",
            inventoryDigestSha256: "a".repeat(64),
            selectionOrder: 1,
            candidateFamilies: ["comparison", "question", "plain"],
            recentFamilies: ["plain", "colon"],
            recentTitles: [
              "How to compare earlier options",
              "Questions to ask before choosing",
            ],
            strategy: {
              archetype: "comparison",
              label: "Option comparison",
              rationale: "The query compares two options.",
              preferredTitleShapes: ["[Option A] vs [Option B]"],
              allowedSpecificityHooks: ["decision criterion"],
              variationFamily: "question",
              sourceIntent: "commercial-investigation",
              requiresSerpValidation: true,
              topicDirective: "Use a criteria-led comparison.",
              substantiveItemCount: null,
            },
          },
        },
      },
    });

    const parsed = RECOVERY_DRAFT_PACKAGE.parse(pkg);

    expect(parsed.provenance.titleStrategy?.allocation?.selectionOrder).toBe(1);
    expect(
      parsed.provenance.titleStrategy?.allocation?.strategy.variationFamily,
    ).toBe("question");
  });

  it("blocks a package whose focus keyword does not match its Plan", async () => {
    const db = memoryPrisma(initialState({ planKeyword: "different keyword" }));
    const result = await importRecoveryDraft(db.prisma, packageFixture());

    expect(result.status).toBe("blocked");
    expect(result.blockCodes).toContain("plan_keyword_mismatch");
  });

  it("rejects malformed or unapproved packages before opening a transaction", async () => {
    const db = memoryPrisma();
    const invalid = packageFixture({
      validation: {
        ...packageFixture().validation,
        status: "approved",
        blockers: ["unsupported licence"],
      },
    });

    await expect(importRecoveryDraft(db.prisma, invalid)).rejects.toThrow();
    expect(db.getState().blogs).toHaveLength(0);
  });
});
