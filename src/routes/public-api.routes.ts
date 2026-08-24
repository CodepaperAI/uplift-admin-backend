import type { STATUS } from "@prisma/client";
import type { Request, Response } from "express";
import { Router } from "express";
import { prisma } from "../config/db.config";
import { runPublicAudit } from "../controllers/public-audit.controller";
import { checkRobotsTxt, checkSitemap, checkCanonicalTag, checkMetadata, simulateCrawler, generateMetaDescriptions, generateTitleTags, generateBlogIdeas, generateAltText, generateKeywordSuggestions } from "../controllers/public-seo-tools.controller";
import { publicApiCors } from "../middleware/public-api-cors";
import { sensitiveRouteRateLimit } from "../middleware/sensitive-route-rate-limit";
import {
    API_TOKEN_V2_PREFIX,
    extractPublicTokenDetailsFromRequest,
    hashToken,
    isApiToken,
    isLegacyApiTokenValidationEnabled,
    isPublicTokenTransportAllowed,
    isWordPressKey,
    parseApiTokenV2,
    verifyApiTokenV2Digest,
} from "../utils/api-token.utils";
import { getBusinessLocalScheduleSnapshot } from "../utils/blog-schedule.utils";
import {
    buildExtendedBlogMeta,
    extractStoredSeoMeta,
    getBlogFreshnessInfo,
} from "../utils/blog-seo.utils";
import { normalizeCloudinaryImageUrl } from "../lib/cloudinary";
import { sanitizeBlogContentImageSources } from "../utils/blog-image-url.utils";
import { authenticateWordPressIntegrationKey } from "../utils/wordpress-key.utils";

const PublicApiRouter: Router = Router();

PublicApiRouter.use(publicApiCors);

const publicAuditRateLimit = sensitiveRouteRateLimit({
    namespace: "public-seo-audit",
    limit: 3,
    windowSeconds: 60 * 60,
});
const publicToolRateLimit = sensitiveRouteRateLimit({
    namespace: "public-seo-tools",
    limit: 10,
    windowSeconds: 60 * 60,
});

// Public SEO audit (no auth required)
PublicApiRouter.post("/seo-audit", publicAuditRateLimit, runPublicAudit);

// Public SEO tools (no auth required)
PublicApiRouter.post("/tools/robots-txt", publicToolRateLimit, checkRobotsTxt);
PublicApiRouter.post("/tools/sitemap", publicToolRateLimit, checkSitemap);
PublicApiRouter.post("/tools/canonical", publicToolRateLimit, checkCanonicalTag);
PublicApiRouter.post("/tools/metadata", publicToolRateLimit, checkMetadata);
PublicApiRouter.post("/tools/crawler", publicToolRateLimit, simulateCrawler);
PublicApiRouter.post("/tools/meta-descriptions", publicToolRateLimit, generateMetaDescriptions);
PublicApiRouter.post("/tools/title-tags", publicToolRateLimit, generateTitleTags);
PublicApiRouter.post("/tools/blog-ideas", publicToolRateLimit, generateBlogIdeas);
PublicApiRouter.post("/tools/alt-text", publicToolRateLimit, generateAltText);
PublicApiRouter.post("/tools/keyword-research", publicToolRateLimit, generateKeywordSuggestions);

interface TokenContext {
    userId: string;
    businessId: string;
    tokenId: string;
    permissions: string[];
    tokenType: "api_token" | "wordpress_key";
}

type PublicBusinessMetaContext = {
    businessName?: string | null;
    businessWebsiteUrl?: string | null;
    defaultLocale?: string | null;
};

async function validateApiToken(token: string): Promise<TokenContext | null> {
    const parsedV2Token = parseApiTokenV2(token);
    const isV2Token = token.startsWith(API_TOKEN_V2_PREFIX);
    if (isV2Token && !parsedV2Token) {
        return null;
    }
    if (!parsedV2Token && !isLegacyApiTokenValidationEnabled()) {
        return null;
    }

    const apiToken = await prisma.apiToken.findUnique({
        where: parsedV2Token
            ? { id: parsedV2Token.id }
            : { token: hashToken(token) },
        include: {
            business: {
                select: {
                    id: true,
                    isActive: true,
                },
            },
        },
    });

    if (!apiToken || !apiToken.isActive) {
        return null;
    }

    const digestVerification = parsedV2Token
        ? verifyApiTokenV2Digest(token, apiToken.token)
        : null;
    if (digestVerification && !digestVerification.valid) {
        return null;
    }

    if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
        return null;
    }

    if (!apiToken.business?.isActive) {
        return null;
    }

    await prisma.apiToken.update({
        where: { id: apiToken.id },
        data: {
            lastUsedAt: new Date(),
            ...(digestVerification?.needsRehash && digestVerification.currentDigest
                ? { token: digestVerification.currentDigest }
                : {}),
        },
    });

    return {
        userId: apiToken.userId,
        businessId: apiToken.businessId,
        tokenId: apiToken.id,
        permissions: apiToken.permissions,
        tokenType: "api_token",
    };
}

