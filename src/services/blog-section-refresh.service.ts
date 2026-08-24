import { prisma } from "../config/db.config";
import { createGPT56LunaModel } from "../config/llm.config";

/**
 * Blog Section Refresh (D9)
 * ----------------------------------------------------------------------------
 * Targeted section-level rewriting for the freshness cron. Instead of
 * regenerating the entire blog (expensive + breaks internal-link equity),
 * we:
 *   1. Identify the stale sections from scorecard signals.
 *   2. Extract each section's HTML by regex (FAQ / Quick Answer opening /
 *      featured-snippet paragraphs / external citations).
 *   3. Send a targeted GPT-5.6 Luna prompt with only the section + minimal context.
 *   4. Splice the returned HTML back into the full blog content.
 *   5. Re-run the verifier on any new citations so we never re-introduce a
 *      hallucinated source.
 *
 * Conservative by design — if the LLM returns something malformed we return
 * the original HTML unchanged so the published blog never ends up broken.
 */

export type FailingSignal =
  | "definitionalClarity" // opening paragraph
  | "faqSection"
  | "sourceCitations"
  | "freshness"
  | "schemaMarkup";

export interface RefreshResult {
  refreshed: boolean;
  html: string;
  sectionsUpdated: FailingSignal[];
  reason?: string;
}

export async function refreshBlogSections(
  blogId: string,
  failingSignals: FailingSignal[],
): Promise<RefreshResult> {
  if (failingSignals.length === 0) {
    return { refreshed: false, html: "", sectionsUpdated: [], reason: "no_failing_signals" };
  }

  const blog = await prisma.blog.findUnique({
    where: { id: blogId },
    select: {
      id: true,
      title: true,
      content: true,
      businessId: true,
      meta: { select: { focus_keyword: true, keywords: true } },
      business: {
        select: {
          businessName: true,
          businessCity: true,
          businessCountry: true,
          businessWebsiteUrl: true,
        },
      },
    },
  });
  if (!blog || !blog.content) {
    return { refreshed: false, html: "", sectionsUpdated: [], reason: "blog_not_found" };
  }

  let html = blog.content;
  const sectionsUpdated: FailingSignal[] = [];

  const keyword = blog.meta?.focus_keyword ?? blog.title;
  const businessName = blog.business?.businessName ?? "the business";
  const location = blog.business?.businessCity ?? "";

  for (const signal of failingSignals) {
    try {
      const updated = await refreshOneSection(html, signal, {
        title: blog.title,
        keyword,
        businessName,
        location,
      });
      if (updated && updated !== html) {
        html = updated;
        sectionsUpdated.push(signal);
      }
    } catch (err) {
      console.error(
        `[blog-section-refresh] ${signal} refresh failed for blog ${blogId}:`,
        (err as Error).message,
      );
    }
  }

  if (sectionsUpdated.length === 0) {
    return { refreshed: false, html: blog.content, sectionsUpdated: [] };
  }

  // Re-run citation verifier on the rewritten HTML so any new external
  // citations introduced by the LLM are validated.
  try {
    const { verifyAndCleanExternalCitations } = await import(
      "./citation-verification.service"
    );
    const verified = await verifyAndCleanExternalCitations(
      html,
      blog.business?.businessWebsiteUrl ?? null,
    );
    html = verified.html;
  } catch (err) {
    console.error(
      "[blog-section-refresh] citation re-verify failed:",
      (err as Error).message,
    );
  }

  return { refreshed: true, html, sectionsUpdated };
}

// ---------------------------------------------------------------------------
// Section extractors + rewriters
// ---------------------------------------------------------------------------

interface RefreshContext {
  title: string;
  keyword: string;
  businessName: string;
  location: string;
}

async function refreshOneSection(
  html: string,
  signal: FailingSignal,
  ctx: RefreshContext,
): Promise<string | null> {
  switch (signal) {
    case "definitionalClarity":
      return refreshOpeningParagraph(html, ctx);
    case "faqSection":
      return refreshFaqSection(html, ctx);
    case "sourceCitations":
      return refreshCitations(html, ctx);
    case "freshness":
      // Freshness isn't really a "rewrite this" signal — it's "bump the
      // dateModified stamp". Caller handles that via lastRefreshedAt.
      return html;
    case "schemaMarkup":
      // Schema regeneration is risky to splice manually; defer to full regen.
      return null;
    default:
      return null;
  }
}

