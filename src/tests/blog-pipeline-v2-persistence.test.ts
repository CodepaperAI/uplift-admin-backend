import { describe, expect, test } from "bun:test";

import {
  persistProductionBlog,
  ProductionBlogPersistenceError,
  type ProductionBlogPersistenceInput,
} from "../services/blog-pipeline-v2/persistence";

function packageInput(): ProductionBlogPersistenceInput {
  return {
    planId: "plan-1",
    userId: "user-1",
    businessId: "business-1",
    correlationId: "staged-v3-production-v1:plan-1",
    title: "Mulch for Landscaping Beds: A Practical Selection Plan",
    slug: "mulch-for-landscaping-beds",
    excerpt:
      "Compare mulch choices using practical criteria for plant needs, drainage, maintenance, appearance, and long-term garden care.",
    content: [
      '<h1>Mulch for Landscaping Beds: A Practical Selection Plan</h1>',
      '<h2>Selection</h2><p>Useful advice. <a href="https://partner.example/blog/drainage" rel="nofollow noopener noreferrer">Garden drainage</a></p>',
      '<h2>Frequently asked questions</h2>',
      '<h3>Which material fits the planting?</h3><p>Compare the plant needs first. Then review the maintenance plan.</p>',
      '<h3>Can mulch fix drainage?</h3><p>It cannot correct an underlying drainage problem. Review water movement separately.</p>',
      '<h3>How should depth be decided?</h3><p>Use verified guidance for the chosen material. Keep the planting conditions in view.</p>',
      '<h3>When should it be reviewed?</h3><p>Inspect it during seasonal maintenance. Recheck it after significant weather.</p>',
    ].join(""),
    keyword: "mulch for landscaping beds",
    locale: "en-CA",
    featuredMedia: "https://res.cloudinary.com/demo/image/upload/featured.png",
    images: ["featured", "internal-1", "internal-2"].map((role) => ({
      role: role as any,
      url: `https://res.cloudinary.com/demo/image/upload/${role}.png`,
      altText: `${role} image`,
      prompt: `${role} prompt`,
      model: "gpt-image-2",
      quality: "medium",
      size: "1536x1024",
      providerResponseId: `${role}-response`,
    })),
    links: [
      {
        kind: "managed_backlink",
        title: "Garden drainage",
        url: "https://partner.example/blog/drainage",
        businessId: "business-2",
        score: 0.7,
      },
    ],
    sourceUrls: ["https://authority.example/mulch"],
    titleStrategy: { variationFamily: "question" },
    cost: { totalUsd: 0.2 },
    wordCount: 1_500,
    contentQualityScore: 94,
  };
}

function fakePrisma(options: {
  duplicate?: boolean;
  entitlement?: boolean;
  linkCount?: number;
  deleted?: boolean;
  ownershipMismatch?: boolean;
  linkedBlog?: "v2" | "legacy";
  websiteLifecycleStatus?: string;
  websiteSubscriptionStatus?: string;
  websiteTrialStatus?: string;
  websiteTrialEndDate?: Date | null;
} = {}) {
  const captures: Record<string, any> = {};
  const plan = {
    id: "plan-1",
    userId: options.ownershipMismatch ? "another-user" : "user-1",
    businessId: "business-1",
    deletedAt: options.deleted ? new Date() : null,
    blogId: options.linkedBlog ? "blog-linked" : null,
    isUsed: Boolean(options.linkedBlog),
    usedAt: options.linkedBlog ? new Date("2026-08-07T12:00:00Z") : null,
    publishDate: "2026-08-07",
    publishTime: "10:00",
    clusterId: "cluster-1",
    clusterRole: "cluster",
    business: {
      id: "business-1",
      userId: "user-1",
      isActive: true,
      websiteStatus: options.websiteLifecycleStatus ?? "active",
      businessName: "Green Garden",
      businessType: "Landscaping",
      businessWebsiteUrl: "https://example.com",
      authorName: null,
      authorBio: null,
      authorImage: null,
      websiteSubscription: {
        status:
          options.entitlement === false
            ? "expired"
            : options.websiteSubscriptionStatus ?? "active",
        trialStatus: options.websiteTrialStatus ?? "none",
        trialStartDate: new Date("2026-08-01T00:00:00.000Z"),
        trialEndDate: options.websiteTrialEndDate ?? null,
      },
      User: {
        role: "USER",
        trialStatus: "none",
        trialEndDate: null,
        Subscription: null,
      },
    },
  };
  const tx = {
    plan: {
      findUnique: async () => plan,
      updateMany: async ({ data }: any) => {
        captures.planUpdate = data;
        return { count: options.linkCount ?? 1 };
      },
    },
    meta: {
      create: async ({ data }: any) => {
        captures.meta = data;
        return { id: "meta-1", ...data };
      },
    },
    customField: {
      create: async ({ data }: any) => {
        captures.customField = data;
        return { id: "custom-1", ...data };
      },
    },
    blog: {
      findUnique: async () => ({
        id: "blog-linked",
        userId: "user-1",
        businessId: "business-1",
        status: "PUBLISH",
        analytics:
          options.linkedBlog === "v2"
            ? {
                productionPipeline: {
                  version: "staged-v3-production-v1",
                  correlationId: "staged-v3-production-v1:plan-1",
                  planId: "plan-1",
                },
              }
            : {},
      }),
      findFirst: async () => (options.duplicate ? { id: "blog-existing" } : null),
      create: async ({ data }: any) => {
        captures.blog = data;
        return { id: "blog-1", ...data };
      },
    },
  };
  return {
    captures,
    $transaction: async (worker: (value: typeof tx) => Promise<any>) => worker(tx),
  };
}