async function validateWordPressKey(key: string): Promise<TokenContext | null> {
    const integration = await authenticateWordPressIntegrationKey(key);

    if (!integration || !integration.isActive || !integration.business?.isActive) {
        return null;
    }

    const businessId = integration.businessId || integration.business?.id;

    if (!businessId) {
        const primaryBusiness = await prisma.business.findFirst({
            where: {
                userId: integration.userId,
                isPrimary: true,
                isActive: true,
            },
            select: { id: true },
        });

        if (!primaryBusiness) {
            return null;
        }

        return {
            userId: integration.userId,
            businessId: primaryBusiness.id,
            tokenId: integration.id,
            permissions: ["read:blogs", "read:keywords"],
            tokenType: "wordpress_key",
        };
    }

    return {
        userId: integration.userId,
        businessId,
        tokenId: integration.id,
        permissions: ["read:blogs", "read:keywords"],
        tokenType: "wordpress_key",
    };
}

async function validateTokenValue(token: string): Promise<TokenContext | null> {
    const trimmedToken = token.trim();

    if (isApiToken(trimmedToken)) {
        return validateApiToken(trimmedToken);
    }

    if (isWordPressKey(trimmedToken)) {
        return validateWordPressKey(trimmedToken);
    }

    return null;
}

async function validateTokenFromRequest(req: Request): Promise<TokenContext | null> {
    const extracted = extractPublicTokenDetailsFromRequest(req);
    if (!extracted) {
        return null;
    }

    // V2 bearer credentials are deliberately header-only so web server,
    // reverse-proxy, analytics, and browser-history logs never receive them
    // as URL path or query values.
    if (!isPublicTokenTransportAllowed(extracted)) {
        return null;
    }

    return validateTokenValue(extracted.token);
}

function resolvePublicBlogStatus(statusValue: unknown): STATUS | undefined {
    const normalizedStatus =
        typeof statusValue === "string" ? statusValue.trim().toUpperCase() : "";

    if (!normalizedStatus) {
        return "PUBLISH";
    }

    if (normalizedStatus === "ALL") {
        return undefined;
    }

    if (normalizedStatus === "PUBLISH" || normalizedStatus === "DRAFT") {
        return normalizedStatus as STATUS;
    }

    return "PUBLISH";
}

async function getPublicPublishDueFilter(businessId: string) {
    const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: {
            defaultLocale: true,
            businessCountry: true,
            businessState: true,
            businessCity: true,
        },
    });

    const snapshot = getBusinessLocalScheduleSnapshot(business ?? {});

    return {
        OR: [
            {
                blogPublishDate: {
                    lt: snapshot.date,
                },
            },
            {
                AND: [
                    { blogPublishDate: snapshot.date },
                    { blogPublishTime: { lte: snapshot.timeWithSeconds } },
                ],
            },
        ],
    };
}

function invalidTokenResponse(res: Response) {
    return res.status(401).json({
        success: false,
        error: "Unauthorized",
    });
}

function mapExtendedBlogMetaToPublicMeta(
    meta: ReturnType<typeof buildExtendedBlogMeta>,
) {
    return {
        seoTitle: meta.seo_title,
        seoDescription: meta.seo_description,
        focusKeyword: meta.focus_keyword,
        keywords: meta.keywords,
        ogTitle: meta.og_title,
        ogDescription: meta.og_description,
        ogType: meta.og_type,
        ogUrl: meta.og_url,
        ogSiteName: meta.og_site_name,
        ogLocale: meta.og_locale,
        articleAuthor: meta.article_author,
        articleSection: meta.article_section,
        articleTags: meta.article_tags,
    };
}

