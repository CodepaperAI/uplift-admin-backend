import { prisma } from "../config/db.config";
import { REFRESH_THRESHOLD_DAYS } from "../utils/blog-seo.utils";
import { detectSovDrop } from "./share-of-voice.service";

/**
 * Blog Freshness Service (B1)
 * ----------------------------------------------------------------------------
 * Daily cron runs `runFreshnessRefreshBatch` to re-score and partially
 * regenerate blogs older than REFRESH_THRESHOLD_DAYS (90d) whose SEO score
 * has dropped below the threshold.
 *
 * Triggers (additive — any hit schedules a refresh):
 *   - AGE + SCORE: blog is older than 90d AND seoScore < threshold (legacy).
 *   - CITATION_DECAY: blog's target keyword lost ≥ SOV_DROP_THRESHOLD_PCT
 *     percentage points of AI-answer share-of-voice vs the previous window.
 *     Fires regardless of age — AI visibility can collapse in days.
 *
 * Priority: blogs with higher citation success compound the fastest when
 * re-grounded with fresh citation context — refresh those first.
 *
 * Strategy:
 *   1. Re-run `scoreBlogContent` to identify failing signals.
 *   2. If the only failing signal is `freshness` → just bump lastRefreshedAt
 *      (content is still accurate, just old). Cheap path.
 *      Decay-triggered candidates SKIP this path — we know the content
 *      isn't resonating with LLMs, so a timestamp bump won't help.
 *   3. If there are 1–2 failing signals (FAQ, citations, schema) → targeted
 *      section regeneration via GPT-5 mini.
 *   4. If ≥3 failing signals or refreshAttempts ≥ 2 or decay-triggered →
 *      report a blocked full-regen need until the in-place full refresh pipeline
 *      is implemented. This is intentionally honest: do not count a fake
 *      regeneration as success.
 */

const STALE_SEO_THRESHOLD = 85;

// Percentage-point drop in keyword SoV over a 30-day window that triggers
// a refresh independent of blog age. Chosen to be meaningful but not
// jittery — a one-day dip on a low-volume keyword won't trip it because
// the detector requires prior-window data to exist at all.
const SOV_DROP_THRESHOLD_PCT = 25;
const SOV_WINDOW_DAYS = 30;
// Cap how many decay-triggered candidates we add beyond the age/score set.
// Keeps the per-run cost bounded when a large number of keywords regress
// simultaneously (e.g. after an LLM provider update).
const MAX_DECAY_CANDIDATES = 25;

type RefreshReason = "AGE_SCORE" | "CITATION_DECAY";

interface RefreshBatchOptions {
  limit?: number;
  dryRun?: boolean;
}

interface RefreshBatchResult {
  total: number;
  refreshed: number;
  skipped: number;
  failed: number;
  enqueuedFullRegen: number;
  byReason: Record<RefreshReason, number>;
}

