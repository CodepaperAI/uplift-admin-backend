import { prisma } from "../config/db.config";

export const SECURITY_TENANT_A = {
  userId: "11111111-1111-4111-8111-111111111111",
  businessId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  canceledBusinessId: "aac00000-0000-4000-8000-000000000000",
  switchBusinessOneId: "aae00000-0000-4000-8000-000000000001",
  switchBusinessTwoId: "aae00000-0000-4000-8000-000000000002",
  competitorId: "a1000000-0000-4000-8000-000000000001",
  keywordId: "a2000000-0000-4000-8000-000000000002",
  rankingId: "a3000000-0000-4000-8000-000000000003",
  blogId: "a4000000-0000-4000-8000-000000000004",
  planId: "a5000000-0000-4000-8000-000000000005",
  metaId: "a6000000-0000-4000-8000-000000000006",
  customFieldId: "a7000000-0000-4000-8000-000000000007",
  gmbId: "a8000000-0000-4000-8000-000000000008",
} as const;

export const SECURITY_TENANT_B = {
  userId: "22222222-2222-4222-8222-222222222222",
  businessId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  competitorId: "b1000000-0000-4000-8000-000000000001",
  keywordId: "b2000000-0000-4000-8000-000000000002",
  rankingId: "b3000000-0000-4000-8000-000000000003",
  blogId: "b4000000-0000-4000-8000-000000000004",
  planId: "b5000000-0000-4000-8000-000000000005",
  metaId: "b6000000-0000-4000-8000-000000000006",
  customFieldId: "b7000000-0000-4000-8000-000000000007",
  gmbId: "b8000000-0000-4000-8000-000000000008",
} as const;

function assertLocalDatabase() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error(`Refusing security seed against non-local database host: ${url.hostname}`);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing security seed with NODE_ENV=production");
  }
}

