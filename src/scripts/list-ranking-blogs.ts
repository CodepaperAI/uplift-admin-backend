/**
 * list-ranking-blogs.ts
 *
 * READ-ONLY. Lists which of a business's BLOG pages are actually ranking, using
 * the real Google Search Console data already stored in SearchConsoleMetric
 * (per businessId + date + query + page: clicks / impressions / position).
 *
 * For each /blog/ page it reports impressions, clicks, impression-weighted
 * average position, and the top queries it shows for — sorted by visibility.
 *
 * Usage (from seo-be/):
 *   bun run src/scripts/list-ranking-blogs.ts                 # auto-finds Shawarma Moose / first business
 *   bun run src/scripts/list-ranking-blogs.ts --business <id>
 *   bun run src/scripts/list-ranking-blogs.ts --days 180      # lookback window (default 90)
 */

import { prisma } from "../config/db.config";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Agg {
  impressions: number;
  clicks: number;
  posWeightedSum: number; // Σ position*impressions
  posWeight: number; // Σ impressions
  queries: Map<string, { impressions: number; clicks: number; pw: number; w: number }>;
}

function weightedPos(pw: number, w: number): number {
  return w > 0 ? Math.round((pw / w) * 100) / 100 : 0;
}

async function main() {
  const days = Number(arg("days")) || 90;
  const businessIdArg = arg("business");

  const business = businessIdArg
    ? await prisma.business.findUnique({ where: { id: businessIdArg } })
    : ((await prisma.business.findFirst({
        where: { businessName: { contains: "shawarma", mode: "insensitive" } },
      })) ??
      (await prisma.business.findFirst({
        where: { businessWebsiteUrl: { contains: "shawarmamoose", mode: "insensitive" } },
      })) ??
      (await prisma.business.findFirst({ where: { isActive: true }, orderBy: { createdAt: "desc" } })));

  if (!business) {
    console.log("❌ No business found. Pass --business <id>.");
    await prisma.$disconnect();
    return;
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.searchConsoleMetric.findMany({
    where: {
      businessId: business.id,
      date: { gte: since },
      page: { contains: "/blog/" },
    },
    select: { page: true, query: true, clicks: true, impressions: true, position: true },
  });

  console.log(
    `\n📊 Ranking blogs for "${business.businessName}" — last ${days} days (Search Console)\n`,
  );

  if (rows.length === 0) {
    console.log(
      "No Search Console rows for /blog/ pages.\n" +
        "→ Either GSC isn't connected for this business, the sync hasn't run, or the blogs\n" +
        "  have no impressions yet. Connect/sync GSC, or pass the right --business <id>.",
    );
    await prisma.$disconnect();
    return;
  }

  const byPage = new Map<string, Agg>();
  for (const r of rows) {
    let a = byPage.get(r.page);
    if (!a) {
      a = { impressions: 0, clicks: 0, posWeightedSum: 0, posWeight: 0, queries: new Map() };
      byPage.set(r.page, a);
    }
    a.impressions += r.impressions;
    a.clicks += r.clicks;
    a.posWeightedSum += r.position * r.impressions;
    a.posWeight += r.impressions;
    let q = a.queries.get(r.query);
    if (!q) {
      q = { impressions: 0, clicks: 0, pw: 0, w: 0 };
      a.queries.set(r.query, q);
    }
    q.impressions += r.impressions;
    q.clicks += r.clicks;
    q.pw += r.position * r.impressions;
    q.w += r.impressions;
  }

  const pages = [...byPage.entries()].sort((a, b) => b[1].impressions - a[1].impressions);

  let rankingP1 = 0;
  let striking = 0;
  for (const [page, a] of pages) {
    const avgPos = weightedPos(a.posWeightedSum, a.posWeight);
    const band =
      avgPos > 0 && avgPos <= 3 ? "🟢 top 3" :
      avgPos > 0 && avgPos <= 10 ? "🟢 page 1" :
      avgPos > 0 && avgPos <= 20 ? "🟡 striking distance (p2)" :
      "🔴 far (p3+)";
    if (avgPos > 0 && avgPos <= 10) rankingP1++;
    else if (avgPos > 0 && avgPos <= 20) striking++;

    const slug = page.replace(/^https?:\/\/[^/]+/, "");
    console.log(`${band}  ${slug}`);
    console.log(
      `    impressions ${a.impressions} · clicks ${a.clicks} · avg position ${avgPos}`,
    );
    const topQueries = [...a.queries.entries()]
      .sort((x, y) => y[1].impressions - x[1].impressions)
      .slice(0, 5);
    for (const [q, qa] of topQueries) {
      console.log(
        `      • "${q}" — pos ${weightedPos(qa.pw, qa.w)}, ${qa.impressions} impr, ${qa.clicks} clicks`,
      );
    }
    console.log("");
  }

  console.log(
    `══ ${pages.length} blog pages with search data · ${rankingP1} on page 1, ${striking} in striking distance (p2). ` +
      `Sorted by impressions (visibility).\n`,
  );

  await prisma.$disconnect();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  });
}
