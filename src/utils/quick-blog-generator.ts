import { prisma } from "../config/db.config";
import { getLLMForBlogs, LLM_MODELS } from "../config/llm.config";
import {
  generateProductionBlogImages,
} from "../services/blog-pipeline-v2/image-pipeline";
import { ProductionPipelineUsageRecorder } from "../services/blog-pipeline-v2/usage-accounting";
import { KeywordTrackingService } from "../services/keyword-tracking.service";
import { recordLlmUsageFromLangChainMessage } from "../services/llm-usage.service";
import { sendQuickBlogEmail } from "../services/trial-email.service";

interface QuickBlogContent {
  title: string;
  metaDescription: string;
  content: string;
  slug: string;
  excerpt: string;
  focusKeyword: string;
  secondaryKeywords: string[];
  categories: string[];
  tags: string[];
}

export interface QuickBlogGenerationOptions {
  /** Skip the legacy trial notification email for background-only previews. */
  suppressEmail?: boolean;
  /** Stable unique key used to resume an onboarding preview without duplicating it. */
  onboardingPreviewKey?: string;
  /** Existing trial callers publish internally; onboarding previews stay draft-only. */
  status?: "DRAFT" | "PUBLISH";
}

export interface QuickBlogGenerationResult {
  blogId: string;
  planId: string | null;
  alreadyExisted: boolean;
}

function normalizeOnboardingPreviewKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const key = value.trim();
  if (key.length < 8 || key.length > 200) {
    throw new Error("onboardingPreviewKey must be between 8 and 200 characters");
  }
  return key;
}

function onboardingPreviewIdentityFromKey(
  value: string,
): { quickBusinessId: string; revision: number } | null {
  const match = /^onboarding-v2:([^:]+):r(\d+):blog$/.exec(value);
  if (!match?.[1]) return null;
  const revision = Number(match[2]);
  return Number.isSafeInteger(revision) && revision >= 0
    ? { quickBusinessId: match[1], revision }
    : null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
  );
}

const QUICK_BLOG_SYSTEM_PROMPT = `You are a senior SEO editor and content writer. Create a publication-ready, useful blog article for the reader described by the business context.

EDITORIAL REQUIREMENTS:
1. Write 1,400-1,600 words of reader-visible article copy, aiming near 1,500 words.
2. Answer the reader's likely question early, then develop the topic with practical detail, examples, considerations, and next steps.
3. Use a natural, professional, approachable voice. Vary sentence and paragraph length and avoid repetitive phrasing, filler, exaggerated claims, and keyword stuffing.
4. Mention the business name naturally 2-4 times. Do not turn every section into a sales pitch.
5. Use only the supplied business facts. Never invent credentials, awards, statistics, prices, guarantees, service areas, case studies, or years of experience.
6. Write in the requested language and locale. Use locally natural spelling and terminology.

HTML AND LINK RULES:
1. Return the article body as clean semantic HTML using p, h2, h3, ul, ol, li, and strong tags where appropriate.
2. Do not include an h1 in the article body because the title is stored separately.
3. Start with two or three introductory paragraphs before the first h2.
4. Use descriptive, topic-specific headings. Include 5-7 meaningful h2 sections, h3 subsections only where useful, and lists only when they genuinely improve readability.
5. Do not include Markdown, square-bracket instructions, template tokens, TODO text, citations, source notes, or editorial commentary.
6. Never output placeholders such as [LINK: ...], "insert link", "link here", or "click here". Do not fabricate URLs or output a tags. Write any call to action as normal prose.

SEO REQUIREMENTS:
1. Create a natural, specific title of approximately 50-65 characters that includes the main keyword without forcing it.
2. The title must be grammatical and human-sounding. Do not use semicolons, adjacent punctuation, malformed combinations such as ",:" or ";:", or a question mark unless the complete title is a genuine question.
3. Write a compelling meta description of approximately 150-160 characters that includes the main keyword naturally.
4. Write a concise 2-3 sentence excerpt for previews.
5. Choose one focused primary keyword and 3-5 closely related secondary keywords.
6. Use the primary keyword naturally in the title, introduction, at least one heading, and conclusion. Use variations elsewhere instead of repeating the exact phrase.
7. Make the article genuinely useful and scannable; optimization must never make the wording awkward.

ARTICLE SHAPE:
- Two or three opening paragraphs that establish the reader's situation and give a direct, useful answer.
- Topic-specific sections explaining the subject, its value, key considerations, and a realistic process or approach.
- Practical guidance using steps, a checklist, examples, or decision criteria when appropriate for the topic.
- A concise section explaining how the business can help, grounded only in the supplied facts.
- A brief conclusion with a natural, plain-text call to action.
- Do not reuse these instruction labels as headings; write headings tailored to the actual topic.

OUTPUT FORMAT (strictly valid JSON only, with no prose before or after it):
{
  "title": "Natural, specific title",
  "metaDescription": "Compelling meta description",
  "content": "<p>...</p><p>...</p><h2>...</h2><p>...</p>...",
  "slug": "url-friendly-slug-with-keyword",
  "excerpt": "Concise 2-3 sentence summary",
  "focusKeyword": "main keyword phrase",
  "secondaryKeywords": ["keyword1", "keyword2", "keyword3"],
  "categories": ["Category1", "Category2"],
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}`;

