"use node";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createGPT56LunaModel } from "../config/llm.config";
import { prisma } from "../config/db.config";
import {
  normalizeGmbPostTypeForPublishing,
  type InternalGMBPostType,
} from "../utils/google-my-business-local-post.utils";
import { getGmbReviewWindowStart } from "../utils/gmb-review-window.utils";
import {
  filterOutGenericServices,
  isGenericService,
} from "../utils/generic-services.utils";
import { imageGenerationService } from "./image-generation.service";

const AI_CACHE_TTL_DAYS = 15;

// Persistent (DB-backed) cache for AI-generated profile proposals. The TTL
// is long because the cache is also keyed by an SHA-256 hash of the input
// fields — when the business edits its name/description/services, the hash
// changes and the next call regenerates. Without an input change, identical
// inputs return identical output for 14 days, eliminating LLM-output drift
// and re-billing.
const PROFILE_PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// Must match the completeness-rule threshold in gmb-local-visibility.service.ts
// (descriptionLength > 700 triggers the "trim" recommendation). Keeping these
// aligned prevents AI-generated descriptions from immediately being flagged
// as too long and creating a regenerate-then-trim loop.
const GOOGLE_PROFILE_DESCRIPTION_SAFE_LIMIT = 700;

export class GMBPostSuggestionSetupError extends Error {
  statusCode = 409;

  constructor(
    public readonly code:
      | "GMB_CONNECTION_REQUIRED"
      | "GMB_LOCATION_SELECTION_REQUIRED",
    message: string
  ) {
    super(message);
    this.name = "GMBPostSuggestionSetupError";
  }
}

type ProfileServiceProposal = {
  displayName: string;
  description: string;
};

// Zod schema enforced on every LLM response. Anything failing this schema
// triggers a single retry with a stricter prompt; a second failure falls
// back to the deterministic generic shape so the page never breaks.
const profileProposalLLMSchema = z.object({
  description: z
    .string()
    .min(40, "description must be at least 40 chars to be useful")
    .max(700, "description must stay under the 700 char completeness threshold"),
  categories: z.array(z.string().min(1)).min(1).max(5),
  services: z.array(z.unknown()).min(3).max(12),
});

type ValidatedProfileProposal = {
  description: string;
  categories: string[];
  services: ProfileServiceProposal[];
};

interface GMBProfileData {
  businessName: string | null;
  businessAddress: string | null;
  businessPhone: string | null;
  businessWebsite: string | null;
  locationName: string | null;
  reviewCount: number;
  averageRating: number;
  pendingReviewCount: number;
  recentPostCount: number;
}

interface GMBSuggestion {
  id: string;
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  category: "profile" | "engagement" | "seo" | "content";
  impact: string;
}

interface ReviewResponseRequest {
  reviewerName: string;
  rating: number;
  comment: string | null;
  businessName: string;
  businessType?: string;
  reviewId?: string;
}

interface SuggestionsResponse {
  suggestions: GMBSuggestion[];
  profileCompleteness: number;
  cachedAt?: string;
  expiresAt?: string;
  source: "cache" | "live";
}

type ReviewIntent = "complaint" | "praise" | "question" | "suggestion" | "mixed" | "neutral";

interface ReviewResponseResult {
  response: string;
  intent?: ReviewIntent;
  cachedAt?: string;
  expiresAt?: string;
  source: "cache" | "live";
}

interface PostSuggestion {
  id: string;
  postType: InternalGMBPostType;
  title: string;
  summary: string;
  callToAction: string;
  sourceBlogId: string | null;
  sourceBlogTitle: string | null;
  sourceKeyword: string | null;
  mediaUrl?: string;
}

interface PostSuggestionsResponse {
  suggestions: PostSuggestion[];
  cachedAt?: string;
  expiresAt?: string;
  source: "cache" | "live";
}

interface SentimentBreakdown {
  positive: number;
  neutral: number;
  negative: number;
  positivePercent: number;
  neutralPercent: number;
  negativePercent: number;
}

interface CommonTheme {
  theme: string;
  count: number;
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  examples: string[];
}

interface BusinessInsight {
  category: string;
  insight: string;
  priority: "high" | "medium" | "low";
  actionItems: string[];
}

interface ReviewAnalysisResponse {
  sentimentSummary: SentimentBreakdown;
  commonThemes: CommonTheme[];
  businessInsights: BusinessInsight[];
  totalReviewsAnalyzed: number;
  averageRating: number;
  cachedAt?: string;
  expiresAt?: string;
  source: "cache" | "live";
}

export class GMBAIService {
  private llm = createGPT56LunaModel();
  // Dedicated low-temperature model for profile-proposal generation. Profile
  // suggestions need stability, not creativity — temp 0.2 produces near
  // identical output across calls so businesses see consistent
  // recommendations even when the cache misses. Other LLM uses (post drafts,
  // review replies) keep the warm model for variety.
  private proposalLlm = createGPT56LunaModel();

  private normalizeSuggestedPostType(postType: string) {
    const requestedPostType = (
      ["UPDATE", "EVENT", "OFFER", "PRODUCT"].includes(postType)
        ? postType
        : "UPDATE"
    ) as InternalGMBPostType;
    const normalized = normalizeGmbPostTypeForPublishing(requestedPostType);

    if (normalized.warnings.length > 0) {
      console.warn("[GMB AI] Normalized unsupported suggested post type:", {
        requestedPostType,
        effectivePostType: normalized.effectivePostType,
        warnings: normalized.warnings,
      });
    }

    return normalized.effectivePostType;
  }

  async generateSuggestions(
    businessId: string,
    forceRefresh = false
  ): Promise<SuggestionsResponse> {
    if (!forceRefresh) {
      const cached = await this.getCachedSuggestions(businessId);
      if (cached) {
        return cached;
      }
    }

    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      include: {
        gmbPosts: {
          where: {
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
        },
        gmbReviews: {
          where: {
            reviewDate: { gte: getGmbReviewWindowStart() },
          },
        },
      },
    });

    if (!gmb) {
      throw new Error("Google My Business connection not found");
    }

    const profileData: GMBProfileData = {
      businessName: gmb.businessName,
      businessAddress: gmb.businessAddress,
      businessPhone: gmb.businessPhone,
      businessWebsite: gmb.businessWebsite,
      locationName: gmb.locationName,
      reviewCount: gmb.gmbReviews.length,
      averageRating: this.calculateAverageRating(gmb.gmbReviews),
      pendingReviewCount: gmb.gmbReviews.filter((r: { isResponded: boolean }) => !r.isResponded).length,
      recentPostCount: gmb.gmbPosts.length,
    };

    const profileCompleteness = this.calculateProfileCompleteness(profileData);

    const systemPrompt = `You are a Google My Business optimization expert. Analyze the provided business profile data and generate actionable suggestions to improve local SEO performance and customer engagement.

Return a JSON array of suggestions. Each suggestion must have:
- id: unique string identifier
- title: short action title (max 50 chars)
- description: detailed explanation with specific metrics when possible (max 200 chars)
- priority: "high", "medium", or "low" based on impact
- category: "profile", "engagement", "seo", or "content"
- impact: one-line impact statement

Focus on the most impactful improvements based on what's missing or underperforming.
Return ONLY valid JSON array, no other text.`;

    const userPrompt = `Analyze this Google My Business profile and generate 5-7 optimization suggestions:

Business Name: ${profileData.businessName || "Not set"}
Address: ${profileData.businessAddress || "Not set"}
Phone: ${profileData.businessPhone || "Not set"}
Website: ${profileData.businessWebsite || "Not set"}
Location Name: ${profileData.locationName || "Not set"}

Review Stats:
- Total Reviews: ${profileData.reviewCount}
- Average Rating: ${profileData.averageRating.toFixed(1)}/5
- Pending Responses: ${profileData.pendingReviewCount}

Content Stats:
- Posts in last 30 days: ${profileData.recentPostCount}

Profile Completeness: ${profileCompleteness}%

Generate suggestions to improve their Google My Business presence.`;