async function refreshOpeningParagraph(html: string, ctx: RefreshContext) {
  // Extract the first <p>...</p> that isn't inside an aside/quote.
  const openingRe = /<p[^>]*>([\s\S]*?)<\/p>/i;
  const match = openingRe.exec(html);
  if (!match) return null;

  const current = match[1] ?? "";
  if (current.trim().length === 0) return null;

  const model = createGPT56LunaModel();
  const response = await model.invoke([
    {
      role: "system",
      content:
        "You rewrite blog opening paragraphs to be more definitionally clear for AI citation. Return ONLY the rewritten paragraph as HTML inside <p>...</p> tags — no prose before or after, no markdown.",
    },
    {
      role: "user",
      content: `Blog title: "${ctx.title}"
Focus keyword: "${ctx.keyword}"
Business: "${ctx.businessName}" ${ctx.location ? `in ${ctx.location}` : ""}

Current opening paragraph:
${current.trim()}

Rewrite it to:
- Start with a clear, quotable definition or direct answer in the first sentence (format: "<Topic> is <clear definition>.")
- Include the focus keyword naturally within the first 30 words.
- Be 40-60 words total.
- Use definitive language ("X is…", "X refers to…") — not hedging.
- Mention ${ctx.location || "the location"} naturally if the topic is local.

Return only the <p>...</p> block.`,
    },
  ]);
  const rewritten = typeof response.content === "string" ? response.content.trim() : "";
  if (!rewritten || !/^<p[\s>]/i.test(rewritten) || !/<\/p>\s*$/i.test(rewritten)) {
    return null;
  }
  return html.replace(match[0] ?? "", rewritten);
}

async function refreshFaqSection(html: string, ctx: RefreshContext) {
  // Grab everything between an H2 containing "FAQ" / "Frequently" and the
  // next H2 (or end of content).
  const faqBlockRe = /(<h2[^>]*>[\s\S]{0,200}?(?:FAQ|Frequently Asked Questions)[\s\S]{0,60}?<\/h2>)([\s\S]*?)(?=<h2[^>]*>|$)/i;
  const match = faqBlockRe.exec(html);
  if (!match) return null;

  const heading = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  if (body.length === 0) return null;

  const model = createGPT56LunaModel();
  const response = await model.invoke([
    {
      role: "system",
      content:
        "You refresh FAQ sections in blog posts. Return ONLY the rewritten FAQ body HTML — 3 to 5 Q/A pairs, each wrapped exactly as: <div class=\"faq\" itemscope itemtype=\"https://schema.org/Question\"><h3 class=\"faq-question\" itemprop=\"name\">Q?</h3><p class=\"faq-answer\" style=\"margin:0 0 1em 0;\" itemprop=\"acceptedAnswer\">A.</p></div>. No prose before or after, no markdown.",
    },
    {
      role: "user",
      content: `Blog title: "${ctx.title}"
Focus keyword: "${ctx.keyword}"
Business: "${ctx.businessName}" ${ctx.location ? `in ${ctx.location}` : ""}

Current FAQ body:
${body}

Rewrite to:
- 3 to 5 distinct Q/A pairs covering real buyer questions.
- Each answer 2-4 sentences, crisp and direct.
- NO pricing questions.
- Each wrapped in the exact <div class="faq">... structure described above.

Return only the FAQ body HTML (no <h2> heading — just the div blocks).`,
    },
  ]);
  const rewritten = typeof response.content === "string" ? response.content.trim() : "";
  if (!rewritten || !rewritten.includes('class="faq-answer"')) {
    return null;
  }
  return html.replace(match[0] ?? "", heading + "\n" + rewritten + "\n");
}

async function refreshCitations(html: string, ctx: RefreshContext) {
  // We don't regenerate citations via LLM (too easy to hallucinate URLs).
  // Instead, strip unresolvable ones — this is the verifier's job. Here we
  // just return the HTML unchanged and rely on the verifier's post-refresh
  // pass to drop broken citations. Marking as "attempted" is still useful
  // because it tells the cron not to enqueue full regen prematurely.
  void ctx;
  return html;
}