function formatPublicBlog(
    blog: {
        id: string;
        title: string;
        slug: string;
        excerpt: string | null;
        content: string;
        status: STATUS;
        blogPublishDate: string | null;
        blogPublishTime: string | null;
        featured_media: string;
        categories: string[];
        tags: string[];
        seoScore: number | null;
        analytics?: unknown;
        authorName?: string | null;
        authorUrl?: string | null;
        createdAt: Date;
        updatedAt: Date;
        meta?: {
            seo_title?: string | null;
            seo_description?: string | null;
            focus_keyword?: string | null;
            keywords?: string[] | null;
        } | null;
        customField?: {
            reading_time: string | null;
            rating: number | null;
        } | null;
    },
    business?: PublicBusinessMetaContext | null,
    includeAnalytics = false,
) {
    const normalizedFeaturedImage = normalizeCloudinaryImageUrl(blog.featured_media);
    const normalizedContent = sanitizeBlogContentImageSources(blog.content).content;

    const normalizedMeta = buildExtendedBlogMeta({
        title: blog.title,
        excerpt: blog.excerpt,
        slug: blog.slug,
        meta: {
            ...(blog.meta ?? {}),
            ...extractStoredSeoMeta(blog.analytics),
        },
        categories: blog.categories,
        tags: blog.tags,
        authorName: blog.authorName,
        businessName: business?.businessName,
        businessWebsiteUrl: business?.businessWebsiteUrl,
        defaultLocale: business?.defaultLocale,
    });

    return {
        id: blog.id,
        title: blog.title,
        slug: blog.slug,
        excerpt: blog.excerpt,
        content: normalizedContent,
        status: blog.status,
        publishDate: blog.blogPublishDate,
        publishTime: blog.blogPublishTime,
        featuredImage: normalizedFeaturedImage,
        categories: blog.categories,
        tags: blog.tags,
        seoScore: blog.seoScore,
        createdAt: blog.createdAt,
        updatedAt: blog.updatedAt,
        authorName: blog.authorName ?? null,
        authorUrl: blog.authorUrl ?? null,
        freshness: getBlogFreshnessInfo({
            blogPublishDate: blog.blogPublishDate,
            createdAt: blog.createdAt,
            updatedAt: blog.updatedAt,
        }),
        ...(includeAnalytics ? { analytics: blog.analytics ?? null } : {}),
        meta: mapExtendedBlogMetaToPublicMeta(normalizedMeta),
        customFields: blog.customField
            ? {
                  readingTime: blog.customField.reading_time,
                  rating: blog.customField.rating,
              }
            : null,
    };
}

async function handleListBlogs(req: Request, res: Response) {
    try {
        const tokenContext = await validateTokenFromRequest(req);

        if (!tokenContext) {
            return invalidTokenResponse(res);
        }

        if (!tokenContext.permissions.includes("read:blogs")) {
            return res.status(403).json({
                success: false,
                error: "Permission 'read:blogs' is required",
            });
        }

        const { businessId } = tokenContext;
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
        const skip = (page - 1) * limit;
        const status = resolvePublicBlogStatus(req.query.status);

        const dueFilter =
            status === "PUBLISH" ? await getPublicPublishDueFilter(businessId) : {};
        const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: {
                businessName: true,
                businessWebsiteUrl: true,
                defaultLocale: true,
            },
        });

        const whereClause = {
            businessId,
            ...(status ? { status } : {}),
            ...dueFilter,
        };

        const [blogs, total] = await Promise.all([
            prisma.blog.findMany({
                where: whereClause,
                select: {
                    id: true,
                    title: true,
                    slug: true,
                    excerpt: true,
                    content: true,
                    status: true,
                    blogPublishDate: true,
                    blogPublishTime: true,
                    featured_media: true,
                    categories: true,
                    tags: true,
                    seoScore: true,
                    analytics: true,
                    authorName: true,
                    authorUrl: true,
                    createdAt: true,
                    updatedAt: true,
                    meta: {
                        select: {
                            seo_title: true,
                            seo_description: true,
                            focus_keyword: true,
                            keywords: true,
                        },
                    },
                    customField: {
                        select: {
                            reading_time: true,
                            rating: true,
                        },
                    },
                },
                orderBy: {
                    createdAt: "desc",
                },
                skip,
                take: limit,
            }),
            prisma.blog.count({ where: whereClause }),
        ]);

        const formattedBlogs = blogs.map((blog) => formatPublicBlog(blog, business));

        return res.json({
            success: true,
            data: {
                blogs: formattedBlogs,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            },
        });
    } catch (error) {
        console.error("[Public API] Error fetching blogs:", error);
        return res.status(500).json({
            success: false,
            error: "Failed to fetch blogs",
        });
    }
}