    try {
      const response = await this.llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);

      const content =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);

      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        const fallback = this.getFallbackSuggestions(profileData, profileCompleteness);
        return { ...fallback, source: "live" };
      }

      const suggestions = JSON.parse(jsonMatch[0]) as GMBSuggestion[];
      const result: SuggestionsResponse = {
        suggestions: suggestions.slice(0, 7),
        profileCompleteness,
        source: "live",
      };

      await this.cacheSuggestions(businessId, result);

      const cachedRecord = await prisma.gMBAISuggestion.findUnique({
        where: { businessId },
      });

      if (cachedRecord) {
        result.cachedAt = cachedRecord.generatedAt.toISOString();
        result.expiresAt = cachedRecord.expiresAt.toISOString();
      }

      return result;
    } catch (error) {
      console.error("Failed to generate AI suggestions:", error);
      const fallback = this.getFallbackSuggestions(profileData, profileCompleteness);
      return { ...fallback, source: "live" };
    }
  }

  private async getCachedSuggestions(
    businessId: string
  ): Promise<SuggestionsResponse | null> {
    const cached = await prisma.gMBAISuggestion.findUnique({
      where: { businessId },
    });

    if (!cached) {
      return null;
    }

    if (new Date() > cached.expiresAt) {
      await prisma.gMBAISuggestion.delete({ where: { businessId } });
      return null;
    }

    return {
      suggestions: cached.suggestions as unknown as GMBSuggestion[],
      profileCompleteness: cached.profileCompleteness,
      cachedAt: cached.generatedAt.toISOString(),
      expiresAt: cached.expiresAt.toISOString(),
      source: "cache",
    };
  }

  private async cacheSuggestions(
    businessId: string,
    data: SuggestionsResponse
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + AI_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

    await prisma.gMBAISuggestion.upsert({
      where: { businessId },
      create: {
        businessId,
        suggestions: data.suggestions as unknown as Prisma.InputJsonValue,
        profileCompleteness: data.profileCompleteness,
        generatedAt: now,
        expiresAt,
      },
      update: {
        suggestions: data.suggestions as unknown as Prisma.InputJsonValue,
        profileCompleteness: data.profileCompleteness,
        generatedAt: now,
        expiresAt,
      },
    });
  }

  async invalidateSuggestionsCache(businessId: string): Promise<void> {
    await prisma.gMBAISuggestion.deleteMany({
      where: { businessId },
    });
  }

  private async classifyReviewIntent(
    comment: string | null,
    rating: number
  ): Promise<ReviewIntent> {
    if (!comment || comment.trim().length < 5) {
      return rating >= 4 ? "praise" : rating <= 2 ? "complaint" : "neutral";
    }

    const classificationPrompt = `Classify the intent of this customer review into exactly ONE of these categories:
- complaint: expressing dissatisfaction, reporting a problem, or negative experience
- praise: expressing satisfaction, compliments, or positive experience
- question: asking for information or clarification
- suggestion: providing feedback or ideas for improvement
- mixed: contains both positive and negative elements
- neutral: general comment without strong sentiment

Review (${rating}/5 stars): "${comment}"

Return ONLY one word from: complaint, praise, question, suggestion, mixed, neutral`;

    try {
      const response = await this.llm.invoke([
        new HumanMessage(classificationPrompt),
      ]);

      const content =
        typeof response.content === "string"
          ? response.content.toLowerCase().trim()
          : "neutral";

      const validIntents: ReviewIntent[] = [
        "complaint",
        "praise",
        "question",
        "suggestion",
        "mixed",
        "neutral",
      ];
      const matchedIntent = validIntents.find((intent) =>
        content.includes(intent)
      );

      return matchedIntent || (rating >= 4 ? "praise" : rating <= 2 ? "complaint" : "neutral");
    } catch (error) {
      console.error("Failed to classify review intent:", error);
      return rating >= 4 ? "praise" : rating <= 2 ? "complaint" : "neutral";
    }
  }

  private getIntentGuidance(intent: ReviewIntent): string {
    const guidance: Record<ReviewIntent, string> = {
      complaint:
        "Apologize sincerely for their experience. Acknowledge the specific issue mentioned. Offer a concrete next step to resolve the problem (e.g., contact info, invitation to discuss offline). Keep tone constructive and avoid being defensive.",
      praise:
        "Express genuine gratitude for their kind words. Mention specific points they praised if applicable. Invite them to return or share their experience with others.",
      question:
        "Answer their question clearly and concisely. Provide helpful information. Offer to provide more details if needed (e.g., phone number or email for follow-up).",
      suggestion:
        "Thank them for their valuable feedback. Acknowledge their suggestion positively. Indicate that you will consider their input for future improvements.",
      mixed:
        "Thank them for both their positive feedback and constructive criticism. Address the concerns mentioned while acknowledging what they enjoyed. Offer to resolve any issues.",
      neutral:
        "Thank them for taking the time to leave a review. Invite them to share more details or visit again.",
    };
    return guidance[intent];
  }

  async generateReviewResponse(
    request: ReviewResponseRequest,
    forceRefresh = false
  ): Promise<ReviewResponseResult> {
    if (request.reviewId && !forceRefresh) {
      const cached = await this.getCachedReviewResponse(request.reviewId);
      if (cached) {
        return cached;
      }
    }

    const intent = await this.classifyReviewIntent(
      request.comment,
      request.rating
    );
    const intentGuidance = this.getIntentGuidance(intent);

    const sentiment =
      request.rating >= 4
        ? "positive"
        : request.rating >= 3
          ? "neutral"
          : "negative";

    const systemPrompt = `You are a professional customer service representative responding to Google My Business reviews. Write personalized, professional, and warm responses that:
- Address the customer by name
- Address specific points they mentioned in their review
- Keep responses between 50-150 words
- Maintain brand voice appropriate for the business type
- Never be defensive or argumentative

IMPORTANT - This review has been classified as a "${intent}" review. Follow this specific guidance:
${intentGuidance}

Return ONLY the response text, no quotes or formatting.`;

    const userPrompt = `Write a response to this ${sentiment} review (intent: ${intent}) for "${request.businessName}"${request.businessType ? ` (${request.businessType})` : ""}:

Reviewer: ${request.reviewerName}
Rating: ${request.rating}/5 stars
Review: ${request.comment || "(No written review)"}

Generate a professional response following the ${intent} guidance.`;

    try {
      const llmResponse = await this.llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);

      const content =
        typeof llmResponse.content === "string"
          ? llmResponse.content
          : JSON.stringify(llmResponse.content);

      const responseText = content.trim().replace(/^["']|["']$/g, "");

      const result: ReviewResponseResult = {
        response: responseText,
        intent,
        source: "live",
      };

      if (request.reviewId) {
        await this.cacheReviewResponse(request.reviewId, responseText, intent);

        const gmbReview = await prisma.gMBReview.findUnique({
          where: { reviewId: request.reviewId },
          select: { id: true },
        });

        if (gmbReview) {
          const cachedRecord = await prisma.gMBAIReviewResponse.findUnique({
            where: { reviewId: gmbReview.id },
          });

          if (cachedRecord) {
            result.cachedAt = cachedRecord.generatedAt.toISOString();
            result.expiresAt = cachedRecord.expiresAt.toISOString();
          }
        }
      }

      return result;
    } catch (error) {
      console.error("Failed to generate review response:", error);
      throw new Error("Failed to generate AI review response");
    }
  }

  private async getCachedReviewResponse(
    googleReviewId: string
  ): Promise<ReviewResponseResult | null> {
    const gmbReview = await prisma.gMBReview.findUnique({
      where: { reviewId: googleReviewId },
      select: { id: true },
    });

    if (!gmbReview) {
      return null;
    }

    const cached = await prisma.gMBAIReviewResponse.findUnique({
      where: { reviewId: gmbReview.id },
    });

    if (!cached) {
      return null;
    }

    if (new Date() > cached.expiresAt) {
      await prisma.gMBAIReviewResponse.delete({ where: { reviewId: gmbReview.id } });
      return null;
    }

    return {
      response: cached.response,
      intent: cached.intent as ReviewIntent | undefined,
      cachedAt: cached.generatedAt.toISOString(),
      expiresAt: cached.expiresAt.toISOString(),
      source: "cache",
    };
  }

  private async cacheReviewResponse(
    googleReviewId: string,
    response: string,
    intent?: ReviewIntent
  ): Promise<void> {
    const gmbReview = await prisma.gMBReview.findUnique({
      where: { reviewId: googleReviewId },
      select: { id: true },
    });

    if (!gmbReview) {
      console.warn(`Cannot cache AI response: GMBReview not found for reviewId ${googleReviewId}`);
      return;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + AI_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

    try {
      await prisma.gMBAIReviewResponse.upsert({
        where: { reviewId: gmbReview.id },
        create: {
          reviewId: gmbReview.id,
          response,
          intent,
          generatedAt: now,
          expiresAt,
        },
        update: {
          response,
          intent,
          generatedAt: now,
          expiresAt,
        },
      });
      console.log(`Cached AI response for GMBReview.id=${gmbReview.id} (googleReviewId=${googleReviewId})`);
    } catch (error) {
      console.error(`Failed to cache AI response for GMBReview.id=${gmbReview.id}:`, error);
      throw error;
    }
  }

  async invalidateReviewResponseCache(googleReviewId: string): Promise<void> {
    const gmbReview = await prisma.gMBReview.findUnique({
      where: { reviewId: googleReviewId },
      select: { id: true },
    });

    if (!gmbReview) {
      return;
    }

    await prisma.gMBAIReviewResponse.deleteMany({
      where: { reviewId: gmbReview.id },
    });
  }

  async generatePostSuggestionsFromBlogs(
    businessId: string,
    forceRefresh = false,
    generateImages = false
  ): Promise<PostSuggestionsResponse> {
    if (!forceRefresh) {
      const cached = await this.getCachedPostSuggestions(businessId);
      if (cached) {
        return cached;
      }
    }

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        businessName: true,
        businessType: true,
        businessWebsiteUrl: true,
        Blog: {
          where: { status: "PUBLISH" },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            title: true,
            excerpt: true,
            content: true,
            categories: true,
            tags: true,
          },
        },
        GoogleMyBusiness: {
          select: {
            accountId: true,
            isActive: true,
            locationId: true,
            gmbPosts: {
              orderBy: { createdAt: "desc" },
              take: 5,
              select: {
                summary: true,
                callToAction: true,
                postType: true,
              },
            },
          },
        },
      },
    });

    if (!business) {
      throw new Error("Business not found");
    }

    if (!business.GoogleMyBusiness || !business.GoogleMyBusiness.isActive) {
      throw new GMBPostSuggestionSetupError(
        "GMB_CONNECTION_REQUIRED",
        "Connect Google Business Profile before generating post suggestions."
      );
    }

    if (
      !business.GoogleMyBusiness.accountId ||
      !business.GoogleMyBusiness.locationId
    ) {
      throw new GMBPostSuggestionSetupError(
        "GMB_LOCATION_SELECTION_REQUIRED",
        "Finish selecting a Google Business Profile location before generating post suggestions."
      );
    }

    if (business.Blog.length === 0) {
      return {
        suggestions: [],
        source: "live",
      };
    }

    const previousPosts = business.GoogleMyBusiness.gmbPosts || [];
    const hasPreviousPosts = previousPosts.length > 0;

    const previousPostsContext = hasPreviousPosts
      ? `

IMPORTANT: Here are the user's previous GMB posts for style/tone reference. Match their writing style, tone, and formatting preferences:
${JSON.stringify(
  previousPosts.map((p) => ({
    content: p.summary,
    type: p.postType,
    cta: p.callToAction,
  })),
  null,
  2
)}

Analyze their style: Are they formal or casual? Do they use emojis? How long are their posts? Match this style in your suggestions.`
      : "";

    const systemPrompt = `You are a social media content strategist specializing in Google My Business posts. Your task is to create engaging GMB post suggestions based on existing blog content.

For each blog, generate 1-2 GMB post suggestions that:
- Summarize key points in a compelling, social-media-friendly format
- Are between 100-300 characters for optimal engagement
- Include a destination URL on the business website when there is an obvious landing page, otherwise use an empty string
- Use only supported internal post types:
  - UPDATE for general updates, announcements, and educational recaps
  - PRODUCT for product highlights or service spotlights
${hasPreviousPosts ? "- MATCH the tone and style of the user's previous posts provided below" : ""}

Return a JSON array of suggestions. Each suggestion must have:
- id: unique string identifier (use format "post-{blogId}-{number}")
- postType: "UPDATE" or "PRODUCT"
- title: short attention-grabbing title (max 50 chars)
- summary: post content (100-300 chars)
- callToAction: absolute destination URL on the business website, or empty string if no destination URL is obvious
- sourceBlogId: the blog ID this was derived from
- sourceBlogTitle: the blog title

Return ONLY valid JSON array, no other text.`;

    const blogSummaries = business.Blog.map((blog) => ({
      id: blog.id,
      title: blog.title,
      excerpt: blog.excerpt,
      categories: blog.categories,
      tags: blog.tags,
    }));

    const userPrompt = `Generate GMB post suggestions based on these published blogs for "${business.businessName}" (${business.businessType}).

Business website URL: ${business.businessWebsiteUrl || "Not available"}

${JSON.stringify(blogSummaries, null, 2)}
${previousPostsContext}

Create 1-2 engaging post suggestions per blog that would work well on Google My Business.`;

    try {
      const response = await this.llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);

      const content =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);

      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return { suggestions: [], source: "live" };
      }

      let suggestions: PostSuggestion[] = (JSON.parse(
        jsonMatch[0],
      ) as PostSuggestion[]).map((suggestion) => ({
        ...suggestion,
        postType: this.normalizeSuggestedPostType(suggestion.postType),
      }));

      if (generateImages && suggestions.length > 0) {
        suggestions = await this.generateImagesForSuggestions(
          suggestions,
          business.businessName,
          business.businessType
        );
      }

      await this.cachePostSuggestions(businessId, suggestions);

      const cachedRecord = await prisma.gMBPostSuggestion.findFirst({
        where: { businessId, status: "PENDING" },
        orderBy: { generatedAt: "desc" },
      });

      return {
        suggestions,
        cachedAt: cachedRecord?.generatedAt.toISOString(),
        expiresAt: cachedRecord?.expiresAt.toISOString(),
        source: "live",
      };
    } catch (error) {
      console.error("Failed to generate post suggestions:", error);
      return { suggestions: [], source: "live" };
    }
  }

  private async generateImagesForSuggestions(
    suggestions: PostSuggestion[],
    businessName: string,
    businessType?: string | null
  ): Promise<PostSuggestion[]> {
    const limitedSuggestions = suggestions.slice(0, 3);
    
    const results = await Promise.allSettled(
      limitedSuggestions.map(async (suggestion) => {
        const imageResult = await imageGenerationService.generateGMBPostImage(
          businessName,
          suggestion.title,
          suggestion.postType,
          businessType || undefined,
          suggestion.summary || undefined
        );
        
        return {
          ...suggestion,
          mediaUrl: imageResult.success ? imageResult.imageUrl : undefined,
        };
      })
    );

    const processedSuggestions = results.map((result, index) => {
      if (result.status === "fulfilled") {
        return result.value;
      }
      return limitedSuggestions[index]!;
    });

    const remainingSuggestions = suggestions.slice(3);
    return [...processedSuggestions, ...remainingSuggestions];
  }

  private async getCachedPostSuggestions(
    businessId: string
  ): Promise<PostSuggestionsResponse | null> {
    const cached = await prisma.gMBPostSuggestion.findMany({
      where: {
        businessId,
        status: "PENDING",
        expiresAt: { gt: new Date() },
      },
      include: {
        blog: { select: { title: true } },
      },
      orderBy: { generatedAt: "desc" },
    });

    if (cached.length === 0) {
      return null;
    }

    const suggestions: PostSuggestion[] = cached.map((s) => {
      const mediaUrlsArray = Array.isArray(s.mediaUrls) ? s.mediaUrls : [];
      const firstMediaUrl = mediaUrlsArray.length > 0 ? String(mediaUrlsArray[0]) : undefined;
      
        return {
          id: s.id,
          postType: this.normalizeSuggestedPostType(s.postType),
          title: s.title,
          summary: s.summary,
        callToAction: s.callToAction || "",
        sourceBlogId: s.blogId,
        sourceBlogTitle: s.blog?.title || null,
        sourceKeyword: null,
        mediaUrl: firstMediaUrl,
      };
    });
    const firstCachedSuggestion = cached[0];
    if (!firstCachedSuggestion) {
      return null;
    }

    return {
      suggestions,
      cachedAt: firstCachedSuggestion.generatedAt.toISOString(),
      expiresAt: firstCachedSuggestion.expiresAt.toISOString(),
      source: "cache",
    };
  }

  private async cachePostSuggestions(
    businessId: string,
    suggestions: PostSuggestion[]
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + AI_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

    await prisma.gMBPostSuggestion.deleteMany({
      where: { businessId, status: "PENDING" },
    });

    for (const suggestion of suggestions) {
      const mediaUrls = suggestion.mediaUrl ? [suggestion.mediaUrl] : [];
      
      await prisma.gMBPostSuggestion.create({
        data: {
          businessId,
          blogId: suggestion.sourceBlogId || undefined,
          keywordId: undefined,
          postType: suggestion.postType,
          title: suggestion.title,
          summary: suggestion.summary,
          callToAction: suggestion.callToAction,
          mediaUrls,
          status: "PENDING",
          generatedAt: now,
          expiresAt,
        },
      });
    }
  }

  async schedulePostSuggestion(
    suggestionId: string,
    scheduledAt: Date
  ): Promise<{ success: boolean; message: string }> {
    const suggestion = await prisma.gMBPostSuggestion.findUnique({
      where: { id: suggestionId },
    });

    if (!suggestion) {
      return { success: false, message: "Suggestion not found" };
    }

    if (suggestion.status !== "PENDING") {
      return { success: false, message: "Suggestion is not in pending status" };
    }

    await prisma.gMBPostSuggestion.update({
      where: { id: suggestionId },
      data: {
        status: "SCHEDULED",
        scheduledAt,
      },
    });

    return { success: true, message: "Post scheduled successfully" };
  }

  async dismissPostSuggestion(
    suggestionId: string
  ): Promise<{ success: boolean; message: string }> {
    const suggestion = await prisma.gMBPostSuggestion.findUnique({
      where: { id: suggestionId },
    });

    if (!suggestion) {
      return { success: false, message: "Suggestion not found" };
    }

    await prisma.gMBPostSuggestion.update({
      where: { id: suggestionId },
      data: { status: "DISMISSED" },
    });

    return { success: true, message: "Suggestion dismissed" };
  }

  async generateReviewAnalysis(
    businessId: string,
    forceRefresh = false
  ): Promise<ReviewAnalysisResponse> {
    if (!forceRefresh) {
      const cached = await this.getCachedReviewAnalysis(businessId);
      if (cached) {
        return cached;
      }
    }

    const gmb = await prisma.googleMyBusiness.findUnique({
      where: { businessId },
      include: {
        gmbReviews: {
          where: {
            reviewDate: { gte: getGmbReviewWindowStart() },
          },
          orderBy: { reviewDate: "desc" },
        },
        business: {
          select: { businessName: true, businessType: true },
        },
      },
    });

    if (!gmb) {
      throw new Error("Google My Business connection not found");
    }

    const reviews = gmb.gmbReviews;

    if (reviews.length === 0) {
      const emptyResult: ReviewAnalysisResponse = {
        sentimentSummary: {
          positive: 0,
          neutral: 0,
          negative: 0,
          positivePercent: 0,
          neutralPercent: 0,
          negativePercent: 0,
        },
        commonThemes: [],
        businessInsights: [],
        totalReviewsAnalyzed: 0,
        averageRating: 0,
        source: "live",
      };
      return emptyResult;
    }

    const avgRating = this.calculateAverageRating(reviews);
    const sentimentBreakdown = this.calculateSentimentBreakdown(reviews);

    const systemPrompt = `You are a business intelligence analyst specializing in customer feedback analysis. Analyze the provided reviews and generate actionable insights.

Return a JSON object with:
1. "commonThemes": Array of recurring topics/themes found in reviews. Each theme has:
   - theme: topic name (e.g., "Customer Service", "Product Quality", "Wait Times")
   - count: how many reviews mention this theme
   - sentiment: "positive", "neutral", "negative", or "mixed"
   - examples: 1-2 brief quote snippets from reviews

2. "businessInsights": Array of actionable recommendations. Each insight has:
   - category: area of improvement (e.g., "Service", "Operations", "Product", "Staff")
   - insight: clear observation (max 100 chars)
   - priority: "high", "medium", or "low"
   - actionItems: array of 1-3 specific actions to take

Focus on patterns across multiple reviews. Identify both strengths to maintain and weaknesses to address.

Return ONLY valid JSON object, no other text.`;

    const reviewSummaries = reviews.slice(0, 50).map((r) => ({
      rating: r.rating,
      comment: r.comment || "(No comment)",
      date: r.reviewDate.toISOString().split("T")[0],
    }));

    const userPrompt = `Analyze these ${reviews.length} reviews for "${gmb.business.businessName}" (${gmb.business.businessType}):

Average Rating: ${avgRating.toFixed(1)}/5
Sentiment: ${sentimentBreakdown.positivePercent.toFixed(0)}% positive, ${sentimentBreakdown.neutralPercent.toFixed(0)}% neutral, ${sentimentBreakdown.negativePercent.toFixed(0)}% negative

Recent Reviews:
${JSON.stringify(reviewSummaries, null, 2)}

Identify common themes and generate business insights.`;

    try {
      const response = await this.llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);

      const content =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return this.getFallbackReviewAnalysis(reviews, avgRating, sentimentBreakdown);
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        commonThemes: CommonTheme[];
        businessInsights: BusinessInsight[];
      };

      const result: ReviewAnalysisResponse = {
        sentimentSummary: sentimentBreakdown,
        commonThemes: parsed.commonThemes || [],
        businessInsights: parsed.businessInsights || [],
        totalReviewsAnalyzed: reviews.length,
        averageRating: avgRating,
        source: "live",
      };

      await this.cacheReviewAnalysis(businessId, result);

      const cachedRecord = await prisma.gMBReviewAnalysis.findUnique({
        where: { businessId },
      });

      if (cachedRecord) {
        result.cachedAt = cachedRecord.generatedAt.toISOString();
        result.expiresAt = cachedRecord.expiresAt.toISOString();
      }

      return result;
    } catch (error) {
      console.error("Failed to generate review analysis:", error);
      return this.getFallbackReviewAnalysis(reviews, avgRating, sentimentBreakdown);
    }
  }

  private async getCachedReviewAnalysis(
    businessId: string
  ): Promise<ReviewAnalysisResponse | null> {
    const cached = await prisma.gMBReviewAnalysis.findUnique({
      where: { businessId },
    });

    if (!cached) {
      return null;
    }

    if (new Date() > cached.expiresAt) {
      await prisma.gMBReviewAnalysis.delete({ where: { businessId } });
      return null;
    }

    return {
      sentimentSummary: cached.sentimentSummary as unknown as SentimentBreakdown,
      commonThemes: cached.commonThemes as unknown as CommonTheme[],
      businessInsights: cached.businessInsights as unknown as BusinessInsight[],
      totalReviewsAnalyzed: cached.totalReviewsAnalyzed,
      averageRating: cached.averageRating,
      cachedAt: cached.generatedAt.toISOString(),
      expiresAt: cached.expiresAt.toISOString(),
      source: "cache",
    };
  }

  private async cacheReviewAnalysis(
    businessId: string,
    data: ReviewAnalysisResponse
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + AI_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

    await prisma.gMBReviewAnalysis.upsert({
      where: { businessId },
      create: {
        businessId,
        sentimentSummary:
          data.sentimentSummary as unknown as Prisma.InputJsonValue,
        commonThemes: data.commonThemes as unknown as Prisma.InputJsonValue,
        businessInsights:
          data.businessInsights as unknown as Prisma.InputJsonValue,
        totalReviewsAnalyzed: data.totalReviewsAnalyzed,
        averageRating: data.averageRating,
        generatedAt: now,
        expiresAt,
      },
      update: {
        sentimentSummary:
          data.sentimentSummary as unknown as Prisma.InputJsonValue,
        commonThemes: data.commonThemes as unknown as Prisma.InputJsonValue,
        businessInsights:
          data.businessInsights as unknown as Prisma.InputJsonValue,
        totalReviewsAnalyzed: data.totalReviewsAnalyzed,
        averageRating: data.averageRating,
        generatedAt: now,
        expiresAt,
      },
    });
  }

  async invalidateReviewAnalysisCache(businessId: string): Promise<void> {
    await prisma.gMBReviewAnalysis.deleteMany({
      where: { businessId },
    });
  }

  private calculateSentimentBreakdown(
    reviews: Array<{ rating: number }>
  ): SentimentBreakdown {
    const total = reviews.length;
    if (total === 0) {
      return {
        positive: 0,
        neutral: 0,
        negative: 0,
        positivePercent: 0,
        neutralPercent: 0,
        negativePercent: 0,
      };
    }

    const positive = reviews.filter((r) => r.rating >= 4).length;
    const neutral = reviews.filter((r) => r.rating === 3).length;
    const negative = reviews.filter((r) => r.rating <= 2).length;

    return {
      positive,
      neutral,
      negative,
      positivePercent: (positive / total) * 100,
      neutralPercent: (neutral / total) * 100,
      negativePercent: (negative / total) * 100,
    };
  }

  private getFallbackReviewAnalysis(
    reviews: Array<{ rating: number }>,
    avgRating: number,
    sentimentBreakdown: SentimentBreakdown
  ): ReviewAnalysisResponse {
    const insights: BusinessInsight[] = [];

    if (sentimentBreakdown.negativePercent > 20) {
      insights.push({
        category: "Customer Satisfaction",
        insight: `${sentimentBreakdown.negativePercent.toFixed(0)}% negative reviews indicate areas needing improvement`,
        priority: "high",
        actionItems: [
          "Review negative feedback patterns",
          "Implement corrective measures",
          "Follow up with dissatisfied customers",
        ],
      });
    }

    if (avgRating >= 4) {
      insights.push({
        category: "Strengths",
        insight: `Strong ${avgRating.toFixed(1)}/5 rating indicates good customer satisfaction`,
        priority: "medium",
        actionItems: [
          "Continue current practices",
          "Encourage satisfied customers to leave reviews",
        ],
      });
    }

    return {
      sentimentSummary: sentimentBreakdown,
      commonThemes: [],
      businessInsights: insights,
      totalReviewsAnalyzed: reviews.length,
      averageRating: avgRating,
      source: "live",
    };
  }

  private calculateAverageRating(
    reviews: Array<{ rating: number }>
  ): number {
    if (reviews.length === 0) return 0;
    const sum = reviews.reduce((acc: number, r: { rating: number }) => acc + r.rating, 0);
    return sum / reviews.length;
  }

  private calculateProfileCompleteness(data: GMBProfileData): number {
    let score = 0;
    const fields: Array<{
      value: unknown;
      weight: number;
    }> = [
      { value: data.businessName, weight: 20 },
      { value: data.businessAddress, weight: 20 },
      { value: data.businessPhone, weight: 15 },
      { value: data.businessWebsite, weight: 15 },
      { value: data.reviewCount > 0, weight: 10 },
      { value: data.recentPostCount > 0, weight: 10 },
      { value: data.pendingReviewCount === 0 && data.reviewCount > 0, weight: 10 },
    ];

    for (const field of fields) {
      if (field.value) {
        score += field.weight;
      }
    }

    return Math.min(100, score);
  }

  /**
   * Generate an SEO-optimized Google Business Profile proposal — description,
   * categories, and services — tailored to the actual business vertical.
   *
   * Determinism layers (in order of effect):
   *   1. SHA-256 input hash → DB cache hit returns the prior proposal verbatim.
   *      Identical inputs always produce identical output across deploys.
   *   2. GPT-5 mini when we do hit the LLM; strict prompts and validation keep
   *      repeated outputs stable.
   *   3. Zod-validated JSON output. A schema failure triggers one stricter
   *      retry; a second failure falls back to a deterministic generic shape.
   *   4. The fallback path is fully deterministic (no LLM) so the page never
   *      breaks even if the model provider is down.
   */
  async generateProfileProposal(input: {
    businessId: string;
    businessName: string | null;
    businessType: string | null;
    description: string | null;
    targetAudience: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    websiteUrl: string | null;
    contextServices: string[];
    topDiscoveryKeywords?: string[];
  }): Promise<{
    description: string;
    categories: string[];
    services: ProfileServiceProposal[];
    source: "cache" | "live" | "fallback";
  }> {
    const inputHash = this.hashProposalInput(input);

    const cached = await prisma.gMBProfileProposalCache
      .findUnique({ where: { businessId: input.businessId } })
      .catch(() => null);

    if (
      cached &&
      cached.inputHash === inputHash &&
      cached.expiresAt > new Date()
    ) {
      const value = this.normalizeProfileProposal(cached.proposalJson);
      if (value) {
        return { ...value, source: "cache" };
      }
    }

    const liveResult = await this.runProfileProposalLLM(input);

    if (liveResult.kind === "valid") {
      await this.persistProfileProposal(input.businessId, inputHash, liveResult.value);
      return { ...liveResult.value, source: "live" };
    }

    // Validation failure or LLM error: fall back to a deterministic shape.
    // The fallback also gets persisted so we don't burn another LLM call on
    // the next read; it's invalidated when input fields change (hash drift)
    // or by an explicit cache bust.
    const fallback = this.getFallbackProfileProposal(input);
    const fallbackValue = {
      description: fallback.description,
      categories: fallback.categories,
      services: fallback.services,
    };
    await this.persistProfileProposal(input.businessId, inputHash, fallbackValue);
    return { ...fallbackValue, source: "fallback" };
  }

  /**
   * Run the LLM up to twice — once with the standard prompt, once with a
   * stricter "your previous output was invalid" follow-up — and return the
   * first response that survives Zod validation. Any thrown error or second
   * validation failure returns `kind: "invalid"` so the caller can fall back.
   */
  private async runProfileProposalLLM(input: {
    businessName: string | null;
    businessType: string | null;
    description: string | null;
    targetAudience: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    websiteUrl: string | null;
    contextServices: string[];
    topDiscoveryKeywords?: string[];
  }): Promise<
    | { kind: "valid"; value: ValidatedProfileProposal }
    | { kind: "invalid" }
  > {
    const location = [input.city, input.state, input.country]
      .filter(Boolean)
      .join(", ");

    // Pre-filter generic/e-commerce labels before they reach the LLM. The
    // system prompt also instructs the LLM to drop them, but filtering here
    // prevents the model from being primed by polluted input in the first
    // place.
    const filteredContextServices = filterOutGenericServices(
      input.contextServices,
    );

    const systemPrompt = this.buildProposalSystemPrompt();
    const topKeywords = (input.topDiscoveryKeywords ?? [])
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 5);
    const userPrompt = `Generate a Google Business Profile proposal for this business:

Business name: ${input.businessName || "(not set)"}
Business type / vertical: ${input.businessType || "(not set)"}
Existing description: ${input.description || "(not set)"}
Target audience: ${input.targetAudience || "(not set)"}
Location: ${location || "(not set)"}
Website: ${input.websiteUrl || "(not set)"}
Raw service hints scraped from the website (LOW CONFIDENCE — many are checkout, footer, or navigation labels rather than real services; ignore anything that isn't a specific customer offering and infer better services from the business type/name/description when needed): ${
      filteredContextServices.length > 0
        ? filteredContextServices.join(", ")
        : "(none — infer services from business type and description)"
    }
Top searched keywords from this business's Google Business Profile insights (HIGH CONFIDENCE — these are real queries customers used to find this business; weave 2-3 of them into the description NATURALLY as phrases, never as a list; do NOT include any keyword that isn't a true fit for what the business does): ${
      topKeywords.length > 0 ? topKeywords.join(", ") : "(none available)"
    }

Return the JSON proposal.`;

    const firstAttempt = await this.invokeProposalAndValidate(
      systemPrompt,
      userPrompt,
    );
    if (firstAttempt.kind === "valid") return firstAttempt;

    // One retry with explicit feedback about what failed. Same temperature,
    // so determinism is preserved on the retry too.
    const retryPrompt = `Your previous response was invalid: ${firstAttempt.reason}.

Re-emit the proposal as a single JSON object that strictly satisfies the schema described in the system prompt. No markdown fences, no commentary.`;

    const secondAttempt = await this.invokeProposalAndValidate(
      systemPrompt,
      `${userPrompt}\n\n${retryPrompt}`,
    );
    if (secondAttempt.kind === "valid") return secondAttempt;

    return { kind: "invalid" };
  }

  private buildProposalSystemPrompt(): string {
    return `You are a Google Business Profile (GBP) optimization expert. You write SEO-tuned profile content that reflects the real business, never generic boilerplate. You understand Google's category taxonomy and pick the most accurate categories for the vertical.

Return ONLY a single JSON object that EXACTLY matches this schema. No markdown, no commentary, no code fences.

	{
	  "description": string (40-700 chars, SEO-optimized — see description rules below),
	  "categories": string[] (1-5 entries; primary first; real Google GBP category names like "Caterer", "Plumber", "Hair salon", "Dentist", "Italian restaurant"),
	  "services": [
	    {
	      "displayName": string (specific service offering, 1-140 chars),
	      "description": string (customer-facing service description, 30-250 chars)
	    }
	  ] (3-12 entries)
	}

	Rules:
	- Categories must be real Google Business Profile categories — pick the closest match for the vertical, do not invent.
	- Services must be SPECIFIC OFFERINGS the business actually performs. A real service answers "what specifically does the customer get?" — never a checkout method, navigation label, or marketing CTA.
	- THE GENERICNESS TEST: if a label could appear on a plumber's, a salon's, AND a retailer's website, it is too generic — drop it. A real service is unique to what the business does.
	- BANNED categories of labels (drop on sight, even if they appear in the input hints):
	  • Fulfillment/checkout: "Order Delivery", "Online Ordering", "Pickup", "Curbside Pickup", "Takeout", "Takeaway", "Delivery", "Shipping", "Checkout", "Add to Cart", "Buy Now", "Same-Day Delivery", "Free Shipping".
	  • Returns/policy: "Returns", "Refunds", "Exchanges", "Warranty", "Guarantee", "Financing", "Payment Plans", "Insurance Accepted".
	  • Commerce wrappers: "Gift Cards", "Gift Certificates", "Subscriptions", "Memberships", "Loyalty Program", "Rewards".
	  • CTAs: "Get a Quote", "Free Estimate", "Free Consultation", "Book Now", "Schedule Appointment", "Call Now", "Contact Us", "Request Quote", "Get Started", "Learn More", "Sign Up", "Subscribe", "Newsletter".
	  • Website navigation: "Home", "About", "About Us", "Our Story", "Services", "Our Services", "Products", "Shop", "Store", "Gallery", "Portfolio", "Testimonials", "Reviews", "Blog", "News", "FAQ", "Help", "Support", "Careers", "Team", "Locations", "Hours", "Directions", "Privacy Policy", "Terms".
	  • Account/auth: "Login", "Sign In", "My Account", "Register", "Dashboard".
	  • Unqualified single words: "Service", "Repair", "Installation", "Maintenance", "Inspection", "Cleaning", "Consultation", "Treatment", "Training", "Classes", "Lessons", "Sales", "Pricing", "Plans", "Packages". (These become valid only with a qualifier: "Brake repair", "Drain cleaning", "Piano lessons".)
	  • Vague marketing: "Premium Service", "Quality Service", "Professional Service", "Expert Service", "Reliable Service", "Affordable Service", "Custom Solutions", "Full Service", "One-Stop Shop".
	  • Availability lines: "Emergency Service", "24/7 Service", "Same-Day Service", "Walk-Ins Welcome", "By Appointment Only".
	- Good vs bad examples across many verticals (use the same pattern for any vertical you encounter):
	  • Plumber: GOOD "Drain cleaning", "Water heater repair", "Tankless water heater installation", "Sewer line replacement", "Sump pump installation". BAD "Service", "Repair", "Emergency Service".
	  • Dentist: GOOD "Root canal therapy", "Invisalign clear aligners", "Dental implants", "Teeth whitening", "Pediatric dental care". BAD "Consultation", "Appointments", "Insurance Accepted".
	  • Hair salon: GOOD "Balayage colour", "Bridal hair styling", "Keratin smoothing treatment", "Men's haircut and beard trim", "Hair extensions". BAD "Online Booking", "Gift Cards", "Treatments".
	  • Caterer: GOOD "Wedding catering", "Office lunch boxes", "Halal platters", "Drop-off catering", "On-site chef service", "Corporate event catering". BAD "Order Delivery", "Pickup", "Online Ordering".
	  • Restaurant: GOOD "Dine-in service", "Private dining room", "Seasonal tasting menu", "Chef's table experience", "Wine pairing dinners". BAD "Takeout", "Delivery", "Reservations".
	  • Auto repair: GOOD "Brake pad replacement", "Wheel alignment", "Engine diagnostics", "Oil change service", "Transmission repair". BAD "Repairs", "Service", "Free Estimate".
	  • Lawyer / law firm: GOOD "Estate planning will drafting", "Personal injury representation", "Real estate closings", "Business contract review", "Divorce mediation". BAD "Consultation", "Free Consultation", "Legal Services".
	  • Retail boutique: GOOD "Personal styling sessions", "Bridal wardrobe consulting", "In-store alterations", "Curated wardrobe boxes". BAD "Shop", "Gift Cards", "Returns".
	  • Fitness studio: GOOD "Reformer Pilates classes", "Personal training sessions", "Prenatal yoga classes", "Small-group HIIT", "Strength program design". BAD "Memberships", "Classes", "Training".
	  • Contractor / home services: GOOD "Kitchen remodeling", "Bathroom renovation", "Roof replacement", "Hardwood floor refinishing", "Custom deck building". BAD "Free Estimate", "Quality Work", "Construction Services".
	  • SaaS / B2B: GOOD "Custom integration development", "Quarterly business reviews", "Onboarding implementation", "API consulting". BAD "Pricing", "Free Trial", "Get Started".
	- Service descriptions must explain what the customer gets, using the business context and location where helpful. Do not repeat the service name as the whole description.
	- If the business is multi-vertical, pick categories from the dominant one.
	- Never use placeholder text like "Your business" — use the actual name.
	- If the raw service hints in the user message are dominated by banned labels, IGNORE THEM ENTIRELY and infer services from the business name, type, description, and location. Producing fewer, specific services is better than reusing generic hints.

	Description SEO rules (this is the most weighted ranking surface inside the proposal — get it right):
	- HARD LIMIT: 40-700 characters total. Going over wastes the budget and triggers a re-trim. Aim for 500-680 chars to leave headroom.
	- First 150 characters carry the most weight (some Google surfaces truncate there). Pack into the first sentence: business name + primary service noun + city or service area. Example pattern: "<Business name> is a <city>-based <primary service category> serving <audience/area>".
	- Naturally weave 2-3 of the "Top searched keywords" from the user prompt into the body where they fit the real business. NEVER list them, comma-separate them, or repeat the same keyword more than twice — that's keyword stuffing and Google penalizes it.
	- Mention 2-3 specific service offerings inside running sentences (not bullet form). Pull them from the services you're also generating below so the description and services array reinforce the same offerings.
	- Mention the service area broadly once (city plus "and surrounding GTA / metro / region" type phrasing when applicable). One mention only.
	- Include one differentiator if it's discoverable from the input (years in operation, halal/kosher/vegan options, awards, specialty technique, etc.). Skip it if no signal exists — never fabricate.
	- Tone: conversational and customer-facing. No buzzwords ("cutting-edge", "world-class", "best-in-class"), no exclamation marks, no all-caps, no emojis.
	- End on a clear sentence describing how customers engage (dine-in, online order, book, contact) without using a banned CTA phrase from the services rules.
	- Self-check before returning: (1) under 700 chars, (2) primary keyword + city in first 150 chars, (3) at least 2 searched keywords used naturally, (4) at least 2 specific services named in prose, (5) no keyword stuffing — every keyword reads like normal English.`;
  }

  private async invokeProposalAndValidate(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<
    | { kind: "valid"; value: ValidatedProfileProposal }
    | { kind: "invalid"; reason: string }
  > {
    try {
      const response = await this.proposalLlm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);

      const content =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { kind: "invalid", reason: "no JSON object found in response" };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (error) {
        return {
          kind: "invalid",
          reason: `JSON parse error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }

      const result = this.normalizeProfileProposal(parsed);
      if (!result) {
        const schemaResult = profileProposalLLMSchema.safeParse(parsed);
        return {
          kind: "invalid",
          reason: schemaResult.success
            ? "services must include displayName and useful description"
            : schemaResult.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; "),
        };
      }

      return {
        kind: "valid",
        value: result,
      };
    } catch (error) {
      console.error("Profile proposal LLM error:", error);
      return {
        kind: "invalid",
        reason: error instanceof Error ? error.message : "LLM call failed",
      };
    }
  }

  /**
   * SHA-256 hash of the proposal input fields. Used as the cache key so the
   * cached proposal is returned only when the inputs match exactly. Order is
   * fixed and arrays are joined with `` (won't appear in real input)
   * to make the canonicalization unambiguous.
   */
  private hashProposalInput(input: {
    businessName: string | null;
    businessType: string | null;
    description: string | null;
    targetAudience: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    websiteUrl: string | null;
    contextServices: string[];
    topDiscoveryKeywords?: string[];
  }): string {
    const fields = [
      input.businessName ?? "",
      input.businessType ?? "",
      input.description ?? "",
      input.targetAudience ?? "",
      input.city ?? "",
      input.state ?? "",
      input.country ?? "",
      input.websiteUrl ?? "",
      input.contextServices.join("\u0001"),
    ];
    fields.push((input.topDiscoveryKeywords ?? []).join(","));
    return createHash("sha256").update(fields.join("\u0002")).digest("hex");
  }

  private normalizeProfileProposal(value: unknown): ValidatedProfileProposal | null {
    const result = profileProposalLLMSchema.safeParse(value);
    if (!result.success) {
      return null;
    }

    const services = this.normalizeProposalServices(result.data.services);
    if (services.length < 3) {
      return null;
    }

    return {
      description: this.fitProfileDescription(result.data.description),
      categories: result.data.categories.map((category) => category.trim()),
      services,
    };
  }

  private fitProfileDescription(value: string): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return "";

    // Cap to Google's safe limit. If the input is already under, no cap is
    // applied — but we STILL run the sentence-ending check below so a
    // truncated-mid-word LLM output (e.g. ~720 chars ending at "centr") gets
    // cleaned up. The previous implementation only ran the cleanup on
    // overflow, which let mid-word AI output slip through unchanged.
    const capped =
      normalized.length > GOOGLE_PROFILE_DESCRIPTION_SAFE_LIMIT
        ? normalized.slice(0, GOOGLE_PROFILE_DESCRIPTION_SAFE_LIMIT)
        : normalized;

    // Already ends with sentence-ending punctuation (optionally followed by a
    // closing quote/paren) — keep as-is.
    if (/[.!?]["')\]]?$/.test(capped)) {
      return capped;
    }

    const sentenceEnd = Math.max(
      capped.lastIndexOf("."),
      capped.lastIndexOf("!"),
      capped.lastIndexOf("?"),
    );

    if (sentenceEnd >= 180) {
      return capped.slice(0, sentenceEnd + 1).trim();
    }

    const wordEnd = capped.lastIndexOf(" ");
    const trimmed =
      wordEnd >= 180 ? capped.slice(0, wordEnd).trim() : capped.trim();

    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  }

  private isInternalGoogleServiceId(value: string | null | undefined): boolean {
    return /^job_type_id:[a-z0-9_:-]+$/i.test(
      (value ?? "").replace(/\s+/g, " ").trim(),
    );
  }

  private normalizeProposalServices(values: unknown[]): ProfileServiceProposal[] {
    const seen = new Set<string>();
    const services: ProfileServiceProposal[] = [];

    for (const value of values) {
      const service = this.normalizeProposalService(value);
      if (!service) continue;

      const key = service.displayName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      services.push(service);
    }

    return services.slice(0, 12);
  }

  private normalizeProposalService(value: unknown): ProfileServiceProposal | null {
    if (typeof value === "string") {
      const displayName = value.replace(/\s+/g, " ").trim().slice(0, 140);
      if (!displayName) return null;
      if (this.isInternalGoogleServiceId(displayName)) return null;
      if (isGenericService(displayName)) return null;
      return {
        displayName,
        description: this.buildGenericServiceDescription(displayName, null),
      };
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const displayNameSource =
      typeof record.displayName === "string"
        ? record.displayName
        : typeof record.name === "string"
          ? record.name
          : typeof record.label === "string"
            ? record.label
            : "";
    const displayName = displayNameSource.replace(/\s+/g, " ").trim().slice(0, 140);
    if (!displayName) return null;
    if (this.isInternalGoogleServiceId(displayName)) return null;
    if (isGenericService(displayName)) return null;

    const descriptionSource =
      typeof record.description === "string" ? record.description : "";
    const description =
      descriptionSource.replace(/\s+/g, " ").trim().slice(0, 250) ||
      this.buildGenericServiceDescription(displayName, null);

    return {
      displayName,
      description,
    };
  }

  private buildGenericServiceDescription(
    displayName: string,
    businessType: string | null,
  ): string {
    const type = businessType || "local service";
    return `${displayName} from a ${type} provider, described for customers comparing relevant Google Business Profile services.`.slice(
      0,
      250,
    );
  }

  private async persistProfileProposal(
    businessId: string,
    inputHash: string,
    value: ValidatedProfileProposal,
  ): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PROFILE_PROPOSAL_TTL_MS);

    try {
      await prisma.gMBProfileProposalCache.upsert({
        where: { businessId },
        create: {
          businessId,
          inputHash,
          proposalJson: value as unknown as Prisma.InputJsonValue,
          generatedAt: now,
          expiresAt,
        },
        update: {
          inputHash,
          proposalJson: value as unknown as Prisma.InputJsonValue,
          generatedAt: now,
          expiresAt,
        },
      });
    } catch (error) {
      // Cache failure should never break the page — log and continue.
      console.error("Failed to persist GMB profile proposal cache:", error);
    }
  }

  /**
   * Invalidate the persistent profile-proposal cache for a business.
   */
  async invalidateProfileProposalCache(businessId: string): Promise<void> {
    await prisma.gMBProfileProposalCache
      .deleteMany({ where: { businessId } })
      .catch(() => undefined);
  }

  /**
   * Generate a single GMB post for the weekly-cadence cron. Works for any
   * vertical — falls back to a deterministic shape if the LLM fails so the
   * cron never silently drops a business.
   *
   * The output is shaped as `GMBPostData` so the caller can hand it straight
   * to `GoogleMyBusinessService.createPost` (auto-publish path) or persist it
   * as a `GMBPostSuggestion` row for manual approval.
   */
  async generateCadencePost(input: {
    businessId: string;
    businessName: string | null;
    businessType: string | null;
    city: string | null;
    state: string | null;
    services: string[];
    websiteUrl: string | null;
  }): Promise<{
    postType: "UPDATE";
    summary: string;
    callToAction?: string;
    source: "live" | "fallback";
  }> {
    const cadenceSchema = z.object({
      summary: z
        .string()
        .min(40, "summary too short")
        .max(900, "summary exceeds Google's 1500-char body cap (we keep headroom)"),
    });

    const businessName = (input.businessName ?? "this business").trim();
    const businessType = (input.businessType ?? "").trim();
    const location = [input.city, input.state].filter(Boolean).join(", ");
    const topServices = input.services
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5);

    const systemPrompt = `You write GMB (Google Business Profile) Update posts for local businesses. The post should feel timely (something a customer might see this week), highlight one specific service or offering, and read naturally — never marketing copy. Return ONLY a single JSON object: {"summary": string}. No markdown, no commentary.

Rules:
- summary 80-280 characters (Google truncates around 80 chars in some surfaces, so the headline message belongs at the very start).
- Mention the business name once near the start.
- Name one specific service from the provided list. Do not list more than one.
- Mention the city when known. Single mention.
- Tone: warm, customer-facing, conversational. No exclamation marks. No emojis. No buzzwords.
- End with a clear next step the customer can take (visit, call, order, book, etc.) — but never use banned CTA phrases like "Get a Quote", "Free Consultation", "Book Now"; phrase it as natural language ("Stop by this week" / "Place a catering order for next week").
- Do not invent facts. If you don't know something, omit it.`;

    const userPrompt = `Business: ${businessName}
Type: ${businessType || "(not set)"}
Location: ${location || "(not set)"}
Services to draw from: ${topServices.length > 0 ? topServices.join(", ") : "(none — use the business type)"}
Website: ${input.websiteUrl || "(not set)"}

Write this week's GMB Update post.`;

    try {
      const response = await this.proposalLlm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(userPrompt),
      ]);
      const content =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("no JSON object in response");
      const parsed = cadenceSchema.parse(JSON.parse(jsonMatch[0]));
      return {
        postType: "UPDATE",
        summary: parsed.summary.trim(),
        callToAction: input.websiteUrl ?? undefined,
        source: "live",
      };
    } catch (error) {
      console.error("[cadence-post] LLM failed, using fallback:", error);
      const service = topServices[0] ?? businessType ?? "service";
      const where = location ? ` in ${location}` : "";
      const fallbackSummary =
        `${businessName}${where} — this week's focus is ${service}. ` +
        `Stop by or place an order this week to see what's fresh.`;
      return {
        postType: "UPDATE",
        summary: fallbackSummary.slice(0, 280),
        callToAction: input.websiteUrl ?? undefined,
        source: "fallback",
      };
    }
  }

  private getFallbackProfileProposal(input: {
    businessName: string | null;
    businessType: string | null;
    description: string | null;
    city: string | null;
    contextServices: string[];
  }): {
    description: string;
    categories: string[];
    services: ProfileServiceProposal[];
    source: "fallback";
  } {
    const name = input.businessName || "This business";
    const type = input.businessType || "local services";
    const cityClause = input.city ? ` in ${input.city}` : "";
    // Strip e-commerce/fulfillment labels so the deterministic fallback
    // doesn't re-emit "Order Delivery"-style pollution when the LLM call
    // fails. Keeps the fallback aligned with the LLM-path filtering.
    const cleanedContextServices = filterOutGenericServices(input.contextServices);
    const servicesClause =
      cleanedContextServices.length > 0
        ? ` Services include ${cleanedContextServices.slice(0, 4).join(", ")}.`
        : "";

    const description =
      input.description?.trim() ||
      `${name} provides ${type}${cityClause}.${servicesClause} Contact us to learn how we can help.`;

    return {
      description: this.fitProfileDescription(description),
      categories: input.businessType ? [input.businessType] : [],
      services: cleanedContextServices.slice(0, 8).map((service) => ({
        displayName: service,
        description: this.buildGenericServiceDescription(service, input.businessType),
      })),
      source: "fallback",
    };
  }

  private getFallbackSuggestions(
    data: GMBProfileData,
    profileCompleteness: number
  ): SuggestionsResponse {
    const suggestions: GMBSuggestion[] = [];

    if (!data.businessPhone) {
      suggestions.push({
        id: "add-phone",
        title: "Add Business Phone Number",
        description:
          "Adding a phone number increases customer calls by 25% and improves local search ranking.",
        priority: "high",
        category: "profile",
        impact: "Increases customer calls and local visibility",
      });
    }

    if (!data.businessWebsite) {
      suggestions.push({
        id: "add-website",
        title: "Add Website Link",
        description:
          "Link your website to drive traffic and improve credibility with potential customers.",
        priority: "high",
        category: "profile",
        impact: "Drives website traffic and builds trust",
      });
    }

    if (data.pendingReviewCount > 0) {
      suggestions.push({
        id: "respond-reviews",
        title: "Respond to Pending Reviews",
        description: `You have ${data.pendingReviewCount} unanswered review${data.pendingReviewCount > 1 ? "s" : ""}. Responding shows customers you value their feedback.`,
        priority: "high",
        category: "engagement",
        impact: "Improves customer trust and engagement",
      });
    }

    if (data.recentPostCount === 0) {
      suggestions.push({
        id: "create-post",
        title: "Create a Google Post",
        description:
          "Regular posts keep your profile active and can increase engagement by 30%.",
        priority: "medium",
        category: "content",
        impact: "Keeps profile active and visible",
      });
    }

    if (data.reviewCount < 5) {
      suggestions.push({
        id: "get-reviews",
        title: "Encourage More Reviews",
        description:
          "Businesses with 5+ reviews rank higher in local search. Ask satisfied customers for reviews.",
        priority: "medium",
        category: "engagement",
        impact: "Improves local search ranking",
      });
    }

    return {
      suggestions,
      profileCompleteness,
      source: "live",
    };
  }
}

export const gmbAIService = new GMBAIService();
