import { createPrismaClient } from "../config/prisma-client.factory";
/**
 * calibrate-expert-voice.ts
 *
 * Calibration harness for the expert-voice judge. Scores your REAL published
 * blogs with the same judge the critique-revise loop uses, so you can check
 * whether its "expert-grade" bar matches your taste BEFORE enabling the loop in
 * production. This is the linchpin step from the blog-brain design doc.
 *
 * Usage (from seo-be/):
 *   bun run src/scripts/calibrate-expert-voice.ts                 # 10 most recent published blogs
 *   bun run src/scripts/calibrate-expert-voice.ts --limit 25
 *   bun run src/scripts/calibrate-expert-voice.ts --business <businessId>
 *   bun run src/scripts/calibrate-expert-voice.ts --status DRAFT
 *   bun run src/scripts/calibrate-expert-voice.ts --catalog       # also enrich with sitemap products
 *   bun run src/scripts/calibrate-expert-voice.ts --catalog --competitor-products
 *
 * Requires OPENAI_API_KEY because the calibration uses the GPT-5 mini judge.
 * Read-only: it never writes blogs or changes anything.
 */

import { PrismaClient, type STATUS } from "@prisma/client";
import { resolveEffectiveServices } from "../utils/effective-services.utils";
import {
  extractBusinessSubstance,
  type BusinessSubstance,
} from "../utils/blog-substance.utils";
import { enrichSubstanceWithCatalog } from "../services/product-catalog.service";
import {
  judgeExpertVoice,
  type ExpertVoiceVerdict,
} from "../services/expert-voice-judge.service";

export interface CalibrationSummary {
  count: number;
  mean: number;
  min: number;
  max: number;
  /** bar -> how many blogs scored strictly below it. */
  belowBar: Record<number, number>;
}

/** Pure: aggregate overall scores. Unit-tested. */
export function summarizeScores(
  overalls: number[],
  bars: number[] = [6, 7, 8],
): CalibrationSummary {
  const belowBar: Record<number, number> = {};
  for (const b of bars) belowBar[b] = overalls.filter((o) => o < b).length;
  if (overalls.length === 0) {
    return { count: 0, mean: 0, min: 0, max: 0, belowBar };
  }
  const sum = overalls.reduce((a, b) => a + b, 0);
  return {
    count: overalls.length,
    mean: Math.round((sum / overalls.length) * 10) / 10,
    min: Math.min(...overalls),
    max: Math.max(...overalls),
    belowBar,
  };
}

interface CliOptions {
  businessId?: string;
  limit: number;
  status: STATUS;
  catalog: boolean;
  competitorProducts: boolean;
}

/** Pure: parse argv into options. Unit-tested. */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    limit: 10,
    status: "PUBLISH" as STATUS,
    catalog: false,
    competitorProducts: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--business") opts.businessId = argv[++i];
    else if (arg === "--limit") opts.limit = Math.max(1, Number(argv[++i]) || 10);
    else if (arg === "--status") opts.status = (argv[++i] ?? "PUBLISH") as STATUS;
    else if (arg === "--catalog") opts.catalog = true;
    else if (arg === "--competitor-products") opts.competitorProducts = true;
  }
  return opts;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function dimRow(v: ExpertVoiceVerdict): string {
  const d = v.dimensions;
  return `spec ${d.specificity} opi ${d.opinions} liv ${d.livedExperience} hed ${d.hedgingFreedom} cmp ${d.competitorUse} off ${d.offeringUse}`;
}

async function main() {
  const prisma = createPrismaClient();
  const opts = parseArgs(process.argv.slice(2));

  console.log(
    `\n🧪 Expert-voice calibration — status=${opts.status} limit=${opts.limit}` +
      `${opts.businessId ? ` business=${opts.businessId}` : ""}` +
      `${opts.catalog ? " +catalog" : ""}${opts.competitorProducts ? " +competitor-products" : ""}\n`,
  );

  const blogs = await prisma.blog.findMany({
    where: {
      status: opts.status,
      ...(opts.businessId ? { businessId: opts.businessId } : {}),
    },
    include: { meta: true, Plan: true },
    orderBy: { createdAt: "desc" },
    take: opts.limit,
  });

  if (blogs.length === 0) {
    console.log("No blogs found for those filters.");
    await prisma.$disconnect();
    return;
  }

  // Build (and cache) substance per business so we don't rebuild per blog.
  const substanceCache = new Map<string, BusinessSubstance>();
  async function substanceFor(businessId: string): Promise<BusinessSubstance> {
    const cached = substanceCache.get(businessId);
    if (cached) return cached;
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      include: {
        competitiors: true,
        websiteAnalysis: { include: { coreServices: true, businessInfo: true } },
      },
    });
    const effectiveServices = resolveEffectiveServices((business ?? {}) as never);
    const businessInfo = {
      ...(business ?? {}),
      enhancedBusinessInfo: business?.websiteAnalysis?.businessInfo ?? null,
      coreServices: effectiveServices,
      effectiveServices,
    };
    let substance = extractBusinessSubstance(businessInfo);
    if (opts.catalog && business) {
      substance = await enrichSubstanceWithCatalog(substance, {
        userId: business.userId,
        businessId,
        includeCompetitorProducts: opts.competitorProducts,
      });
    }
    substanceCache.set(businessId, substance);
    return substance;
  }

  const rows: { overall: number; title: string; verdict: ExpertVoiceVerdict }[] = [];

  for (const blog of blogs) {
    const substance = await substanceFor(blog.businessId);
    const keyword =
      blog.meta?.focus_keyword || blog.Plan?.[0]?.keyword || blog.title;
    const verdict = await judgeExpertVoice({
      content: blog.content,
      title: blog.title,
      keyword,
      businessName: substance.businessName,
      competitors: substance.competitors,
      offering: substance.offering,
    });
    rows.push({ overall: verdict.overall, title: blog.title, verdict });
    const flag = verdict.errored ? " (judge errored — permissive)" : "";
    console.log(
      `${pad(String(verdict.overall), 4)} | ${pad(dimRow(verdict), 56)} | ${pad(
        blog.title,
        50,
      )}${flag}`,
    );
  }

  const summary = summarizeScores(rows.map((r) => r.overall));
  console.log(
    `\n📊 Summary: ${summary.count} blogs · mean ${summary.mean} · min ${summary.min} · max ${summary.max}`,
  );
  console.log(
    `   Below bar 6: ${summary.belowBar[6]}   below 7: ${summary.belowBar[7]}   below 8: ${summary.belowBar[8]}`,
  );

  // Show the weakest blogs + their critique so you can sanity-check the judge
  // against your own read. If these are NOT the ones you'd call generic, the
  // rubric/bar needs tuning before enabling the loop.
  const weakest = [...rows].sort((a, b) => a.overall - b.overall).slice(0, 3);
  console.log(`\n🔍 Weakest ${weakest.length} (do these match your gut?):`);
  for (const r of weakest) {
    console.log(`\n  ${r.overall}/10 — ${r.title}`);
    for (const c of r.verdict.critique.slice(0, 4)) console.log(`     • ${c}`);
  }

  console.log(
    `\n💡 Pick BLOG_CRITIQUE_BAR just above the scores of the blogs you'd reject.\n`,
  );

  await prisma.$disconnect();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Calibration failed:", err);
    process.exit(1);
  });
}