async function createTenant(
  tenant: typeof SECURITY_TENANT_A | typeof SECURITY_TENANT_B,
  label: "A" | "B",
) {
  await prisma.user.create({
    data: {
      id: tenant.userId,
      email: `security-tenant-${label.toLowerCase()}@local.invalid`,
      name: `Security Tenant ${label}`,
      emailVerified: true,
      onboarding: true,
    },
  });
  await prisma.business.create({
    data: {
      id: tenant.businessId,
      userId: tenant.userId,
      businessName: `Security Business ${label}`,
      businessType: "Security Test",
      businessDescription: `Disposable local tenant ${label}`,
      businessWebsiteUrl: `https://security-${label.toLowerCase()}.local.test`,
      serviceAreaLocations: [],
      preferredContentTypes: [],
      supportedLanguages: ["en"],
      exampleBlogUrls: [],
      authorExpertise: [],
      isPrimary: true,
      isActive: true,
    },
  });
  if (label === "A") {
    // Owned account history must remain queryable for billing/recovery, but it
    // must never be accepted as a selectable product workspace.
    await prisma.business.create({
      data: {
        id: SECURITY_TENANT_A.canceledBusinessId,
        userId: tenant.userId,
        businessName: "Security Canceled Website A",
        businessType: "Security Test",
        businessDescription: "Disposable canceled workspace fixture",
        businessWebsiteUrl: "https://canceled-security-a.local.test",
        serviceAreaLocations: [],
        preferredContentTypes: [],
        supportedLanguages: ["en"],
        exampleBlogUrls: [],
        authorExpertise: [],
        isPrimary: false,
        isActive: false,
        websiteStatus: "canceled",
        onboardingStatus: "completed",
        websiteSubscription: {
          create: {
            status: "canceled",
            planTier: "SEO",
          },
        },
      },
    });
    for (const [index, id] of [
      SECURITY_TENANT_A.switchBusinessOneId,
      SECURITY_TENANT_A.switchBusinessTwoId,
    ].entries()) {
      await prisma.business.create({
        data: {
          id,
          userId: tenant.userId,
          businessName: `Security Switch Candidate ${index + 1}`,
          businessType: "Security Test",
          businessDescription: "Disposable concurrent-switch fixture",
          businessWebsiteUrl: `https://switch-${index + 1}-security-a.local.test`,
          serviceAreaLocations: [],
          preferredContentTypes: [],
          supportedLanguages: ["en"],
          exampleBlogUrls: [],
          authorExpertise: [],
          isPrimary: false,
          isActive: true,
          websiteStatus: "active",
          onboardingStatus: "completed",
        },
      });
    }
  }
  await prisma.googleMyBusiness.create({
    data: {
      id: tenant.gmbId,
      businessId: tenant.businessId,
      accessToken: `local-access-token-${label}-must-never-leak`,
      refreshToken: `local-refresh-token-${label}-must-never-leak`,
      tokenExpiry: new Date("2099-01-01T00:00:00.000Z"),
      locationId: `local-location-${label}`,
      timezone: "America/Toronto",
      verificationState: label === "A" ? "VERIFIED" : "UNVERIFIED",
      verified: label === "A",
      lastSyncError: `provider-secret-diagnostic-${label}-must-never-leak`,
    },
  });
  await prisma.account.create({
    data: {
      accountId: `security-account-${label}`,
      providerId: "credential",
      userId: tenant.userId,
      password: `local-password-hash-${label}-must-never-leak`,
    },
  });
  if (label === "A") {
    await prisma.quickScrapeBusiness.create({
      data: {
        userId: tenant.userId,
        businessName: "Security Resume A",
        businessType: "Security Test",
        businessWebsiteUrl: "https://resume-a.local.test",
        onboardingV2Status: "in_progress",
        onboardingV2LastSeenAt: new Date(),
      },
    });
  }
  await prisma.keywords.create({
    data: {
      id: tenant.keywordId,
      businessId: tenant.businessId,
      keyword: `tenant-${label.toLowerCase()}-keyword`,
      keywordType: "MUST_HAVE",
    },
  });
  await prisma.competitors.create({
    data: {
      id: tenant.competitorId,
      businessId: tenant.businessId,
      name: `Tenant ${label} Competitor`,
      url: `https://competitor-${label.toLowerCase()}.local.test`,
    },
  });
  await prisma.currentRanking.create({
    data: {
      id: tenant.rankingId,
      businessId: tenant.businessId,
      website: `https://rank-${label.toLowerCase()}.local.test`,
      ranking: "10",
    },
  });
  await prisma.meta.create({
    data: {
      id: tenant.metaId,
      seo_title: `Tenant ${label} private blog`,
      seo_description: `Private SEO metadata for tenant ${label}`,
      focus_keyword: `tenant-${label.toLowerCase()}-private-plan`,
      keywords: [`tenant-${label.toLowerCase()}-private-plan`],
    },
  });
  await prisma.customField.create({
    data: {
      id: tenant.customFieldId,
      reading_time: "2 min",
      rating: 8,
    },
  });
  await prisma.blog.create({
    data: {
      id: tenant.blogId,
      userId: tenant.userId,
      businessId: tenant.businessId,
      metaId: tenant.metaId,
      customFieldId: tenant.customFieldId,
      title: `Tenant ${label} private blog`,
      slug: `tenant-${label.toLowerCase()}-private-blog`,
      content: `<p>Private content belonging to tenant ${label}</p>`,
      excerpt: `Private excerpt for tenant ${label}`,
      categories: ["security"],
      tags: [`tenant-${label.toLowerCase()}`],
      featured_media: "",
      blogPublishDate: "2026-08-13",
      blogPublishTime: "12:00",
    },
  });
  await prisma.plan.create({
    data: {
      id: tenant.planId,
      userId: tenant.userId,
      businessId: tenant.businessId,
      keyword: `tenant-${label.toLowerCase()}-private-plan`,
      publishDate: "2026-08-14",
      publishTime: "12:00",
      keywordDiffculty: "10",
      keywordSearchVolume: "100",
    },
  });
}

async function main() {
  assertLocalDatabase();
  await prisma.quickScrapeBusiness.deleteMany({
    where: { userId: { in: [SECURITY_TENANT_A.userId, SECURITY_TENANT_B.userId] } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [SECURITY_TENANT_A.userId, SECURITY_TENANT_B.userId] } },
  });
  // Blog deletion follows the User relation, while its detached metadata rows
  // are independent records. Remove the deterministic local fixtures before
  // recreating them so the seed is repeatable without accumulating test data.
  await prisma.meta.deleteMany({
    where: { id: { in: [SECURITY_TENANT_A.metaId, SECURITY_TENANT_B.metaId] } },
  });
  await prisma.customField.deleteMany({
    where: { id: { in: [SECURITY_TENANT_A.customFieldId, SECURITY_TENANT_B.customFieldId] } },
  });
  await createTenant(SECURITY_TENANT_A, "A");
  await createTenant(SECURITY_TENANT_B, "B");
  console.log(JSON.stringify({ seeded: true, tenants: 2 }));
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
