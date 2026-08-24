import z from "zod";
import { USER_INPUT_LIMITS } from "../config/user-input-limits";

const boundedTitle = z.string().trim().max(300);
const boundedDescription = z.string().max(USER_INPUT_LIMITS.description);
const boundedKeyword = z.string().trim().max(USER_INPUT_LIMITS.keyword);
const boundedUrl = z.string().max(USER_INPUT_LIMITS.url);
const boundedTaxonomy = z.array(z.string().trim().max(160)).max(100);

export const CREATE_BLOG = z.object({
  userId: z.string().optional(),
  businessId: z.string(),
  title: boundedTitle.min(1, "Title is required"),
  slug: z.string().trim().min(1, "Slug is required").max(300),
  status: z.enum(["DRAFT", "PUBLISH"]).default("DRAFT"),
  author: z.string().trim().min(1, "Author name is required").max(USER_INPUT_LIMITS.authorName),
  content: z.string().min(1, "Content is required").max(USER_INPUT_LIMITS.richTextContent),
  excerpt: boundedDescription,
  categories: boundedTaxonomy,
  tags: boundedTaxonomy,
  featured_media: boundedUrl,
  keywordId: z.string().optional(),
  seoScore: z.number().int().min(0).max(100).optional(),
  analytics: z
    .object({
      contentQualityScore: z.number().int().min(0).max(100), // LLM-generated (0-100)
      rankingPotential: z.enum(["HIGH", "MEDIUM", "LOW"]), // LLM-generated
      conversionPotential: z.enum(["HIGH", "MEDIUM", "LOW"]), // LLM-generated
      externalLinksCount: z.number().int().min(0), // Derived from parsed HTML links
      selectedTitle: z
        .object({
          title: z.string(),
          seoTitle: z.string(),
          structureType: z.string(),
          contentIntent: z.string(),
          keywordUsed: z.string(),
          characterCount: z.number().optional(),
          keywordPosition: z.number().optional(),
        })
        .optional(), // Pre-selected title from title generation
      alignmentScore: z.number().min(0).max(10).optional(),
      alignmentIssues: z.array(z.string()).optional(),
      titleAdjusted: z.boolean().optional(),
      titleAdjustmentSkippedReason: z.string().nullable().optional(),
      suggestedAdjustedTitle: z.string().nullable().optional(),
      originalTitle: z.string().optional(),
      adjustedTitle: z.string().optional(),
    })
    .passthrough()
    .optional(),

  meta: z.object({
    seo_title: boundedTitle.min(1, "SEO title is required"),
    seo_description: boundedDescription.min(1, "SEO description is required"),
    focus_keyword: boundedKeyword,
    keywords: z.array(boundedKeyword).max(100),
    og_title: boundedTitle.optional(),
    og_description: boundedDescription.optional(),
    og_type: z.string().optional(),
    og_url: boundedUrl.optional(),
    og_site_name: z.string().max(300).optional(),
    og_locale: z.string().optional(),
    article_author: z.string().max(USER_INPUT_LIMITS.authorName).optional(),
    article_section: z.string().max(160).optional(),
    article_tags: boundedTaxonomy.optional(),
  }),

  custom_fields: z.object({
    reading_time: z.string(),
    rating: z.number().int().min(0).max(10),
  }),

  blogPublishInfo: z.object({
    date: z.string(),
    time: z.string(),
  }),

  links_created: z
    .array(
      z.object({
        url: z.string(),
        businessId: z.string(),
      })
    )
    .optional(), // Deprecated debug-only metadata; not used for backlink persistence
});

export const GET_ALL_BLOGS = z
  .object({
    businessId: z.string().uuid().optional(),
  })
  .strict();

export const GET_BLOG_BY_ID = z
  .object({
    blogId: z.string(),
  })
  .strict();

export const GET_BLOG_BY_SLUG = z
  .object({
    slug: z.string().trim().min(1).max(300).optional(),
    blogId: z.string().uuid().optional(),
  })
  .refine((value) => Boolean(value.slug) !== Boolean(value.blogId), "Provide exactly one blog identifier")
  .strict();

export const GET_KEYWORD_INFO = z
  .object({
    keywordId: z.string(),
    userId: z.string().optional(),
    businessId: z.string().optional(),
    selectedTitle: z
      .object({
        title: z.string(),
        seoTitle: z.string(),
        structureType: z.string(),
        contentIntent: z.string(),
        keywordUsed: z.string(),
      })
      .optional(),
  })
  .strict();

export const GET_KEYWORD_INFO_STRICT = z
  .object({
    keywordId: z.string(),
    userId: z.string().optional(),
    businessId: z.string(),
    selectedTitle: z
      .object({
        title: z.string(),
        seoTitle: z.string(),
        structureType: z.string(),
        contentIntent: z.string(),
        keywordUsed: z.string(),
      })
      .optional(),
  })
  .strict();

export const GET_BLOG_GENERATION_STATUSES_BODY = z
  .object({
    businessId: z.string().min(1),
    userId: z.string().optional(),
  })
  .strict();

export const GENERATE_TITLES_BODY = z.object({
  userId: z.string().optional(),
  keywordId: z.string(),
  businessId: z.string(),
});

export const REGENERATE_MISSED_BLOGS = z
  .object({
    userId: z.string().optional(),
    businessId: z.string(),
    limit: z.number().int().min(1).max(250).default(50),
  })
  .strict();

export const UPDATE_BLOG = z.object({
  title: boundedTitle.min(1, "Title is required").optional(),
  content: z.string().min(1, "Content is required").max(USER_INPUT_LIMITS.richTextContent).optional(),
  excerpt: boundedDescription.optional(),
  categories: boundedTaxonomy.optional(),
  tags: boundedTaxonomy.optional(),
  featured_media: boundedUrl.optional(),
  status: z.enum(["DRAFT", "PUBLISH"]).optional(),
  seoScore: z.number().int().min(0).max(100).optional().nullable(),
  meta: z
    .object({
      seo_title: boundedTitle.optional(),
      seo_description: boundedDescription.optional(),
      focus_keyword: boundedKeyword.optional(),
      keywords: z.array(boundedKeyword).max(100).optional(),
      og_title: boundedTitle.optional(),
      og_description: boundedDescription.optional(),
      og_type: z.string().optional(),
      og_url: boundedUrl.optional(),
      og_site_name: z.string().max(300).optional(),
      og_locale: z.string().optional(),
      article_author: z.string().max(USER_INPUT_LIMITS.authorName).optional(),
      article_section: z.string().max(160).optional(),
      article_tags: boundedTaxonomy.optional(),
    })
    .optional(),
  custom_fields: z
    .object({
      reading_time: z.string().optional(),
      rating: z.number().int().min(0).max(10).optional(),
    })
    .optional(),
  blogPublishInfo: z
    .object({
      date: z.string().optional(),
      time: z.string().optional(),
    })
    .optional(),
});