async function handleGetBlogBySlug(req: Request, res: Response) {
    try {
        const tokenContext = await validateTokenFromRequest(req);
        const slug = req.params.slug;

        if (typeof slug !== "string") {
            return res.status(400).json({ success: false, error: "Invalid slug" });
        }

        if (!tokenContext) {
            return invalidTokenResponse(res);
        }

        if (!tokenContext.permissions.includes("read:blogs")) {
            return res.status(403).json({
                success: false,
                error: "Permission 'read:blogs' is required",
            });
        }

        const { businessId } = tokenContext;
        const status = resolvePublicBlogStatus(req.query.status);
        const dueFilter =
            status === "PUBLISH" ? await getPublicPublishDueFilter(businessId) : {};
        const business = await prisma.business.findUnique({
            where: { id: businessId },
            select: {
                businessName: true,
                businessWebsiteUrl: true,
                defaultLocale: true,
            },
        });

        const blog = await prisma.blog.findFirst({
            where: {
                slug,
                businessId,
                ...(status ? { status } : {}),
                ...dueFilter,
            },
            select: {
                id: true,
                title: true,
                slug: true,
                excerpt: true,
                content: true,
                status: true,
                blogPublishDate: true,
                blogPublishTime: true,
                featured_media: true,
                categories: true,
                tags: true,
                seoScore: true,
                analytics: true,
                authorName: true,
                authorUrl: true,
                createdAt: true,
                updatedAt: true,
                meta: {
                    select: {
                        seo_title: true,
                        seo_description: true,
                        focus_keyword: true,
                        keywords: true,
                    },
                },
                customField: {
                    select: {
                        reading_time: true,
                        rating: true,
                    },
                },
            },
        });

        if (!blog) {
            return res.status(404).json({
                success: false,
                error: "Blog not found",
            });
        }

        const formattedBlog = formatPublicBlog(blog, business, true);

        return res.json({
            success: true,
            data: {
                blog: formattedBlog,
            },
        });
    } catch (error) {
        console.error("[Public API] Error fetching blog:", error);
        return res.status(500).json({
            success: false,
            error: "Failed to fetch blog",
        });
    }
}

async function handleListKeywords(req: Request, res: Response) {
    try {
        const tokenContext = await validateTokenFromRequest(req);

        if (!tokenContext) {
            return invalidTokenResponse(res);
        }

        if (!tokenContext.permissions.includes("read:keywords")) {
            return res.status(403).json({
                success: false,
                error: "Permission 'read:keywords' is required",
            });
        }

        const { businessId } = tokenContext;
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
        const status = req.query.status as string;
        const skip = (page - 1) * limit;

        const whereClause = {
            businessId,
            deletedAt: null,
            ...(status
                ? {
                      blog: {
                          status: status.toUpperCase() as STATUS,
                      },
                  }
                : {}),
        };

        const [keywords, total] = await Promise.all([
            prisma.plan.findMany({
                where: whereClause,
                select: {
                    id: true,
                    keyword: true,
                    publishDate: true,
                    publishTime: true,
                    keywordDiffculty: true,
                    keywordSearchVolume: true,
                    keywordCpc: true,
                    keywordCompetition: true,
                    createdAt: true,
                    updatedAt: true,
                    blog: { select: { status: true } },
                },
                orderBy: {
                    publishDate: "asc",
                },
                skip,
                take: limit,
            }),
            prisma.plan.count({ where: whereClause }),
        ]);

        const formattedKeywords = keywords.map((kw) => ({
            id: kw.id,
            keyword: kw.keyword,
            publishDate: kw.publishDate,
            publishTime: kw.publishTime,
            difficulty: kw.keywordDiffculty,
            searchVolume: kw.keywordSearchVolume,
            cpc: kw.keywordCpc,
            competition: kw.keywordCompetition,
            blogStatus: kw.blog?.status ?? null,
            createdAt: kw.createdAt,
            updatedAt: kw.updatedAt,
        }));

        return res.json({
            success: true,
            data: {
                keywords: formattedKeywords,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            },
        });
    } catch (error) {
        console.error("[Public API] Error fetching keywords:", error);
        return res.status(500).json({
            success: false,
            error: "Failed to fetch keywords",
        });
    }
}

const publicCredentialReadLimit = sensitiveRouteRateLimit({
    namespace: "public-credential-read",
    limit: 180,
    windowSeconds: 60,
});

PublicApiRouter.get("/blogs/:token", publicCredentialReadLimit, handleListBlogs);
PublicApiRouter.get("/blogs", publicCredentialReadLimit, handleListBlogs);

PublicApiRouter.get("/blogs/:token/:slug", publicCredentialReadLimit, handleGetBlogBySlug);
PublicApiRouter.get("/blog/:slug", publicCredentialReadLimit, handleGetBlogBySlug);

PublicApiRouter.get("/keywords/:token", publicCredentialReadLimit, handleListKeywords);
PublicApiRouter.get("/keywords", publicCredentialReadLimit, handleListKeywords);

export default PublicApiRouter;
