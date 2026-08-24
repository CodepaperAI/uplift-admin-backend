import { DRActionStatus, DRActionType } from "@prisma/client";
import { load } from "cheerio";
import { prisma } from "../config/db.config";
import { createGPT4oMiniModel } from "../config/llm.config";
import {
  updateWordPressContent,
  type WordPressUpdateResult,
} from "../utils/wordpress-publisher";

interface ContentOptimizationResult {
  success: boolean;
  optimizedContent?: string;
  addedSections: string[];
  drRangeStrategy: string;
  error?: string;
}

const NEXT_STEP_SECTION_PATTERN =
  /<section\b(?=[^>]*\bclass\s*=\s*(["'])[^"']*\bnext-step\b[^"']*\1)[^>]*>[\s\S]*?<\/section\s*>/gi;

const ESCAPED_STRUCTURAL_MARKUP_PATTERN =
  /&lt;\s*\/?\s*(?:a|script|iframe|object|embed|style|img)\b/i;
const REPEATED_TOKEN_RUN_PATTERN =
  /(?:^|[^a-z0-9])([a-z0-9]{2,24})(?:[-_]\1){8,}(?:[^a-z0-9]|$)/i;
const UNSAFE_HTML_ELEMENT_SELECTOR = "script, iframe, object, embed";
const MAX_HREF_LENGTH = 2_048;

function collectAnchorHrefs(html: string): string[] {
  const $ = load(html, null, false);
  return $("a")
    .toArray()
    .map((element) => ($(element).attr("href") ?? "").trim());
}

function countRawTags(html: string, pattern: RegExp): number {
  return html.match(pattern)?.length ?? 0;
}

/**
 * DR optimization is allowed to improve structure and add grounded prose, but
 * it must never become a second source of publishing truth. In particular,
 * the model may not invent links or turn malformed markup into visible text.
 */
export function validateDrOptimizedContent(
  canonicalContent: string,
  optimizedContent: string,
): string {
  const candidate = optimizedContent.trim();

  if (!candidate) {
    throw new Error("DR optimized content is empty");
  }

  const minimumLength = Math.floor(canonicalContent.length * 0.8);
  const maximumLength = Math.max(
    Math.ceil(canonicalContent.length * 1.75),
    canonicalContent.length + 4_000,
  );

  if (candidate.length < minimumLength) {
    throw new Error("DR optimized content is too short");
  }

  if (candidate.length > maximumLength) {
    throw new Error("DR optimized content expanded beyond the safe limit");
  }

  if (ESCAPED_STRUCTURAL_MARKUP_PATTERN.test(candidate)) {
    throw new Error("DR optimized content contains escaped structural markup");
  }

  if (REPEATED_TOKEN_RUN_PATTERN.test(candidate)) {
    throw new Error("DR optimized content contains a repeated-token run");
  }

  const openingAnchors = countRawTags(candidate, /<a\b[^>]*>/gi);
  const closingAnchors = countRawTags(candidate, /<\/a\s*>/gi);
  if (openingAnchors !== closingAnchors) {
    throw new Error("DR optimized content contains unbalanced anchor tags");
  }

  const canonicalHrefs = collectAnchorHrefs(canonicalContent);
  const canonicalHrefSet = new Set(canonicalHrefs);
  const optimizedHrefs = collectAnchorHrefs(candidate);

  for (const href of optimizedHrefs) {
    if (!href) {
      throw new Error("DR optimized content contains an anchor without an href");
    }
    if (href.length > MAX_HREF_LENGTH) {
      throw new Error("DR optimized content contains an oversized href");
    }
    if (!canonicalHrefSet.has(href)) {
      throw new Error("DR optimized content introduced a non-canonical link");
    }
  }

  for (const href of canonicalHrefSet) {
    if (!optimizedHrefs.includes(href)) {
      throw new Error("DR optimized content removed a canonical link");
    }
  }

  const canonical$ = load(canonicalContent, null, false);
  const optimized$ = load(candidate, null, false);
  if (optimized$(UNSAFE_HTML_ELEMENT_SELECTOR).length > 0) {
    throw new Error("DR optimized content contains an unsafe HTML element");
  }

  const canonicalHasReferencesHeading = canonical$("h1, h2, h3, h4, h5, h6")
    .toArray()
    .some((element) => /sources?\s*(?:&|and)?\s*references?/i.test(canonical$(element).text()));
  const optimizedHasReferencesHeading = optimized$("h1, h2, h3, h4, h5, h6")
    .toArray()
    .some((element) => /sources?\s*(?:&|and)?\s*references?/i.test(optimized$(element).text()));

  if (!canonicalHasReferencesHeading && optimizedHasReferencesHeading) {
    throw new Error("DR optimized content introduced an ungrounded references section");
  }

  return candidate;
}

/**
 * The recovery pipeline appends one approved, business-grounded CTA after the
 * article. DR optimization is a secondary post-publish enhancement and must
 * not replace or hallucinate that CTA.
 */
export function preserveCanonicalNextStepSection(
  canonicalContent: string,
  optimizedContent: string,
): string {
  const canonicalSections =
    canonicalContent.match(NEXT_STEP_SECTION_PATTERN) ?? [];

  if (canonicalSections.length === 0) {
    return optimizedContent;
  }

  if (canonicalSections.length !== 1) {
    throw new Error(
      `Canonical content must contain exactly one next-step section; found ${canonicalSections.length}`,
    );
  }

  const withoutGeneratedNextSteps = optimizedContent
    .replace(NEXT_STEP_SECTION_PATTERN, "")
    .trimEnd();

  return `${withoutGeneratedNextSteps}\n${canonicalSections[0]}`;
}

/**
 * Get the current DR range strategy for a business based on their average domain authority.
 */
function getDRRangeStrategy(avgDA: number | null): string {
  if (!avgDA || avgDA < 10) return "foundational"; // DR 0-10
  if (avgDA < 30) return "data_driven"; // DR 10-30
  return "authority"; // DR 30+
}

/**
 * Generate link-worthy content additions using LLM based on DR range.
 */
async function generateLinkWorthyAdditions(
  blogContent: string,
  blogTitle: string,
  businessName: string,
  businessDescription: string | null,
  drStrategy: string
): Promise<{ sections: string[]; optimizedContent: string }> {
  const llm = createGPT4oMiniModel(0.3);

  const strategyInstructions: Record<string, string> = {
    foundational: `This is a low-authority site (DR 0-10). Focus on:
- Add a clear "Key Takeaways" section at the top with 3-5 bullet points that bloggers might quote
- Ensure the content has clear H2/H3 structure that makes it easy to reference specific sections`,
    data_driven: `This is a growing site (DR 10-30). Focus on:
- Add a "Key Statistics" or "Key Data" section with 3-5 specific, quotable data points relevant to the topic
- Add an embeddable HTML snippet (a simple stat card or key finding box that other sites can embed)
- Add FAQ structured data (3-4 Q&A pairs) at the end to improve SERP visibility`,
    authority: `This is an established site (DR 30+). Focus on:
- Add expert-level analysis or a unique perspective section with original insights
- Add an embeddable infographic-style HTML block (stat comparison or trend summary)
- Add industry benchmark data or comparative analysis that positions this as a reference piece`,
  };

  const prompt = `You are an SEO content optimizer. Your job is to add link-worthy elements to a blog post that will attract backlinks from other websites.

Business: ${businessName}
${businessDescription ? `About: ${businessDescription}` : ""}

Strategy: ${strategyInstructions[drStrategy] || strategyInstructions.foundational}

Here is the blog post:

Title: ${blogTitle}

Content:
${blogContent}

INSTRUCTIONS:
1. Return the FULL blog post content with your additions seamlessly integrated
2. Do NOT remove or significantly alter existing content
3. Add the link-worthy sections as described in the strategy above
4. Use proper HTML formatting (the content is HTML)
5. Make additions feel natural, not bolted-on
6. Any statistics or data points should be clearly attributed or marked as industry estimates
7. Do NOT add, remove, rewrite, or reformat hyperlinks. Preserve every existing href exactly
8. Do NOT create a Sources & References section or invent citation URLs
9. Do NOT output escaped HTML such as &lt;a href=...&gt;

Return ONLY the optimized HTML content, nothing else. No markdown code fences.`;

  const response = await llm.invoke(prompt);
  const optimizedContent = typeof response.content === "string"
    ? response.content
    : String(response.content);

  // Determine which sections were added based on strategy
  const addedSections: string[] = [];
  if (drStrategy === "foundational") {
    if (optimizedContent.toLowerCase().includes("key takeaway")) addedSections.push("key_takeaways");
    if (optimizedContent.toLowerCase().includes("source") || optimizedContent.toLowerCase().includes("reference")) addedSections.push("sources_section");
  } else if (drStrategy === "data_driven") {
    if (optimizedContent.toLowerCase().includes("statistic") || optimizedContent.toLowerCase().includes("key data")) addedSections.push("stats_section");
    if (optimizedContent.toLowerCase().includes("embed")) addedSections.push("embeddable_snippet");
    if (optimizedContent.toLowerCase().includes("faq") || optimizedContent.toLowerCase().includes("question")) addedSections.push("structured_data");
  } else {
    if (optimizedContent.toLowerCase().includes("analysis") || optimizedContent.toLowerCase().includes("insight")) addedSections.push("expert_analysis");
    if (optimizedContent.toLowerCase().includes("benchmark") || optimizedContent.toLowerCase().includes("comparison")) addedSections.push("benchmark_data");
  }

  return { sections: addedSections, optimizedContent };
}

/**
 * Optimize a published blog post for link-worthiness.
 * Called by the Inngest function after a blog is published.
 */
export async function optimizeBlogForLinks(params: {
  blogId: string;
  businessId: string;
}): Promise<ContentOptimizationResult> {
  const { blogId, businessId } = params;

  // Fetch blog with business data
  const blog = await prisma.blog.findUnique({
    where: { id: blogId },
    include: {
      business: true,
      publishedBlogs: {
        where: { status: "PUBLISHED" },
        include: { integration: true },
        take: 1,
      },
    },
  });

  if (!blog) {
    return { success: false, addedSections: [], drRangeStrategy: "unknown", error: "Blog not found" };
  }

  if (!blog.publishedBlogs.length) {
    return { success: false, addedSections: [], drRangeStrategy: "unknown", error: "Blog has no published version" };
  }

  // Get current DR for the business
  const backlinkSummary = await prisma.externalBacklinkSummary.findUnique({
    where: { businessId },
  });
  const currentDR = backlinkSummary?.averageDomainAuthority ?? null;
  const drStrategy = getDRRangeStrategy(currentDR);

  // Check if already optimized
  const existingOptimization = await prisma.dRContentOptimization.findFirst({
    where: { blogId, status: "COMPLETED" },
  });
  if (existingOptimization) {
    return { success: true, addedSections: [], drRangeStrategy: drStrategy, error: "Already optimized" };
  }

  // Create action log
  const actionLog = await prisma.dRActionLog.create({
    data: {
      businessId,
      businessDR: currentDR ? Math.round(currentDR) : null,
      actionType: DRActionType.CONTENT_OPTIMIZATION,
      status: DRActionStatus.IN_PROGRESS,
    },
  });

  try {
    // Generate optimized content
    const { sections, optimizedContent } = await generateLinkWorthyAdditions(
      blog.content,
      blog.title,
      blog.business.businessName || "Business",
      blog.business.businessDescription ?? null,
      drStrategy
    );

    const publishableOptimizedContent = validateDrOptimizedContent(
      blog.content,
      preserveCanonicalNextStepSection(blog.content, optimizedContent),
    );

    // Find the WordPress integration to push the update
    const publishedBlog = blog.publishedBlogs[0];
    const integration = publishedBlog?.integration;

    if (
      integration &&
      integration.wordpressUrl &&
      integration.wordpressIntegrationKey &&
      integration.wordpressConnectionMethod === "PLUGIN" &&
      publishedBlog?.externalPostId
    ) {
      // Push update to WordPress
      const updateResult: WordPressUpdateResult = await updateWordPressContent(
        {
          postId: publishedBlog.externalPostId,
          content: publishableOptimizedContent,
          source: "dr_content_optimization",
        },
        {
          websiteUrl: integration.wordpressUrl,
          integrationKey: integration.wordpressIntegrationKey,
          connectionMethod: "PLUGIN",
        }
      );

      if (!updateResult.success) {
        throw new Error(updateResult.error || "WordPress update failed");
      }
    }

    // Log the optimization
    await prisma.dRContentOptimization.create({
      data: {
        businessId,
        blogId,
        externalPostId: publishedBlog?.externalPostId ?? null,
        optimizationType: sections.join(",") || "general",
        contentBefore: blog.content.substring(0, 500),
        contentAdded: sections.join(", "),
        drRangeStrategy: drStrategy,
        status: DRActionStatus.COMPLETED,
      },
    });

    // Update action log
    await prisma.dRActionLog.update({
      where: { id: actionLog.id },
      data: {
        status: DRActionStatus.COMPLETED,
        completedAt: new Date(),
        details: {
          blogId,
          sections,
          drStrategy,
          contentLengthBefore: blog.content.length,
          contentLengthAfter: publishableOptimizedContent.length,
          canonicalContentPreserved: true,
        },
      },
    });

    return {
      success: true,
      optimizedContent: publishableOptimizedContent,
      addedSections: sections,
      drRangeStrategy: drStrategy,
    };
  } catch (error: any) {
    // Update action log with failure
    await prisma.dRActionLog.update({
      where: { id: actionLog.id },
      data: {
        status: DRActionStatus.FAILED,
        error: error.message,
        retryCount: { increment: 1 },
      },
    });

    return {
      success: false,
      addedSections: [],
      drRangeStrategy: drStrategy,
      error: error.message,
    };
  }
}
