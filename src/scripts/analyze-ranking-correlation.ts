/**
 * analyze-ranking-correlation.ts
 *
 * Data-driven calibration: learn what actually ranks from the system's own
 * Google Search Console data instead of guessing. For every published blog that
 * has both a live URL and GSC data, it joins real ranking (avg position, clicks)
 * to the blog's content features (and, with --judge, the expert-voice scores),
 * then reports which features correlate with ranking — so you can tune the judge
 * toward what works.
 *
 * !!! READ-ONLY. Makes NO writes to any table. Only prisma findMany/findUnique
 * /count. Safe to run against the live/prod DB. Requires GSC to be connected
 * for the businesses you analyze; --judge additionally needs OPENAI_API_KEY.
 *
 * Usage (from seo-be/):
 *   bun run src/scripts/analyze-ranking-correlation.ts
 *   bun run src/scripts/analyze-ranking-correlation.ts --business <id> --since 180
 *   bun run src/scripts/analyze-ranking-correlation.ts --judge      # include expert-voice dims
 */

import { prisma } from "../config/db.config";
import {
  bucketAverages,
  correlateFeatures,
  spearman,
  type CorrelationRow,
} from "../utils/ranking-correlation.utils";
import {
  buildRankedBlogDataset,
  buildSubstanceForBusiness,
  type RankedBlog,
} from "../services/ranking-dataset.service";
import {
  judgeExpertVoice,
  type ExpertVoiceVerdict,
} from "../services/expert-voice-judge.service";

interface CliOptions {
  businessId?: string;
  limit: number;
  sinceDays: number;
  judge: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { limit: 200, sinceDays: 90, judge: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--business") o.businessId = argv[++i];
    else if (a === "--limit") o.limit = Math.max(1, Number(argv[++i]) || 200);
    else if (a === "--since") o.sinceDays = Math.max(1, Number(argv[++i]) || 90);
    else if (a === "--judge") o.judge = true;
  }
  return o;
}

