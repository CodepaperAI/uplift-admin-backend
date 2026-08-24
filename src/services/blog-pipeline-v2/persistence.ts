import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../config/db.config";
import { buildExtendedBlogMeta } from "../../utils/blog-seo.utils";
import {
  hasActiveBlogGenerationAccess,
  isBlogGenerationBusinessLifecycleActive,
} from "../../utils/blog-generation-access.utils";
import { invalidateTenantCache } from "../../utils/tenant-response-cache";
import { syncManagedBacklinksForPublishedBlog } from "../managed-backlinks.service";
import { BLOG_PIPELINE_V2_VERSION } from "./constants";
import type { ProductionBlogImage } from "./image-pipeline";
import type { ProductionLinkCandidate } from "./link-selector";
import type { ProductionContentStrategyContext } from "./content-strategy";
import {
  appendProductionBlogStructuredData,
  buildProductionBlogStructuredData,
} from "./structured-data";

export class ProductionBlogPersistenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProductionBlogPersistenceError";
  }
}

export type ProductionBlogPersistenceInput = {
  planId: string;
  userId: string;
  businessId: string;
  correlationId: string;
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  keyword: string;
  locale: string;
  featuredMedia: string;
  images: ProductionBlogImage[];
  links: ProductionLinkCandidate[];
  sourceUrls: string[];
  titleStrategy: unknown;
  cost: Record<string, unknown>;
  wordCount: number;
  contentQualityScore: number;
  contentStrategy?: ProductionContentStrategyContext | null;
};

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function activeEntitlement(plan: any, now: Date): boolean {
  const user = plan.business?.User;
  const website = plan.business?.websiteSubscription;
  return Boolean(
    user &&
      hasActiveBlogGenerationAccess({
        user,
        websiteSubscription: website ?? null,
        now,
      }),
  );
}

function readingTime(wordCount: number): string {
  return `${Math.max(1, Math.ceil(wordCount / 225))} min read`;
}

