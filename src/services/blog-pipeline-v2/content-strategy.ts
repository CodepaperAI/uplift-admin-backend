import type { PrismaClient } from "@prisma/client";

import { editorialTopicTokens } from "./editorial-quality";
import type { ProductionLinkCandidate } from "./link-selector";

export type SearchConsoleStrategyRow = {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number;
};

export type KeywordCannibalizationPage = {
  page: string;
  clicks: number;
  impressions: number;
  averagePosition: number;
  matchingQueries: string[];
};

export type KeywordCannibalizationAnalysis = {
  risk: "none" | "existing-page" | "competing-pages";
  primaryKeyword: string;
  matchingQueries: string[];
  pages: KeywordCannibalizationPage[];
};

export type ProductionContentStrategyContext = {
  searchConsole: {
    connected: boolean;
    lookbackDays: number;
    cannibalization: KeywordCannibalizationAnalysis;
  };
  cluster: null | {
    id: string;
    name: string;
    description: string | null;
    currentRole: string | null;
    pillarKeyword: string | null;
    siblingCoverage: Array<{
      keyword: string;
      role: string | null;
      title: string | null;
      url: string | null;
    }>;
  };
  planningDirective: string;
};

function querySimilarity(left: string, right: string): number {
  const leftTokens = new Set(editorialTopicTokens(left));
  const rightTokens = new Set(editorialTopicTokens(right));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return Math.max(leftTokens.size, rightTokens.size) > 0
    ? intersection / Math.max(leftTokens.size, rightTokens.size)
    : 0;
}

export function analyzeKeywordCannibalization(
  rows: SearchConsoleStrategyRow[],
  primaryKeyword: string,
): KeywordCannibalizationAnalysis {
  const matching = rows.filter(
    (row) => row.page.trim() && row.query.trim() && querySimilarity(row.query, primaryKeyword) >= 0.67,
  );
  const byPage = new Map<
    string,
    KeywordCannibalizationPage & { positionWeight: number; queries: Set<string> }
  >();
  for (const row of matching) {
    const current = byPage.get(row.page) ?? {
      page: row.page,
      clicks: 0,
      impressions: 0,
      averagePosition: 0,
      matchingQueries: [],
      positionWeight: 0,
      queries: new Set<string>(),
    };
    current.clicks += row.clicks;
    current.impressions += row.impressions;
    current.positionWeight += row.position * row.impressions;
    current.queries.add(row.query);
    byPage.set(row.page, current);
  }
  const pages = [...byPage.values()]
    .map(({ positionWeight, queries, ...page }) => ({
      ...page,
      averagePosition:
        page.impressions > 0
          ? Number((positionWeight / page.impressions).toFixed(2))
          : 0,
      matchingQueries: [...queries].sort(),
    }))
    .sort((left, right) => right.impressions - left.impressions);
  const materialPages = pages.filter((page) => page.impressions >= 10);
  return {
    risk:
      materialPages.length >= 2
        ? "competing-pages"
        : materialPages.length === 1
          ? "existing-page"
          : "none",
    primaryKeyword,
    matchingQueries: [...new Set(matching.map((row) => row.query))].sort(),
    pages,
  };
}

function titleFromUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return (
      url.pathname
        .split("/")
        .filter(Boolean)
        .at(-1)
        ?.replace(/[-_]+/g, " ")
        .trim() || url.hostname
    );
  } catch {
    return raw;
  }
}

function publishedUrl(blog: {
  canonicalUrl?: string | null;
  publishedBlogs?: Array<{ externalPostUrl?: string | null }>;
} | null): string | null {
  return (
    blog?.publishedBlogs?.find((item) => item.externalPostUrl)?.externalPostUrl ??
    blog?.canonicalUrl ??
    null
  );
}

