import { prisma } from "../config/db.config";
import { createGPT5MiniModel } from "../config/llm.config";

/**
 * Content Scorecard Service
 *
 * Analyzes blog content for LLM-citation readiness across 5 signals:
 *   1. Schema markup (JSON-LD present): 0 or 2
 *   2. FAQ section: 0 / 1 (partial) / 2 (full with schema)
 *   3. Source citations (external links): 0 / 1 / 2
 *   4. Definitional clarity (LLM-assessed): 0 or 2
 *   5. Content freshness: 0 / 1 / 2
 *
 * Overall score: sum of all signals (0-10)
 */

interface ScoreResult {
  overallScore: number;
  schemaMarkup: number;
  faqSection: number;
  sourceCitations: number;
  definitionalClarity: number;
  freshness: number;
  suggestions: Array<{ signal: string; message: string; priority: "high" | "medium" | "low" }>;
  /**
   * True when the definitional-clarity LLM call failed AND a prior score
   * existed, so we kept the prior clarity value instead of writing 0.
   */
  definitionalClarityPreserved?: boolean;
}

/**
 * Sentinel returned when we couldn't compute a score this run AND there
 * was no prior score to preserve. We explicitly do NOT write a row in
 * this case — a synthetic 0 would bias every dashboard aggregate.
 */
export type ScoreSkipped = {
  skipped: true;
  reason: "model_unavailable";
  blogId: string;
};

export function isScoreSkipped(
  result: ScoreResult | ScoreSkipped,
): result is ScoreSkipped {
  return (result as ScoreSkipped).skipped === true;
}

// ----- Signal scorers -----

function scoreSchemaMarkup(content: string): { score: number; suggestion: string | null } {
  // Check for JSON-LD in content
  const hasJsonLd =
    content.includes('"@context"') ||
    content.includes("application/ld+json") ||
    content.includes("schema.org");

  if (hasJsonLd) return { score: 2, suggestion: null };
  return {
    score: 0,
    suggestion: "Add JSON-LD structured data (Schema.org) to improve LLM discoverability",
  };
}

function scoreFaqSection(content: string): { score: number; suggestion: string | null } {
  const lowerContent = content.toLowerCase();
  const hasFaqHeading =
    /(<h[23][^>]*>.*?(faq|frequently\s+asked|common\s+questions).*?<\/h[23]>)/i.test(content);
  const hasFaqSchema =
    lowerContent.includes("faqpage") || lowerContent.includes('"@type":"FAQPage"');

  if (hasFaqHeading && hasFaqSchema) return { score: 2, suggestion: null };
  if (hasFaqHeading) return { score: 1, suggestion: "Add FAQPage schema markup to your FAQ section" };
  return {
    score: 0,
    suggestion: "Add a FAQ section with structured FAQPage schema — LLMs frequently cite FAQ content",
  };
}

function scoreSourceCitations(content: string): { score: number; suggestion: string | null } {
  // Count external links (exclude internal links and common non-source domains)
  const linkRegex = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
  const links = [...content.matchAll(linkRegex)];

  const externalLinks = links.filter((match) => {
    const url = (match[1] || "").toLowerCase();
    return (
      !url.includes("javascript:") &&
      !url.includes("#") &&
      !url.includes("facebook.com/share") &&
      !url.includes("twitter.com/intent") &&
      !url.includes("linkedin.com/share")
    );
  });

  const count = externalLinks.length;

  if (count >= 3) return { score: 2, suggestion: null };
  if (count >= 1) return { score: 1, suggestion: "Add more external source citations (aim for 3+) to boost authority signals" };
  return {
    score: 0,
    suggestion: "Add external source citations — LLMs trust content that references authoritative sources",
  };
}

async function scoreDefinitionalClarity(
  content: string,
  title: string,
): Promise<{ score: number; suggestion: string | null; failed: boolean }> {
  try {
    // Extract first ~500 chars of text content (strip HTML)
    const textContent = content
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);

    const model = createGPT5MiniModel();
    const response = await model.invoke([
      {
        role: "system",
        content:
          'You evaluate whether an article has a clear, concise definition or summary in its opening. Respond with only "YES" or "NO".',
      },
      {
        role: "user",
        content: `Article title: "${title}"\n\nOpening text: "${textContent}"\n\nDoes this opening contain a clear, concise definition or summary that directly answers what the article is about within the first 2-3 sentences? (This should be a quotable, factual statement that an AI could extract and cite.)`,
      },
    ]);

    const answer = typeof response.content === "string" ? response.content.trim().toUpperCase() : "";
    if (answer.startsWith("YES")) return { score: 2, suggestion: null, failed: false };
    return {
      score: 0,
      suggestion: "Add a concise definitional paragraph in the first 200 words — LLMs prefer clear, quotable opening statements",
      failed: false,
    };
  } catch (error) {
    // On LLM failure, return a failure sentinel. The caller decides
    // whether to preserve a prior score or skip the blog entirely —
    // we intentionally do NOT write a synthetic 0 here (that biased
    // every dashboard aggregate during provider outages).
    return { score: 0, suggestion: null, failed: true };
  }
}

function scoreFreshness(
  updatedAt: Date,
): { score: number; suggestion: string | null } {
  const now = new Date();
  const monthsOld =
    (now.getTime() - updatedAt.getTime()) / (30 * 24 * 60 * 60 * 1000);

  if (monthsOld < 3) return { score: 2, suggestion: null };
  if (monthsOld < 6) return { score: 1, suggestion: "Content is 3-6 months old — consider updating to maintain freshness signals" };
  return {
    score: 0,
    suggestion: "Content is over 6 months old — LLMs prefer fresh, recently updated content",
  };
}