export async function persistProductionBlog(
  input: ProductionBlogPersistenceInput,
  prisma: PrismaClient = defaultPrisma,
  syncBacklinks: typeof syncManagedBacklinksForPublishedBlog =
    syncManagedBacklinksForPublishedBlog,
): Promise<{ blogId: string; alreadyExisted: boolean }> {
  const now = new Date();
  const result = await prisma.$transaction(
    async (tx) => {
      const plan = await tx.plan.findUnique({
        where: { id: input.planId },
        include: {
          business: {
            include: {
              websiteSubscription: true,
              User: { include: { Subscription: true } },
            },
          },
        },
      });
      if (!plan) throw new ProductionBlogPersistenceError("plan_not_found", "Plan not found");
      if (plan.deletedAt) throw new ProductionBlogPersistenceError("plan_deleted", "Plan is deleted");
      if (
        plan.userId !== input.userId ||
        plan.businessId !== input.businessId ||
        plan.business?.userId !== input.userId
      ) {
        throw new ProductionBlogPersistenceError(
          "ownership_mismatch",
          "Plan ownership changed before persistence",
        );
      }
      if (
        !plan.business ||
        !isBlogGenerationBusinessLifecycleActive({
          isActive: plan.business.isActive,
          websiteStatus: plan.business.websiteStatus,
          websiteSubscription: plan.business.websiteSubscription,
          now,
        })
      ) {
        throw new ProductionBlogPersistenceError("business_inactive", "Business is inactive");
      }
      if (!activeEntitlement(plan, now)) {
        throw new ProductionBlogPersistenceError(
          "entitlement_inactive",
          "Entitlement changed before persistence",
        );
      }
      if (plan.blogId) {
        if (plan.isUsed && plan.usedAt) {
          const linkedBlog = await tx.blog.findUnique({
            where: { id: plan.blogId },
            select: {
              id: true,
              userId: true,
              businessId: true,
              status: true,
              analytics: true,
            },
          });
          const analytics =
            linkedBlog?.analytics &&
            typeof linkedBlog.analytics === "object" &&
            !Array.isArray(linkedBlog.analytics)
              ? (linkedBlog.analytics as Record<string, unknown>)
              : {};
          const productionPipeline =
            analytics.productionPipeline &&
            typeof analytics.productionPipeline === "object" &&
            !Array.isArray(analytics.productionPipeline)
              ? (analytics.productionPipeline as Record<string, unknown>)
              : {};
          if (
            !linkedBlog ||
            linkedBlog.userId !== input.userId ||
            linkedBlog.businessId !== input.businessId ||
            linkedBlog.status !== "PUBLISH" ||
            productionPipeline.version !== BLOG_PIPELINE_V2_VERSION ||
            productionPipeline.correlationId !== input.correlationId ||
            productionPipeline.planId !== input.planId
          ) {
            throw new ProductionBlogPersistenceError(
              "plan_linked_by_other_pipeline",
              "Plan was linked by a different or inconsistent pipeline run",
            );
          }
          return { blogId: plan.blogId, alreadyExisted: true };
        }
        throw new ProductionBlogPersistenceError(
          "plan_state_inconsistent",
          "Plan linkage is inconsistent",
        );
      }
      if (plan.isUsed || plan.usedAt) {
        throw new ProductionBlogPersistenceError(
          "plan_state_inconsistent",
          "Unlinked Plan is already used",
        );
      }
      const duplicate = await tx.blog.findFirst({
        where: {
          businessId: input.businessId,
          OR: [
            { slug: input.slug },
            { title: { equals: input.title, mode: "insensitive" } },
            { meta: { focus_keyword: { equals: input.keyword, mode: "insensitive" } } },
          ],
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new ProductionBlogPersistenceError(
          "duplicate_blog",
          `Existing Blog ${duplicate.id} conflicts with this Plan`,
        );
      }

      const authorName =
        plan.business.authorName?.trim() || plan.business.businessName;
      const tags = [...new Set(input.keyword.toLocaleLowerCase().split(/\s+/).filter(Boolean))];
      const categories = [plan.business.businessType || "Blog"];
      const normalizedMeta = buildExtendedBlogMeta({
        title: input.title,
        excerpt: input.excerpt,
        slug: input.slug,
        meta: {
          seo_title: input.title,
          seo_description: input.excerpt,
          focus_keyword: input.keyword,
          keywords: [input.keyword, ...tags],
        },
        categories,
        tags,
        authorName,
        businessName: plan.business.businessName,
        businessWebsiteUrl: plan.business.businessWebsiteUrl,
        defaultLocale: input.locale,
      });
      const structuredData = buildProductionBlogStructuredData({
        title: input.title,
        excerpt: input.excerpt,
        slug: input.slug,
        keyword: input.keyword,
        locale: input.locale,
        images: input.images.map((image) => image.url),
        authorName,
        businessName: plan.business.businessName,
        businessWebsiteUrl: plan.business.businessWebsiteUrl,
        publishDate: plan.publishDate,
        modifiedDate: now.toISOString(),
        categories,
        tags,
      });
      const contentWithStructuredData = appendProductionBlogStructuredData(
        input.content,
        structuredData,
      );
      const analytics = json({
        rankingPotential: "HIGH",
        conversionPotential: "HIGH",
        contentQuality: "HIGH",
        contentQualityScore: input.contentQualityScore,
        seoMeta: normalizedMeta,
        structuredData,
        productionPipeline: {
          version: BLOG_PIPELINE_V2_VERSION,
          correlationId: input.correlationId,
          planId: input.planId,
          locale: input.locale,
          wordCount: input.wordCount,
          contentQualityScore: input.contentQualityScore,
          titleStrategy: input.titleStrategy,
          sourceUrls: input.sourceUrls,
          images: input.images,
          approvedLinks: input.links,
          contentStrategy: input.contentStrategy ?? null,
          cost: input.cost,
          importedAt: now.toISOString(),
        },
      });
      const meta = await tx.meta.create({
        data: {
          seo_title: normalizedMeta.seo_title,
          seo_description: normalizedMeta.seo_description,
          focus_keyword: normalizedMeta.focus_keyword,
          keywords: normalizedMeta.keywords,
        },
      });
      const customField = await tx.customField.create({
        data: { reading_time: readingTime(input.wordCount), rating: 10 },
      });
      const blog = await tx.blog.create({
        data: {
          userId: input.userId,
          businessId: input.businessId,
          title: input.title,
          slug: input.slug,
          status: "PUBLISH",
          content: contentWithStructuredData,
          excerpt: input.excerpt,
          categories,
          tags,
          featured_media: input.featuredMedia,
          canonicalUrl: normalizedMeta.og_url || null,
          blogPublishDate: plan.publishDate,
          blogPublishTime: plan.publishTime,
          seoScore: 100,
          analytics,
          authorName,
          authorBio: plan.business.authorBio,
          authorUrl: plan.business.businessWebsiteUrl,
          authorImage: plan.business.authorImage,
          clusterId: plan.clusterId,
          clusterRole: plan.clusterRole,
          metaId: meta.id,
          customFieldId: customField.id,
        },
      });
      const linked = await tx.plan.updateMany({
        where: {
          id: input.planId,
          userId: input.userId,
          businessId: input.businessId,
          deletedAt: null,
          blogId: null,
          isUsed: false,
          usedAt: null,
        },
        data: { blogId: blog.id, isUsed: true, usedAt: now },
      });
      if (linked.count !== 1) {
        throw new ProductionBlogPersistenceError(
          "stale_plan_race",
          "Plan changed during transactional linkage",
        );
      }
      return { blogId: blog.id, alreadyExisted: false };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    },
  );

  await syncBacklinks({
    blogId: result.blogId,
    approvedManagedUrls: input.links
      .filter((link) => link.kind === "managed_backlink")
      .map((link) => link.url),
  });
  await Promise.all([
    invalidateTenantCache(input.userId),
    invalidateTenantCache(input.userId, input.businessId),
  ]);
  return result;
}