export async function loadProductionContentStrategy(input: {
  prisma: PrismaClient;
  businessId: string;
  userId: string;
  plan: {
    id: string;
    keyword: string;
    clusterId?: string | null;
    clusterRole?: string | null;
  };
  now?: Date;
}): Promise<{
  context: ProductionContentStrategyContext;
  preferredInternalLinks: ProductionLinkCandidate[];
}> {
  const lookbackDays = 90;
  const since = new Date(input.now ?? new Date());
  since.setUTCDate(since.getUTCDate() - lookbackDays);
  const seedToken = editorialTopicTokens(input.plan.keyword)
    .sort((left, right) => right.length - left.length)[0];
  const [analyticsConfig, metrics, cluster] = await Promise.all([
    input.prisma.businessAnalyticsConfig.findUnique({
      where: { businessId: input.businessId },
      select: { gscSiteUrl: true },
    }),
    seedToken
      ? input.prisma.searchConsoleMetric.findMany({
          where: {
            businessId: input.businessId,
            date: { gte: since },
            query: { contains: seedToken, mode: "insensitive" },
          },
          select: {
            query: true,
            page: true,
            clicks: true,
            impressions: true,
            position: true,
          },
          orderBy: { impressions: "desc" },
          take: 5_000,
        })
      : Promise.resolve([]),
    input.plan.clusterId
      ? input.prisma.contentCluster.findFirst({
          where: {
            id: input.plan.clusterId,
            businessId: input.businessId,
            userId: input.userId,
          },
          include: {
            keywords: {
              where: { deletedAt: null, id: { not: input.plan.id } },
              select: {
                keyword: true,
                clusterRole: true,
                blog: {
                  select: {
                    title: true,
                    canonicalUrl: true,
                    publishedBlogs: {
                      where: { externalPostUrl: { not: null } },
                      select: { externalPostUrl: true },
                      take: 1,
                    },
                  },
                },
              },
              orderBy: [{ clusterRole: "asc" }, { publishDate: "asc" }],
            },
          },
        })
      : Promise.resolve(null),
  ]);
  const cannibalization = analyzeKeywordCannibalization(
    metrics as SearchConsoleStrategyRow[],
    input.plan.keyword,
  );
  const siblingCoverage = (cluster?.keywords ?? []).map((item) => ({
    keyword: item.keyword,
    role: item.clusterRole,
    title: item.blog?.title ?? null,
    url: publishedUrl(item.blog),
  }));
  const pillarKeyword =
    cluster?.keywords.find((item) => item.clusterRole === "pillar")?.keyword ??
    (input.plan.clusterRole === "pillar" ? input.plan.keyword : null);
  const planningDirective = [
    `Primary intent: ${input.plan.keyword}.`,
    cluster
      ? `Cluster: ${cluster.name}; current role: ${input.plan.clusterRole ?? "supporting"}; pillar: ${pillarKeyword ?? "not assigned"}. Cover a distinct intent from the listed siblings.`
      : "No persisted topic cluster is assigned. Keep the article tightly scoped to the primary keyword and do not invent a cluster.",
    cannibalization.risk === "competing-pages"
      ? "Search Console shows multiple pages competing for this query. Do not duplicate their reader promise; choose a complementary angle and reinforce the most relevant canonical page with an approved contextual internal link."
      : cannibalization.risk === "existing-page"
        ? "Search Console shows an existing page for this query. Make this article complementary rather than a duplicate and preserve the existing page's primary intent."
        : "Search Console shows no material existing page for this query in the lookback window.",
  ].join(" ");
  const gscCandidates = cannibalization.pages.slice(0, 2).map((page) => ({
    kind: "internal" as const,
    title: page.matchingQueries[0] || titleFromUrl(page.page),
    url: page.page,
    businessId: input.businessId,
    score: Math.min(1, 0.85 + Math.log10(page.impressions + 1) / 10),
  }));
  const clusterCandidates = siblingCoverage
    .filter((item): item is typeof item & { url: string } => Boolean(item.url))
    .map((item) => ({
      kind: "internal" as const,
      title: item.title || item.keyword,
      url: item.url,
      businessId: input.businessId,
      score: 0.9,
    }));
  return {
    context: {
      searchConsole: {
        connected: Boolean(analyticsConfig?.gscSiteUrl),
        lookbackDays,
        cannibalization,
      },
      cluster: cluster
        ? {
            id: cluster.id,
            name: cluster.name,
            description: cluster.description,
            currentRole: input.plan.clusterRole ?? null,
            pillarKeyword,
            siblingCoverage,
          }
        : null,
      planningDirective,
    },
    preferredInternalLinks: [...clusterCandidates, ...gscCandidates],
  };
}
