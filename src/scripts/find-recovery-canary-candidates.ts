import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import z from "zod";

const prisma = createPrismaClient({ log: [] });

const MANIFEST = z.object({
  generatedAt: z.string(),
  recoveryRows: z.array(
    z.object({
      planId: z.string(),
      businessId: z.string().nullable(),
      businessName: z.string(),
      businessType: z.string().nullable(),
      websiteUrl: z.string().nullable(),
      location: z.string().nullable(),
      publishDate: z.string(),
      keyword: z.string(),
      searchVolume: z.string().nullable(),
      difficulty: z.string().nullable(),
      cpc: z.number().nullable(),
      intent: z.string().nullable(),
      category: z.string().nullable(),
      provisionalContentType: z.string(),
      accessSource: z.string(),
      businessContext: z.unknown().optional(),
      selectionMetadata: z.unknown().optional(),
    }),
  ),
});

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "best",
  "for",
  "from",
  "guide",
  "how",
  "in",
  "is",
  "near",
  "of",
  "on",
  "the",
  "to",
  "what",
  "with",
  "your",
]);

function argumentValue(name: string): string | null {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim() || null;
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

function requiredPath(name: string): string {
  const value = argumentValue(name);
  if (!value) throw new Error(`Missing --${name} <path>`);
  return resolve(value);
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(" ")
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((token) => right.has(token)).length;
  return shared / (left.size + right.size - shared);
}

function numeric(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function main() {
  const manifestPath = requiredPath("manifest");
  const outputPath = requiredPath("output");
  const manifest = MANIFEST.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
  );
  const paidRows = manifest.recoveryRows.filter(
    (row) =>
      row.accessSource === "website_subscription_active" && row.businessId,
  );
  const planIds = paidRows.map((row) => row.planId);
  const businessIds = [
    ...new Set(
      paidRows
        .map((row) => row.businessId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  const [plans, blogs] = await Promise.all([
    prisma.plan.findMany({
      where: { id: { in: planIds } },
      select: {
        id: true,
        keyword: true,
        userId: true,
        businessId: true,
        blogId: true,
        deletedAt: true,
        isUsed: true,
        updatedAt: true,
        business: {
          select: {
            businessName: true,
            businessWebsiteUrl: true,
            isActive: true,
            websiteStatus: true,
            websiteSubscription: {
              select: {
                status: true,
                trialStatus: true,
                currentPeriodEnd: true,
              },
            },
          },
        },
      },
    }),
    prisma.blog.findMany({
      where: { businessId: { in: businessIds } },
      select: {
        id: true,
        businessId: true,
        title: true,
        slug: true,
        canonicalUrl: true,
        meta: { select: { focus_keyword: true } },
        publishedBlogs: {
          select: { externalPostUrl: true, status: true },
        },
      },
    }),
  ]);

  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const blogsByBusiness = new Map<string, typeof blogs>();
  for (const blog of blogs) {
    const list = blogsByBusiness.get(blog.businessId) ?? [];
    list.push(blog);
    blogsByBusiness.set(blog.businessId, list);
  }

  const candidates = paidRows.map((row) => {
    const plan = planById.get(row.planId);
    const businessBlogs = row.businessId
      ? blogsByBusiness.get(row.businessId) ?? []
      : [];
    const keyword = normalize(row.keyword);
    const keywordTokens = tokens(row.keyword);
    const overlaps = businessBlogs
      .map((blog) => {
        const focus = normalize(blog.meta.focus_keyword);
        const title = normalize(blog.title);
        const focusScore = jaccard(keywordTokens, tokens(focus));
        const titleScore = jaccard(keywordTokens, tokens(title));
        const phraseOverlap =
          Boolean(keyword && focus) &&
          (keyword.includes(focus) || focus.includes(keyword));
        const score = Math.max(
          focusScore,
          titleScore * 0.85,
          phraseOverlap ? 0.95 : 0,
        );
        return {
          blogId: blog.id,
          title: blog.title,
          slug: blog.slug,
          focusKeyword: blog.meta.focus_keyword,
          canonicalUrl: blog.canonicalUrl,
          externalUrls: blog.publishedBlogs
            .map((publication) => publication.externalPostUrl)
            .filter((value): value is string => Boolean(value)),
          score: Number(score.toFixed(3)),
        };
      })
      .sort((left, right) => right.score - left.score);
    const maximumOverlap = overlaps[0]?.score ?? 0;
    const selection = asRecord(row.selectionMetadata);
    const activePaid = Boolean(
      plan &&
        plan.businessId === row.businessId &&
        !plan.blogId &&
        !plan.deletedAt &&
        !plan.isUsed &&
        plan.business?.isActive &&
        plan.business.websiteStatus === "active" &&
        plan.business.websiteSubscription?.status === "active" &&
        plan.business.websiteSubscription.trialStatus !== "trialing",
    );
    const lowOverlap = maximumOverlap < 0.4;
    const manageableCorpus = businessBlogs.length <= 35;
    const createCandidate = activePaid && lowOverlap && manageableCorpus;
    const volume = numeric(row.searchVolume);
    const difficulty = numeric(row.difficulty);
    const opportunityScore =
      (createCandidate ? 100 : 0) +
      Math.min(30, Math.log10(Math.max(1, volume ?? 0) + 1) * 10) +
      Math.max(0, 20 - Math.min(20, difficulty ?? 20)) +
      Math.max(0, 10 - businessBlogs.length / 4) -
      maximumOverlap * 40;

    return {
      planId: row.planId,
      userId: plan?.userId ?? null,
      businessId: row.businessId,
      businessName: row.businessName,
      businessType: row.businessType,
      websiteUrl: row.websiteUrl,
      location: row.location,
      publishDate: row.publishDate,
      keyword: row.keyword,
      contentType: row.provisionalContentType,
      intent: row.intent,
      category: row.category,
      metrics: {
        storedSearchVolume: volume,
        storedDifficulty: difficulty,
        storedCpc: row.cpc,
        status: "cached_manifest_not_fresh",
      },
      businessContext: row.businessContext ?? null,
      selectedService:
        typeof selection.selectedService === "string"
          ? selection.selectedService
          : null,
      eligibility: {
        activePaid,
        planFound: Boolean(plan),
        planUnused: Boolean(plan && !plan.blogId && !plan.isUsed),
      },
      existingBlogCount: businessBlogs.length,
      maximumOverlap,
      topOverlapCandidates: overlaps.slice(0, 5),
      createCandidate,
      gates: [
        "fresh Plan and subscription preflight",
        "first-party sitemap and body-level gap review",
        "exact SERP format and demand check",
        "claims, contact, service area and media verification",
      ],
      opportunityScore: Number(opportunityScore.toFixed(2)),
    };
  });

  candidates.sort(
    (left, right) =>
      Number(right.createCandidate) - Number(left.createCandidate) ||
      right.opportunityScore - left.opportunityScore ||
      left.existingBlogCount - right.existingBlogCount,
  );
  const output = {
    schemaVersion: "1.0.0",
    queryMode: "production_read_only",
    generatedAt: new Date().toISOString(),
    sourceManifest: {
      path: manifestPath,
      generatedAt: manifest.generatedAt,
    },
    safety: {
      productionWrites: 0,
      contentGenerated: false,
      paidExternalCalls: 0,
    },
    summary: {
      paidRows: paidRows.length,
      plansFound: plans.length,
      businesses: businessIds.length,
      blogsInspected: blogs.length,
      createCandidates: candidates.filter((candidate) => candidate.createCandidate)
        .length,
      note: "Candidates are only low-overlap shortlists. A first-party body-level and exact-SERP review is still mandatory.",
    },
    candidates,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        outputPath,
        ...output.summary,
        topCandidates: candidates.slice(0, 15).map((candidate) => ({
          planId: candidate.planId,
          business: candidate.businessName,
          keyword: candidate.keyword,
          contentType: candidate.contentType,
          existingBlogCount: candidate.existingBlogCount,
          maximumOverlap: candidate.maximumOverlap,
          score: candidate.opportunityScore,
        })),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