/** Build the numeric feature map for one blog (+ optional voice verdict). */
export function featuresOf(
  blog: RankedBlog,
  verdict?: ExpertVoiceVerdict,
): Record<string, number> {
  const f: Record<string, number> = {
    words: blog.features.wordCount,
    h2: blog.features.h2Count,
    h3: blog.features.h3Count,
    faq: blog.features.faqCount,
    listItems: blog.features.listItemCount,
    extLinks: blog.features.externalLinkCount,
    intLinks: blog.features.internalLinkCount,
    images: blog.features.imageCount,
    paragraphs: blog.features.paragraphCount,
    hasSchema: blog.features.hasSchema,
  };
  if (blog.seoScore != null) f.seoScore = blog.seoScore;
  if (blog.contentLlmScore != null) f.llmScore = blog.contentLlmScore;
  if (verdict) {
    f.voiceOverall = verdict.overall;
    f.voiceSpecificity = verdict.dimensions.specificity;
    f.voiceOpinions = verdict.dimensions.opinions;
    f.voiceLivedExp = verdict.dimensions.livedExperience;
    f.voiceHedgeFree = verdict.dimensions.hedgingFreedom;
    f.voiceCompetitor = verdict.dimensions.competitorUse;
    f.voiceOffering = verdict.dimensions.offeringUse;
  }
  return f;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function fmt(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(3);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(
    `\n📈 Ranking-correlation analysis (READ-ONLY) — since=${opts.sinceDays}d limit=${opts.limit}` +
      `${opts.businessId ? ` business=${opts.businessId}` : ""}${opts.judge ? " +judge" : ""}\n`,
  );

  const totalPublished = await prisma.blog.count({
    where: {
      status: "PUBLISH",
      ...(opts.businessId ? { businessId: opts.businessId } : {}),
    },
  });

  const dataset = await buildRankedBlogDataset({
    businessId: opts.businessId,
    limit: opts.limit,
    sinceDays: opts.sinceDays,
  });

  console.log(
    `Published blogs: ${totalPublished} · with live URL + GSC data (analyzable): ${dataset.length}`,
  );
  if (dataset.length < 5) {
    console.log(
      "\n⚠️  Fewer than 5 analyzable blogs — correlations won't be meaningful yet.",
    );
    console.log(
      "    Likely causes: GSC not connected, blogs too new to have data, or no GSC sync has run.\n",
    );
    if (dataset.length === 0) {
      await prisma.$disconnect();
      return;
    }
  }

  // Optional: expert-voice judge per blog (substance cached per business).
  const verdicts = new Map<string, ExpertVoiceVerdict>();
  if (opts.judge) {
    console.log("Running expert-voice judge on each blog...");
    const substanceCache = new Map<string, Awaited<ReturnType<typeof buildSubstanceForBusiness>>>();
    for (const blog of dataset) {
      let substance = substanceCache.get(blog.businessId);
      if (!substance) {
        substance = await buildSubstanceForBusiness(blog.businessId);
        substanceCache.set(blog.businessId, substance);
      }
      const verdict = await judgeExpertVoice({
        content: blog.content,
        title: blog.title,
        keyword: blog.focusKeyword || blog.title,
        businessName: substance.businessName,
        competitors: substance.competitors,
        offering: substance.offering,
      });
      verdicts.set(blog.blogId, verdict);
    }
  }

  // Correlate every feature against position (lower=better) and clicks (higher=better).
  const posRows: CorrelationRow[] = dataset.map((b) => ({
    features: featuresOf(b, verdicts.get(b.blogId)),
    outcome: b.outcome.avgPosition,
  }));
  const clickRows: CorrelationRow[] = dataset.map((b) => ({
    features: featuresOf(b, verdicts.get(b.blogId)),
    outcome: b.outcome.clicks,
  }));

  const posCorr = correlateFeatures(posRows);
  const clickCorrMap = new Map(
    correlateFeatures(clickRows).map((c) => [c.feature, c.correlation]),
  );

  console.log(
    `\n${pad("feature", 16)} ${pad("vs position", 12)} ${pad("vs clicks", 12)} n`,
  );
  console.log("-".repeat(48));
  for (const c of posCorr) {
    console.log(
      `${pad(c.feature, 16)} ${pad(fmt(c.correlation), 12)} ${pad(
        fmt(clickCorrMap.get(c.feature) ?? 0),
        12,
      )} ${c.n}`,
    );
  }
  console.log(
    "\nLegend: position is 'lower = better', so a NEGATIVE 'vs position' value means",
    "\nmore of that feature → better rank. clicks is 'higher = better' (positive = good).",
  );

  // Does expert-voice actually track ranking? This is the calibration verdict.
  if (opts.judge) {
    const points = dataset.map((b) => ({
      score: verdicts.get(b.blogId)?.overall ?? 0,
      outcome: b.outcome.avgPosition,
    }));
    const buckets = bucketAverages(points, [
      { label: "voice 0-4", lo: 0, hi: 4 },
      { label: "voice 5-6", lo: 5, hi: 6 },
      { label: "voice 7-8", lo: 7, hi: 8 },
      { label: "voice 9-10", lo: 9, hi: 10 },
    ]);
    console.log("\n🧠 Expert-voice vs avg position (lower position = better):");
    for (const b of buckets) {
      console.log(
        `   ${pad(b.label, 12)} n=${pad(String(b.n), 4)} avg position ${
          b.n > 0 ? b.avgOutcome : "—"
        }`,
      );
    }
    const voiceVsPos = spearman(
      points.map((p) => p.score),
      points.map((p) => p.outcome),
    );
    console.log(`\n   Spearman(voice, position) = ${fmt(voiceVsPos)}`);
    if (voiceVsPos <= -0.2) {
      console.log(
        "   ✅ Expert-voice tracks ranking (higher voice → better position). The judge is a useful proxy.",
      );
    } else if (voiceVsPos >= 0.2) {
      console.log(
        "   ⚠️ Expert-voice INVERSELY relates to ranking here — investigate before trusting the judge.",
      );
    } else {
      console.log(
        "   ⚠️ Weak correlation — the judge may not reflect what ranks. Re-weight it toward the",
        "\n      features that DO correlate above (see BLOG_VOICE_WEIGHTS).",
      );
    }
  }

  console.log(
    "\n💡 Use the strongest correlates above to weight the judge (BLOG_VOICE_WEIGHTS)" +
      "\n   and to decide which structural features the prompt should push harder on.\n",
  );

  await prisma.$disconnect();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Analysis failed:", err);
    process.exit(1);
  });
}