describe("production blog persistence", () => {
  test("creates metadata, rating 10, a PUBLISH Blog and links the Plan transactionally", async () => {
    const prisma = fakePrisma();
    let synchronized: any = null;
    const result = await persistProductionBlog(
      packageInput(),
      prisma as any,
      async (request: any) => {
        synchronized = request;
        return {} as any;
      },
    );
    expect(result).toEqual({ blogId: "blog-1", alreadyExisted: false });
    expect(prisma.captures.customField.rating).toBe(10);
    expect(prisma.captures.blog.status).toBe("PUBLISH");
    expect(prisma.captures.blog.seoScore).toBe(100);
    expect(prisma.captures.blog.clusterId).toBe("cluster-1");
    expect(prisma.captures.blog.clusterRole).toBe("cluster");
    expect(prisma.captures.blog.analytics.contentQualityScore).toBe(94);
    expect(
      prisma.captures.blog.analytics.productionPipeline.contentQualityScore,
    ).toBe(94);
    expect(
      prisma.captures.blog.analytics.structuredData.map(
        (schema: Record<string, unknown>) => schema["@type"],
      ),
    ).toEqual(["BlogPosting", "BreadcrumbList"]);
    expect(prisma.captures.blog.canonicalUrl).toBe(
      "https://example.com/blog/mulch-for-landscaping-beds",
    );
    expect(prisma.captures.blog.content).toContain(
      'data-uplift-schema="blogposting"',
    );
    expect(prisma.captures.blog.content).not.toContain(
      'data-uplift-schema="faqpage"',
    );
    expect(prisma.captures.planUpdate.isUsed).toBe(true);
    expect(prisma.captures.planUpdate.usedAt).toBeInstanceOf(Date);
    expect(synchronized).toEqual({
      blogId: "blog-1",
      approvedManagedUrls: ["https://partner.example/blog/drainage"],
    });
  });

  test("persists a text-only blog without featured media or image metadata", async () => {
    const input = packageInput();
    input.featuredMedia = "";
    input.images = [];
    const prisma = fakePrisma();

    await expect(
      persistProductionBlog(input, prisma as any, async () => ({} as any)),
    ).resolves.toEqual({ blogId: "blog-1", alreadyExisted: false });

    expect(prisma.captures.blog.featured_media).toBe("");
    expect(prisma.captures.blog.analytics.productionPipeline.images).toEqual(
      [],
    );
    expect(
      prisma.captures.blog.analytics.structuredData[0],
    ).not.toHaveProperty("image");
  });

  test("persists a blog for a current website trial lifecycle", async () => {
    const prisma = fakePrisma({
      websiteLifecycleStatus: "trial",
      websiteSubscriptionStatus: "trialing",
      websiteTrialStatus: "trialing",
      websiteTrialEndDate: new Date("2099-08-20T00:00:00.000Z"),
    });
    await expect(
      persistProductionBlog(
        packageInput(),
        prisma as any,
        async () => ({} as any),
      ),
    ).resolves.toEqual({ blogId: "blog-1", alreadyExisted: false });
  });

  test("persists the model's quality assessment without using it as a content gate", async () => {
    const belowThreshold = packageInput();
    belowThreshold.contentQualityScore = 90;
    const lowScorePrisma = fakePrisma();
    await expect(
      persistProductionBlog(
        belowThreshold,
        lowScorePrisma as any,
        async () => ({} as any),
      ),
    ).resolves.toEqual({ blogId: "blog-1", alreadyExisted: false });
    expect(lowScorePrisma.captures.blog.analytics.contentQualityScore).toBe(90);

    const fractional = packageInput();
    fractional.contentQualityScore = 94.5;
    const fractionalScorePrisma = fakePrisma();
    await expect(
      persistProductionBlog(
        fractional,
        fractionalScorePrisma as any,
        async () => ({} as any),
      ),
    ).resolves.toEqual({ blogId: "blog-1", alreadyExisted: false });
    expect(
      fractionalScorePrisma.captures.blog.analytics.contentQualityScore,
    ).toBe(94.5);
  });

  test("rejects duplicates and inactive entitlements before mutation", async () => {
    await expect(
      persistProductionBlog(packageInput(), fakePrisma({ duplicate: true }) as any),
    ).rejects.toMatchObject({ code: "duplicate_blog" });
    await expect(
      persistProductionBlog(
        packageInput(),
        fakePrisma({ entitlement: false }) as any,
      ),
    ).rejects.toMatchObject({ code: "entitlement_inactive" });
    await expect(
      persistProductionBlog(
        packageInput(),
        fakePrisma({ ownershipMismatch: true }) as any,
      ),
    ).rejects.toMatchObject({ code: "ownership_mismatch" });
    await expect(
      persistProductionBlog(packageInput(), fakePrisma({ deleted: true }) as any),
    ).rejects.toMatchObject({ code: "plan_deleted" });
  });

  test("fails a stale Plan race so the database transaction can roll back", async () => {
    await expect(
      persistProductionBlog(
        packageInput(),
        fakePrisma({ linkCount: 0 }) as any,
        async () => ({} as any),
      ),
    ).rejects.toBeInstanceOf(ProductionBlogPersistenceError);
  });

  test("resumes only an exact v2-linked Blog and rejects a competing pipeline", async () => {
    await expect(
      persistProductionBlog(
        packageInput(),
        fakePrisma({ linkedBlog: "legacy" }) as any,
        async () => ({} as any),
      ),
    ).rejects.toMatchObject({ code: "plan_linked_by_other_pipeline" });

    await expect(
      persistProductionBlog(
        packageInput(),
        fakePrisma({ linkedBlog: "v2" }) as any,
        async () => ({} as any),
      ),
    ).resolves.toEqual({ blogId: "blog-linked", alreadyExisted: true });
  });
});