// ----- Main scoring function -----

export async function scoreBlogContent(
  blogId: string,
  businessId: string,
): Promise<ScoreResult | ScoreSkipped> {
  const blog = await prisma.blog.findUnique({
    where: { id: blogId },
    select: {
      title: true,
      content: true,
      updatedAt: true,
    },
  });

  if (!blog) throw new Error(`Blog ${blogId} not found`);

  const suggestions: ScoreResult["suggestions"] = [];

  const schema = scoreSchemaMarkup(blog.content);
  const faq = scoreFaqSection(blog.content);
  const sources = scoreSourceCitations(blog.content);
  const definitional = await scoreDefinitionalClarity(blog.content, blog.title);
  const fresh = scoreFreshness(blog.updatedAt);

  // Resolve the definitional-clarity value we'll persist:
  //   - LLM succeeded → use the fresh score.
  //   - LLM failed + prior score exists → preserve the prior clarity.
  //   - LLM failed + no prior → SKIP this blog (don't write synthetic 0).
  let definitionalClarityToStore = definitional.score;
  let definitionalClarityPreserved = false;
  let definitionalSuggestion: string | null = definitional.suggestion;

  if (definitional.failed) {
    const prior = await prisma.contentLlmScore.findUnique({
      where: { blogId },
      select: { definitionalClarity: true },
    });
    if (prior) {
      definitionalClarityToStore = prior.definitionalClarity;
      definitionalClarityPreserved = true;
      definitionalSuggestion = null; // don't add a misleading suggestion
      console.warn(
        JSON.stringify({
          event: "ai_visibility.clarity_preserved",
          blogId,
          businessId,
          preservedScore: prior.definitionalClarity,
          reason: "model_unavailable",
        }),
      );
    } else {
      console.warn(
        JSON.stringify({
          event: "ai_visibility.clarity_skipped",
          blogId,
          businessId,
          reason: "model_unavailable",
        }),
      );
      return { skipped: true, reason: "model_unavailable", blogId };
    }
  }

  if (schema.suggestion) suggestions.push({ signal: "schemaMarkup", message: schema.suggestion, priority: "high" });
  if (faq.suggestion) suggestions.push({ signal: "faqSection", message: faq.suggestion, priority: "high" });
  if (sources.suggestion) suggestions.push({ signal: "sourceCitations", message: sources.suggestion, priority: "medium" });
  if (definitionalSuggestion) suggestions.push({ signal: "definitionalClarity", message: definitionalSuggestion, priority: "high" });
  if (fresh.suggestion) suggestions.push({ signal: "freshness", message: fresh.suggestion, priority: "low" });

  const overallScore =
    schema.score +
    faq.score +
    sources.score +
    definitionalClarityToStore +
    fresh.score;

  // Upsert the score
  await prisma.contentLlmScore.upsert({
    where: { blogId },
    create: {
      blogId,
      businessId,
      overallScore,
      schemaMarkup: schema.score,
      faqSection: faq.score,
      sourceCitations: sources.score,
      definitionalClarity: definitionalClarityToStore,
      freshness: fresh.score,
      suggestions,
      lastScored: new Date(),
    },
    update: {
      overallScore,
      schemaMarkup: schema.score,
      faqSection: faq.score,
      sourceCitations: sources.score,
      definitionalClarity: definitionalClarityToStore,
      freshness: fresh.score,
      suggestions,
      lastScored: new Date(),
    },
  });

  return {
    overallScore,
    schemaMarkup: schema.score,
    faqSection: faq.score,
    sourceCitations: sources.score,
    definitionalClarity: definitionalClarityToStore,
    freshness: fresh.score,
    suggestions,
    definitionalClarityPreserved,
  };
}

/**
 * Score all content for a business (retroactive backfill)
 */
export async function scoreAllContentForBusiness(businessId: string) {
  const blogs = await prisma.blog.findMany({
    where: { businessId },
    select: { id: true },
  });

  console.log(`📊 Scoring ${blogs.length} blogs for business ${businessId}`);

  type ResultRow =
    | { blogId: string; score: number }
    | { blogId: string; skipped: true; reason: string }
    | { blogId: string; error: string };

  const results: ResultRow[] = [];
  for (const blog of blogs) {
    try {
      const score = await scoreBlogContent(blog.id, businessId);
      if (isScoreSkipped(score)) {
        results.push({ blogId: blog.id, skipped: true, reason: score.reason });
      } else {
        results.push({ blogId: blog.id, score: score.overallScore });
      }
    } catch (error: any) {
      console.error(`⚠️ Failed to score blog ${blog.id}: ${error.message}`);
      results.push({ blogId: blog.id, error: error.message });
    }
  }

  return {
    total: blogs.length,
    scored: results.filter((r) => "score" in r).length,
    skipped: results.filter((r) => "skipped" in r).length,
    failed: results.filter((r) => "error" in r).length,
    results,
  };
}

/**
 * Get content scores for dashboard
 */
export async function getContentScores(businessId: string) {
  return prisma.contentLlmScore.findMany({
    where: { businessId },
    include: {
      blog: {
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          updatedAt: true,
        },
      },
    },
    orderBy: { overallScore: "asc" }, // Worst first
  });
}
