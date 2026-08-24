import { createPrismaClient } from "../config/prisma-client.factory";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { syncManagedBacklinksForPublishedBlog } from "/Users/vinaysandhu/Desktop/Work/seo-tool/seo-be/src/services/managed-backlinks.service";

const prisma = createPrismaClient();
const databaseUrl = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(databaseUrl)) {
  throw new Error("This destructive smoke test is restricted to a local database");
}
const suffix = crypto.randomBytes(5).toString("hex");
const targetDomain = `backlink-e2e-${suffix}.invalid`;
const sourcePostUrl = `https://codepaper.com/blog/backlink-e2e-${suffix}`;
const targetPostUrl = `https://${targetDomain}/resources/security-guide`;

let temporaryUserId: string | null = null;
let temporaryBusinessId: string | null = null;
let temporaryBlogId: string | null = null;
let temporaryMetaId: string | null = null;
let temporaryCustomFieldId: string | null = null;

function sign(userId: string): string {
  const secret = process.env.BACKEND_AUTH_SECRET?.trim() ?? "";
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("BACKEND_AUTH_SECRET is not configured for the smoke test");
  }
  const now = Date.now();
  const payload = {
    v: 1,
    iss: "uplift-next",
    aud: "uplift-api",
    userId,
    iat: now,
    exp: now + 5 * 60 * 1000,
    jti: crypto.randomBytes(16).toString("base64url"),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${signature}`;
}

async function api(userId: string | null, businessId: string) {
  return fetch("http://localhost:3000/api/v1/backlink/all", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(userId ? { Authorization: `Bearer ${sign(userId)}` } : {}),
    },
    body: JSON.stringify({ businessId }),
  });
}

try {
  const sourceBusiness = await prisma.business.findFirst({
    where: { businessName: "Codepaper Inc.", isActive: true },
    select: { id: true, userId: true },
  });
  if (!sourceBusiness) throw new Error("Codepaper source business was not found");

  const temporaryUser = await prisma.user.create({
    data: {
      email: `backlink-e2e-${suffix}@example.invalid`,
      name: "Backlink E2E Tenant",
      emailVerified: true,
    },
    select: { id: true },
  });
  temporaryUserId = temporaryUser.id;

  const temporaryBusiness = await prisma.business.create({
    data: {
      businessName: `Backlink E2E Target ${suffix}`,
      businessType: "Test fixture",
      businessDescription: "Temporary managed backlink E2E target",
      businessWebsiteUrl: `https://${targetDomain}/`,
      serviceAreaLocations: [],
      preferredContentTypes: [],
      supportedLanguages: ["en"],
      exampleBlogUrls: [],
      authorExpertise: [],
      userId: temporaryUser.id,
      isActive: true,
      isPrimary: true,
      websiteStatus: "active",
    },
    select: { id: true },
  });
  temporaryBusinessId = temporaryBusiness.id;

  const meta = await prisma.meta.create({
    data: {
      seo_title: "Managed backlink E2E",
      seo_description: "Disposable E2E fixture",
      focus_keyword: "managed backlink",
      keywords: ["managed backlink"],
    },
    select: { id: true },
  });
  temporaryMetaId = meta.id;

  const customField = await prisma.customField.create({
    data: { reading_time: "1 min", rating: 5 },
    select: { id: true },
  });
  temporaryCustomFieldId = customField.id;

  const blog = await prisma.blog.create({
    data: {
      title: "Managed Backlink E2E",
      slug: `backlink-e2e-${suffix}`,
      status: "PUBLISH",
      content: `<h1>Managed Backlink E2E</h1><p>Read the <a href="${targetPostUrl}">security guide</a>.</p>`,
      excerpt: "Disposable E2E fixture",
      categories: ["Test"],
      tags: ["test"],
      featured_media: "",
      blogPublishTime: "00:00",
      blogPublishDate: new Date().toISOString().slice(0, 10),
      metaId: meta.id,
      customFieldId: customField.id,
      userId: sourceBusiness.userId,
      businessId: sourceBusiness.id,
    },
    select: { id: true },
  });
  temporaryBlogId = blog.id;

  const syncCreated = await syncManagedBacklinksForPublishedBlog({
    blogId: blog.id,
    publishedUrl: sourcePostUrl,
  });

  const unauthorizedResponse = await api(null, temporaryBusiness.id);
  const crossTenantResponse = await api(sourceBusiness.userId, temporaryBusiness.id);
  const ownerResponse = await api(temporaryUser.id, temporaryBusiness.id);
  const ownerPayload = await ownerResponse.json() as {
    data?: { backlinks?: Array<Record<string, unknown>> };
  };

  await prisma.blog.update({
    where: { id: blog.id },
    data: { content: "<h1>Managed Backlink E2E</h1><p>The managed link was removed.</p>" },
  });
  const syncRemoved = await syncManagedBacklinksForPublishedBlog({
    blogId: blog.id,
    publishedUrl: sourcePostUrl,
  });
  const afterRemovalResponse = await api(temporaryUser.id, temporaryBusiness.id);
  const afterRemovalPayload = await afterRemovalResponse.json() as {
    data?: { backlinks?: Array<Record<string, unknown>> };
  };

  const result = {
    persistence: {
      created: syncCreated.backlinksCreated,
      removedAfterContentUpdate: syncRemoved.backlinksCreated === 0,
    },
    api: {
      missingAuthStatus: unauthorizedResponse.status,
      crossTenantStatus: crossTenantResponse.status,
      ownerStatus: ownerResponse.status,
      ownerRows: ownerPayload.data?.backlinks?.length ?? -1,
      rowsAfterRemoval: afterRemovalPayload.data?.backlinks?.length ?? -1,
    },
  };

  if (
    result.persistence.created !== 1 ||
    !result.persistence.removedAfterContentUpdate ||
    result.api.missingAuthStatus !== 401 ||
    result.api.crossTenantStatus !== 404 ||
    result.api.ownerStatus !== 200 ||
    result.api.ownerRows !== 1 ||
    result.api.rowsAfterRemoval !== 0
  ) {
    throw new Error(`Backlink E2E failed: ${JSON.stringify(result)}`);
  }

  console.log(JSON.stringify({ success: true, ...result }, null, 2));
} finally {
  if (temporaryBlogId) {
    await prisma.blog.deleteMany({ where: { id: temporaryBlogId } });
  }
  if (temporaryMetaId) {
    await prisma.meta.deleteMany({ where: { id: temporaryMetaId } });
  }
  if (temporaryCustomFieldId) {
    await prisma.customField.deleteMany({ where: { id: temporaryCustomFieldId } });
  }
  if (temporaryBusinessId) {
    await prisma.business.deleteMany({ where: { id: temporaryBusinessId } });
  }
  if (temporaryUserId) {
    await prisma.user.deleteMany({ where: { id: temporaryUserId } });
  }
  await prisma.$disconnect();
}