export async function runFreshnessRefreshBatch(
  options: RefreshBatchOptions = {},
): Promise<RefreshBatchResult> {
  const { limit = 50, dryRun = false } = options;

  const cutoff = new Date(Date.now() - REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  const ageCandidates = await prisma.blog.findMany({
    where: {
      status: "PUBLISH",
      OR: [
        { lastRefreshedAt: null, updatedAt: { lt: cutoff } },
        { lastRefreshedAt: { lt: cutoff } },
      ],
      seoScore: { lt: STALE_SEO_THRESHOLD },
    },
    select: {
      id: true,
      businessId: true,
      slug: true,
      seoScore: true,
      refreshAttempts: true,
      lastRefreshedAt: true,
      updatedAt: true,
    },
    orderBy: [{ updatedAt: "asc" }],
    take: limit,
  });

  // Decay-triggered candidates: published blogs whose target keyword has
  // lost AI-answer share-of-voice vs the prior window. We scope to blogs
  // that are already "old enough for a refresh cycle to matter" — i.e.
  // refreshed (or created) more than a week ago, so we don't churn on
  // brand-new content whose citations haven't had time to land.
  const decayCandidatePool = await prisma.blog.findMany({
    where: {
      status: "PUBLISH",
      // Exclude anything already in the age batch.
      id: { notIn: ageCandidates.map((b) => b.id) },
      OR: [
        { lastRefreshedAt: null, createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
        { lastRefreshedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      ],
    },
    select: {
      id: true,
      businessId: true,
      slug: true,
      seoScore: true,
      refreshAttempts: true,
      lastRefreshedAt: true,
      updatedAt: true,
      meta: { select: { focus_keyword: true } },
    },
    // Check up to 4× the slot budget; we filter down by SoV check below.
    take: limit * 4,
    orderBy: [{ updatedAt: "asc" }],
  });

  const decayCandidates: Array<
    (typeof ageCandidates)[number] & { decayKeyword?: string; droppedBy?: number }
  > = [];
  for (const blog of decayCandidatePool) {
    if (decayCandidates.length >= MAX_DECAY_CANDIDATES) break;
    const keyword = blog.meta?.focus_keyword?.trim();
    if (!keyword) continue;
    try {
      const drop = await detectSovDrop(blog.businessId, keyword, {
        windowDays: SOV_WINDOW_DAYS,
        dropThresholdPct: SOV_DROP_THRESHOLD_PCT,
      });
      if (drop.dropped) {
        decayCandidates.push({
          id: blog.id,
          businessId: blog.businessId,
          slug: blog.slug,
          seoScore: blog.seoScore,
          refreshAttempts: blog.refreshAttempts,
          lastRefreshedAt: blog.lastRefreshedAt,
          updatedAt: blog.updatedAt,
          decayKeyword: keyword,
          droppedBy: drop.droppedBy,
        });
      }
    } catch (err) {
      console.error(
        `[freshness] SoV check failed for blog ${blog.id}:`,
        (err as Error).message,
      );
    }
  }

  // Merge candidate sets, dedupe by id, respect the top-level limit.
  const candidateMap = new Map<
    string,
    (typeof ageCandidates)[number] & {
      reason: RefreshReason;
      decayKeyword?: string;
      droppedBy?: number;
    }
  >();
  for (const blog of ageCandidates) {
    candidateMap.set(blog.id, { ...blog, reason: "AGE_SCORE" });
  }
  for (const blog of decayCandidates) {
    if (!candidateMap.has(blog.id)) {
      candidateMap.set(blog.id, {
        ...blog,
        reason: "CITATION_DECAY",
      });
    }
  }
  const candidates = Array.from(candidateMap.values()).slice(0, limit);

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  let enqueuedFullRegen = 0;
  const byReason: Record<RefreshReason, number> = {
    AGE_SCORE: 0,
    CITATION_DECAY: 0,
  };

  for (const blog of candidates) {
    byReason[blog.reason]++;
    try {
      if (dryRun) {
        skipped++;
        continue;
      }

      const { scoreBlogContent, isScoreSkipped } = await import(
        "./content-scorecard.service"
      );
      const scoreResult = await scoreBlogContent(blog.id, blog.businessId);
      if (isScoreSkipped(scoreResult)) {
        // Blog was skipped by the scorer (e.g. deleted/archived). Treat as
        // no-op for this pass — don't bump refreshAttempts.
        skipped++;
        continue;
      }
      // Map failing signals back to refreshable section keys (D9).
      const failingSignals = scoreResult.suggestions
        .filter((s) => s.priority === "high" || s.priority === "medium")
        .map((s) => s.signal as string)
        .filter(
          (s): s is
            | "definitionalClarity"
            | "faqSection"
            | "sourceCitations"
            | "freshness"
            | "schemaMarkup" =>
            [
              "definitionalClarity",
              "faqSection",
              "sourceCitations",
              "freshness",
              "schemaMarkup",
            ].includes(s),
        );
      const failingCount = failingSignals.length;

      if (failingCount === 0 && blog.reason === "AGE_SCORE") {
        // Just stale-by-date — bump timestamps without regen.
        // Decay-triggered entries skip this path: we already know the
        // content isn't earning AI citations, so a timestamp bump is a
        // no-op. Fall through to full regen instead.
        await prisma.blog.update({
          where: { id: blog.id },
          data: {
            lastRefreshedAt: new Date(),
            // Do NOT bump updatedAt — that only moves on real content change.
          },
        });
        refreshed++;
        continue;
      }

      if (
        failingCount >= 3 ||
        blog.refreshAttempts >= 2 ||
        blog.reason === "CITATION_DECAY"
      ) {
        const regenReason =
          blog.reason === "CITATION_DECAY"
            ? "citation-decay"
            : "freshness-multi-signal";
        failed++;
        console.warn(
          `⚠️ Blog ${blog.slug} needs full regen but in-place full regeneration is not implemented yet (reason=${regenReason}, attempts=${blog.refreshAttempts}, failing=${failingCount}).`,
        );
        continue;
      }

      // D9: Partial regen path — targeted section rewrite via GPT-5 mini.
      try {
        const { refreshBlogSections } = await import(
          "./blog-section-refresh.service"
        );
        const result = await refreshBlogSections(blog.id, failingSignals);
        if (result.refreshed && result.html && result.html !== "") {
          // Persist the refreshed HTML. Bump both updatedAt (content changed)
          // and lastRefreshedAt (marks this cycle complete).
          await prisma.blog.update({
            where: { id: blog.id },
            data: {
              content: result.html,
              refreshAttempts: { increment: 1 },
              lastRefreshedAt: new Date(),
              updatedAt: new Date(),
            },
          });
          refreshed++;
          console.log(
            `🔄 Blog ${blog.slug} partial refresh OK (sections=${result.sectionsUpdated.join(",")}).`,
          );
        } else {
          // Section refresh didn't change anything — still bump timestamps
          // so the next cron pass can decide whether to escalate to full regen.
          await prisma.blog.update({
            where: { id: blog.id },
            data: {
              refreshAttempts: { increment: 1 },
              lastRefreshedAt: new Date(),
            },
          });
          refreshed++;
          console.log(
            `🔄 Blog ${blog.slug} partial refresh skipped (${result.reason ?? "no change"}); awaiting next cron.`,
          );
        }
      } catch (refreshErr) {
        console.error(
          `[freshness] partial refresh failed for ${blog.id}:`,
          (refreshErr as Error).message,
        );
        // Don't increment refreshAttempts on a hard failure — we want a clean retry.
        failed++;
      }
    } catch (err) {
      failed++;
      console.error(
        `⚠️ Freshness refresh failed for blog ${blog.id}:`,
        (err as Error).message,
      );
    }
  }

  return {
    total: candidates.length,
    refreshed,
    skipped,
    failed,
    enqueuedFullRegen,
    byReason,
  };
}