export function generateQuickBlogForTrial(
  userId: string,
  businessId: string,
  selectedService: string,
): Promise<void>;
export function generateQuickBlogForTrial(
  userId: string,
  businessId: string,
  selectedService: string,
  options: QuickBlogGenerationOptions & { onboardingPreviewKey: string },
): Promise<QuickBlogGenerationResult>;
export function generateQuickBlogForTrial(
  userId: string,
  businessId: string,
  selectedService: string,
  options: QuickBlogGenerationOptions,
): Promise<void | QuickBlogGenerationResult>;
export async function generateQuickBlogForTrial(
  userId: string,
  businessId: string,
  selectedService: string,
  options: QuickBlogGenerationOptions = {},
): Promise<void | QuickBlogGenerationResult> {
  const startTime = Date.now();
  const onboardingPreviewKey = normalizeOnboardingPreviewKey(
    options.onboardingPreviewKey,
  );

  try {
    console.log(
      `🚀 [FAST] Generating quick blog for trial user ${userId}, service: ${selectedService}`,
    );

    if (onboardingPreviewKey) {
      const existingBlog = await prisma.blog.findUnique({
        where: { onboardingPreviewKey },
        select: { id: true, userId: true, businessId: true },
      });
      if (existingBlog) {
        if (
          existingBlog.userId !== userId ||
          existingBlog.businessId !== businessId
        ) {
          throw new Error("Onboarding preview idempotency key ownership mismatch");
        }
        const existingPlan = await prisma.plan.findFirst({
          where: { blogId: existingBlog.id, userId, businessId },
          select: { id: true },
        });
        return {
          blogId: existingBlog.id,
          planId: existingPlan?.id ?? null,
          alreadyExisted: true,
        };
      }
    }

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        userId: true,
        businessName: true,
        businessType: true,
        businessDescription: true,
        businessWebsiteUrl: true,
        businessCity: true,
        businessState: true,
        defaultLocale: true,
        targetAudience: true,
        contentTone: true,
      },
    });

    if (!business) {
      throw new Error(`Business not found: ${businessId}`);
    }
    if (business.userId !== userId) {
      throw new Error("Business does not belong to quick blog user");
    }

    const fastLLM = getLLMForBlogs();

    const location = [business.businessCity, business.businessState]
      .filter(Boolean)
      .join(", ");

    let onboardingContext: {
      businessDescription: string | null;
      targetAudience: string | null;
      onboardingV2Status: string;
    } | null = null;
    if (onboardingPreviewKey) {
      const onboardingIdentity = onboardingPreviewIdentityFromKey(
        onboardingPreviewKey,
      );
      if (!onboardingIdentity) {
        throw new Error("Invalid onboarding preview blog idempotency key");
      }
      onboardingContext = await prisma.quickScrapeBusiness.findFirst({
        where: {
          id: onboardingIdentity.quickBusinessId,
          userId,
          onboardingV2BusinessId: businessId,
          onboardingV2GenerationRevision: onboardingIdentity.revision,
          onboardingV2CompletedAt: null,
        },
        select: {
          businessDescription: true,
          targetAudience: true,
          onboardingV2Status: true,
        },
      });
      if (
        !onboardingContext ||
        ["complete", "completed"].includes(
          onboardingContext.onboardingV2Status.trim().toLowerCase(),
        )
      ) {
        throw new Error(
          "Onboarding preview blog does not match an unfinished owned onboarding state",
        );
      }
    }

    let userPrompt = `Write an SEO-optimized blog post for:

BUSINESS: ${business.businessName || "Our Company"}
TYPE: ${business.businessType || "Service Provider"}
DESCRIPTION: ${business.businessDescription || "Professional services"}
LOCATION: ${location || "Local area"}
WEBSITE: ${business.businessWebsiteUrl || ""}
LANGUAGE/LOCALE: ${business.defaultLocale || "en"}

MAIN TOPIC/SERVICE: ${selectedService}

Create a comprehensive, approximately 1,500-word blog about ${selectedService} that:
1. Addresses the searcher's likely intent and most important questions
2. Explains the topic and its practical value without padding or repetition
3. Provides useful considerations, steps, examples, or decision guidance suited to this specific topic
4. Explains how ${business.businessName || "the business"} can help using only the supplied business facts
5. Ends with a natural plain-text call to action, with no placeholder or fabricated link

Choose a natural target keyword related to "${selectedService}" and the supplied location when location is relevant to search intent. Do not force the location into sentences where it sounds unnatural.`;
    if (onboardingContext) {
      userPrompt += `

ONBOARDING PREVIEW CONTEXT (frozen for this generation):
CONTEXT.DEV DESCRIPTION: ${onboardingContext.businessDescription || business.businessDescription || "Professional services"}
TARGET AUDIENCE: ${business.targetAudience || onboardingContext.targetAudience || "Prospective customers"}
CONTENT TONE: ${business.contentTone || "professional"}

Use this frozen context to choose examples, reader priorities, and tone. Do not infer facts beyond it.`;
    }

    console.log(
      `📝 [FAST] Calling ${LLM_MODELS.GPT56_LUNA} for quick blog generation...`,
    );

    const response = await fastLLM.invoke([
      { role: "system", content: QUICK_BLOG_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]);

    void recordLlmUsageFromLangChainMessage(response, {
      purpose: "quick_trial_blog",
      provider: "openai",
      userId,
      businessId,
      modelFallback: LLM_MODELS.GPT56_LUNA,
    });

    const content =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(
        `❌ [FAST] LLM did not return valid JSON. Raw response: ${content.slice(0, 500)}`,
      );
      throw new Error("LLM did not return valid JSON for quick blog");
    }

    let blogContent: QuickBlogContent;
    try {
      blogContent = JSON.parse(jsonMatch[0]) as QuickBlogContent;
    } catch {
      const sanitized = jsonMatch[0]
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]")
        .replace(/[\x00-\x1F\x7F]/g, " ");
      try {
        blogContent = JSON.parse(sanitized) as QuickBlogContent;
      } catch {
        console.error(
          `❌ [FAST] Failed to parse LLM JSON even after sanitization. Raw: ${jsonMatch[0].slice(0, 500)}`,
        );
        throw new Error("Failed to parse LLM blog response as JSON");
      }
    }

    if (!blogContent.title || !blogContent.content) {
      throw new Error("LLM blog response missing required title or content fields");
    }

    const slug =
      blogContent.slug ||
      blogContent.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);

    const keyword = blogContent.focusKeyword || `guide to ${selectedService}`;
    const keywordCandidates = Array.from(
      new Set(
        [keyword, selectedService]
          .map((candidate) => candidate?.trim())
          .filter((candidate): candidate is string => Boolean(candidate)),
      ),
    );
    const today = new Date();
    const publishDate = today.toISOString().split("T")[0] || "";
    const publishTime = "10:00";

    let plan = onboardingPreviewKey
      ? await prisma.plan.findFirst({
          where: {
            userId,
            businessId,
            deletedAt: null,
            selectionMetadata: {
              path: ["onboardingPreviewKey"],
              equals: onboardingPreviewKey,
            },
          },
          orderBy: { createdAt: "asc" },
        })
      : await prisma.plan.findFirst({
          where: {
            userId: userId,
            businessId: businessId,
            deletedAt: null,
            blogId: null,
            OR: keywordCandidates.map((candidate) => ({
              keyword: {
                equals: candidate,
                mode: "insensitive",
              },
            })),
          },
          orderBy: { createdAt: "asc" },
        });

    if (!plan) {
      plan = await prisma.plan.create({
        data: {
          userId: userId,
          businessId: businessId,
          keyword: keyword,
          keywordSearchVolume: "500",
          keywordDiffculty: "30",
          publishDate: publishDate,
          publishTime: publishTime,
          ...(onboardingPreviewKey
            ? {
                keywordSource: "onboarding_v2_preview",
                selectionMetadata: {
                  source: "onboarding_v2_preview",
                  onboardingPreviewKey,
                },
              }
            : {}),
        },
      });
    }

    const imageRecorder = new ProductionPipelineUsageRecorder({
      correlationId: onboardingPreviewKey
        ? `${onboardingPreviewKey}:blog-image`
        : `quick-trial:${plan.id}`,
      planId: plan.id,
      userId,
      businessId,
    });
    const images = await generateProductionBlogImages({
      planId: plan.id,
      title: blogContent.title,
      keyword,
      businessName: business.businessName || "Our Company",
      locale: business.defaultLocale || "en",
      content: blogContent.content,
      recorder: imageRecorder,
      featuredImageOnly: true,
    });
    const contentWithImages = blogContent.content;
    const featuredImage = images.find((image) => image.role === "featured");
    if (!featuredImage) {
      throw new Error("Quick trial blog image set is missing its featured image");
    }
    const imageCost = await imageRecorder.summary();

    const meta = await prisma.meta.create({
      data: {
        seo_title: blogContent.title,
        seo_description: blogContent.metaDescription,
        focus_keyword: blogContent.focusKeyword || keyword,
        keywords: blogContent.secondaryKeywords || [],
      },
    });

    const wordCount = Math.round(contentWithImages.split(/\s+/).length);
    const readingTime = Math.ceil(wordCount / 200);

    const customField = await prisma.customField.create({
      data: {
        reading_time: `${readingTime} min read`,
        rating: 0,
      },
    });

    const excerpt =
      blogContent.excerpt ||
      contentWithImages
        .replace(/<[^>]*>/g, "")
        .slice(0, 150)
        .trim() + "...";

    let blog;
    try {
      blog = await prisma.blog.create({
        data: {
          title: blogContent.title,
          content: contentWithImages,
          excerpt: excerpt,
          slug: slug,
          userId: userId,
          businessId: businessId,
          metaId: meta.id,
          customFieldId: customField.id,
          categories: blogContent.categories || ["General"],
          tags: blogContent.tags || [selectedService],
          featured_media: featuredImage.url,
          blogPublishDate: publishDate,
          blogPublishTime: publishTime,
          status: options.status ?? "PUBLISH",
          seoScore: 75,
          onboardingPreviewKey,
          analytics: {
            quickTrialSample: true,
            onboardingPreview: Boolean(onboardingPreviewKey),
            generationMode: onboardingPreviewKey
              ? "onboarding_v2_preview"
              : "quick_trial_blog",
            ...(onboardingPreviewKey ? { onboardingPreviewKey } : {}),
            images,
            imageCost,
          },
        },
      });
    } catch (error) {
      if (!onboardingPreviewKey || !isUniqueConstraintError(error)) throw error;
      await Promise.all([
        prisma.meta.deleteMany({ where: { id: meta.id } }),
        prisma.customField.deleteMany({ where: { id: customField.id } }),
      ]).catch((cleanupError) => {
        console.error(
          "[FAST] Failed to clean orphaned quick-blog metadata after idempotency race",
          cleanupError,
        );
      });
      const racedBlog = await prisma.blog.findUnique({
        where: { onboardingPreviewKey },
        select: { id: true, userId: true, businessId: true },
      });
      if (!racedBlog) throw error;
      if (racedBlog.userId !== userId || racedBlog.businessId !== businessId) {
        throw new Error("Onboarding preview idempotency key ownership mismatch");
      }
      return {
        blogId: racedBlog.id,
        planId: plan.id,
        alreadyExisted: true,
      };
    }

    await imageRecorder.attachBlog(blog.id);

    await KeywordTrackingService.markKeywordAsUsed(plan.id, blog.id);

    const elapsed = Date.now() - startTime;
    console.log(
      `✅ [FAST] Quick blog generated in ${elapsed}ms (${(elapsed / 1000).toFixed(1)}s) for trial user ${userId}, service: ${selectedService}`,
    );

    if (!options.suppressEmail) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true },
      });

      if (!user?.email) {
        return onboardingPreviewKey
          ? { blogId: blog.id, planId: plan.id, alreadyExisted: false }
          : undefined;
      }
      try {
        const userName: string =
          (user.name && user.name.trim() !== "")
            ? user.name
            : (user.email.split("@")[0] ?? "User");
        await sendQuickBlogEmail(
          user.email,
          userName,
          blogContent.title,
          slug ?? "",
          excerpt ?? "",
        );
        console.log(`✅ [FAST] Quick blog email sent to ${user.email}`);
      } catch (emailError) {
        console.error(`❌ [FAST] Failed to send quick blog email:`, emailError);
      }
    }
    return onboardingPreviewKey
      ? { blogId: blog.id, planId: plan.id, alreadyExisted: false }
      : undefined;
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(
      `❌ [FAST] Failed to generate quick blog in ${elapsed}ms for trial user ${userId}:`,
      error,
    );
    throw error;
  }
}
