import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import Stripe from "stripe";

const prisma = createPrismaClient();
const REPORT_DATE = new Date().toISOString().slice(0, 10);
const REPORT_DIR = join(process.cwd(), "reports");
const DATAFORSEO_API_URL = "https://api.dataforseo.com/v3";
const INCLUDE_INTERNAL_QUERIES = process.argv.includes(
  "--include-internal-queries",
);
const SKIP_STRIPE = process.argv.includes("--skip-stripe");
const LIVE_PRODUCTION = process.argv.includes("--live-production");

const LOCATION_BY_DOMAIN: Record<string, { code: number; label: string }> = {
  "everestplumbing.ca": { code: 1002451, label: "Toronto, Ontario, Canada" },
  "thehamiltonplumber.ca": { code: 1002287, label: "Hamilton, Ontario, Canada" },
  "vikramlaw.ca": { code: 1002451, label: "Toronto, Ontario, Canada" },
  "palacioeventcentre.com": {
    code: 1002350,
    label: "Mississauga, Ontario, Canada",
  },
};

const COUNTRY_LOCATIONS = {
  canada: { code: 2124, label: "Canada" },
  unitedStates: { code: 2840, label: "United States" },
  australia: { code: 2036, label: "Australia" },
  unitedKingdom: { code: 2826, label: "United Kingdom" },
  unitedArabEmirates: { code: 2784, label: "United Arab Emirates" },
  panama: { code: 2591, label: "Panama" },
} as const;

type QuerySource = "target_keyword" | "blog_focus_keyword" | "domain_discovery";

type CandidateQuery = {
  keyword: string;
  sources: Set<QuerySource>;
};

type RankingEvidence = {
  keyword: string;
  sources: QuerySource[];
  position: number;
  absolutePosition: number | null;
  title: string;
  url: string;
  pageType: "blog" | "other";
  matchedBlogTitle: string | null;
  matchedBlogSlug: string | null;
  searchVolume: number | null;
  checkedAt: string;
  location: string;
  googleProofUrl: string | null;
  pageHttpStatus: number | null;
  pageReachable: boolean;
};

function cleanDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0] ?? "";
}

function inferGoogleLocation(business: {
  businessWebsiteUrl: string;
  businessCity: string | null;
  businessState: string | null;
  businessCountry: string | null;
  serviceAreaLocations: string[];
}) {
  const domain = cleanDomain(business.businessWebsiteUrl);
  const text = [
    business.businessCity,
    business.businessState,
    business.businessCountry,
    ...business.serviceAreaLocations,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (domain.endsWith(".com.au") || /\baustralia\b|\bnsw\b/.test(text)) {
    return COUNTRY_LOCATIONS.australia;
  }
  if (/\bpanama\b/.test(text)) return COUNTRY_LOCATIONS.panama;
  if (/\buae\b|\bdubai\b|united arab emirates/.test(text)) {
    return COUNTRY_LOCATIONS.unitedArabEmirates;
  }
  if (
    domain.endsWith(".co.uk") ||
    /united kingdom|\buk\b|\bengland\b|\bscotland\b|\bwales\b/.test(text)
  ) {
    return COUNTRY_LOCATIONS.unitedKingdom;
  }
  if (
    /united states|\busa\b|\b(tx|tn|fl|ga|nh|ny|mi|ca|wa|il|nj|pa|oh|nc|sc|az|co)\b/.test(
      text,
    ) &&
    !domain.endsWith(".ca")
  ) {
    return COUNTRY_LOCATIONS.unitedStates;
  }
  return COUNTRY_LOCATIONS.canada;
}

function normalizeUrlPath(value: string): string {
  try {
    return new URL(value).pathname.toLowerCase().replace(/^\/+|\/+$/g, "");
  } catch {
    return "";
  }
}

function dataForSEOTarget(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    return path ? `${url.hostname.replace(/^www\./, "")}/${path}` : url.hostname.replace(/^www\./, "");
  } catch {
    return cleanDomain(value);
  }
}

function matchesBusinessWebsite(resultUrl: string, businessWebsiteUrl: string) {
  try {
    const result = new URL(resultUrl);
    const business = new URL(businessWebsiteUrl);
    if (cleanDomain(result.hostname) !== cleanDomain(business.hostname)) {
      return false;
    }
    const businessPath = business.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!businessPath) return true;
    const resultPath = result.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    return resultPath === businessPath || resultPath.startsWith(`${businessPath}/`);
  } catch {
    return false;
  }
}

function dataForSEOAuth(): string {
  if (process.env.DATAFORSEO_BASE64) {
    return `Basic ${process.env.DATAFORSEO_BASE64}`;
  }
  const username = process.env.DATAFORSEO_USERNAME ?? "";
  const password = process.env.DATAFORSEO_PASSWORD ?? "";
  if (!username || !password) {
    throw new Error("DataForSEO credentials are not configured.");
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function dataForSEOPost(path: string, payload: unknown[]) {
  const response = await fetch(`${DATAFORSEO_API_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: dataForSEOAuth(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || data?.status_code !== 20000) {
    throw new Error(
      `DataForSEO ${path} failed: HTTP ${response.status}, ${data?.status_message ?? "unknown error"}`,
    );
  }
  return data;
}

async function discoverTop10Keywords(target: string, locationCode: number) {
  const data = await dataForSEOPost(
    "/dataforseo_labs/google/ranked_keywords/live",
    [
      {
        target,
        location_code: locationCode,
        language_code: "en",
        limit: 1000,
        include_subdomains: true,
        filters: [["ranked_serp_element.serp_item.rank_group", "<=", 10]],
        order_by: ["ranked_serp_element.serp_item.rank_group,asc"],
      },
    ],
  );
  const task = data.tasks?.[0];
  if (task?.status_code !== 20000) {
    throw new Error(task?.status_message ?? "Domain discovery failed");
  }
  return (task?.result?.[0]?.items ?? [])
    .map((item: any) => ({
      keyword: String(item?.keyword_data?.keyword ?? "").trim(),
      searchVolume:
        typeof item?.keyword_data?.keyword_info?.search_volume === "number"
          ? item.keyword_data.keyword_info.search_volume
          : null,
    }))
    .filter((item: { keyword: string }) => item.keyword.length > 0);
}

async function checkLiveSERPs(
  queries: CandidateQuery[],
  locationCode: number,
) {
  const results: Array<{ query: CandidateQuery; task: any }> = [];
  const batchSize = 100;
  for (let start = 0; start < queries.length; start += batchSize) {
    const batch = queries.slice(start, start + batchSize);
    const data = await dataForSEOPost(
      "/serp/google/organic/live/advanced",
      batch.map((query) => ({
        keyword: query.keyword,
        location_code: locationCode,
        language_code: "en",
        depth: 20,
        device: "desktop",
        os: "windows",
      })),
    );
    for (let index = 0; index < batch.length; index += 1) {
      results.push({ query: batch[index]!, task: data.tasks?.[index] });
    }
  }
  return results;
}

async function checkPage(url: string) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "Uplift-AI-Ranking-Audit/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    return { status: response.status, reachable: response.ok };
  } catch {
    return { status: null, reachable: false };
  }
}

function addCandidate(
  map: Map<string, CandidateQuery>,
  keyword: string,
  source: QuerySource,
) {
  const clean = keyword.trim().replace(/\s+/g, " ");
  if (!clean) return;
  const key = clean.toLowerCase();
  const existing = map.get(key);
  if (existing) {
    existing.sources.add(source);
  } else {
    map.set(key, { keyword: clean, sources: new Set([source]) });
  }
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function asCsv(rows: any[]): string {
  const columns = [
    "business",
    "domain",
    "keyword",
    "position",
    "absolutePosition",
    "pageType",
    "title",
    "rankingUrl",
    "sources",
    "searchVolume",
    "location",
    "checkedAt",
    "pageHttpStatus",
    "pageReachable",
    "googleProofUrl",
  ];
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ].join("\n");
}

async function main() {
  const businesses = await prisma.business.findMany({
    where: {
      isActive: true,
      websiteSubscription: {
        status: "active",
        trialStatus: { notIn: ["trialing", "expired"] },
      },
    },
    select: {
      id: true,
      businessName: true,
      businessWebsiteUrl: true,
      businessCity: true,
      businessState: true,
      businessCountry: true,
      serviceAreaLocations: true,
      keywords: { select: { keyword: true, keywordType: true } },
      Blog: {
        select: {
          title: true,
          slug: true,
          status: true,
          blogPublishDate: true,
          meta: { select: { focus_keyword: true } },
          publishedBlogs: {
            select: {
              status: true,
              externalPostUrl: true,
              publishedAt: true,
              platform: true,
            },
          },
        },
      },
      websiteSubscription: {
        select: {
          stripeSubscriptionId: true,
          status: true,
          trialStatus: true,
          currentPeriodEnd: true,
        },
      },
    },
    orderBy: { businessName: "asc" },
  });

  const stripe = !SKIP_STRIPE && process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;
  const checkedAt = new Date().toISOString();
  const reports: any[] = [];

  for (const business of businesses) {
    const domain = cleanDomain(business.businessWebsiteUrl);
    const location =
      LOCATION_BY_DOMAIN[domain] ?? inferGoogleLocation(business);
    let liveStripe: any = null;
    let stripeError: string | null = null;
    if (stripe && business.websiteSubscription?.stripeSubscriptionId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(
          business.websiteSubscription.stripeSubscriptionId,
        );
        liveStripe = {
          status: subscription.status,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
        };
      } catch (error) {
        stripeError = error instanceof Error ? error.message : String(error);
      }
    }

    console.log(`[ranking-audit] Starting ${business.businessName} (${domain})`);
    const discovered = await discoverTop10Keywords(
      dataForSEOTarget(business.businessWebsiteUrl),
      location.code,
    );
    const searchVolumeByKeyword = new Map<string, number | null>(
      discovered.map((item: any) => [
        item.keyword.toLowerCase(),
        typeof item.searchVolume === "number" ? item.searchVolume : null,
      ]),
    );
    const candidates = new Map<string, CandidateQuery>();
    if (INCLUDE_INTERNAL_QUERIES) {
      for (const keyword of business.keywords) {
        addCandidate(candidates, keyword.keyword, "target_keyword");
      }
      for (const blog of business.Blog) {
        addCandidate(candidates, blog.meta.focus_keyword, "blog_focus_keyword");
      }
    }
    for (const item of discovered) {
      addCandidate(candidates, item.keyword, "domain_discovery");
    }

    const liveChecks = [
      {
        locationCode: location.code,
        locationLabel: location.label,
        results: await checkLiveSERPs([...candidates.values()], location.code),
      },
    ];
    const evidence: RankingEvidence[] = [];
    for (const liveCheck of liveChecks) {
      for (const { query, task } of liveCheck.results) {
        const result = task?.result?.[0];
        const organicItems = (result?.items ?? []).filter(
          (item: any) => item?.type === "organic" && item?.rank_group <= 10,
        );
        const match = organicItems.find((item: any) =>
          matchesBusinessWebsite(item?.url ?? "", business.businessWebsiteUrl),
        );
        if (!match) continue;

        const path = normalizeUrlPath(match.url);
        const matchedBlog = business.Blog.find((blog) => {
          const slug = blog.slug.toLowerCase().replace(/^\/+|\/+$/g, "");
          return path === slug || path.endsWith(`/${slug}`);
        });
        const isBlog =
          Boolean(matchedBlog) ||
          path.startsWith("blog/") ||
          String(match.breadcrumb ?? "").toLowerCase().includes("blog");
        const page = await checkPage(match.url);
        evidence.push({
          keyword: query.keyword,
          sources: [...query.sources].sort(),
          position: match.rank_group,
          absolutePosition:
            typeof match.rank_absolute === "number" ? match.rank_absolute : null,
          title: match.title ?? "",
          url: match.url,
          pageType: isBlog ? "blog" : "other",
          matchedBlogTitle: matchedBlog?.title ?? null,
          matchedBlogSlug: matchedBlog?.slug ?? null,
          searchVolume:
            searchVolumeByKeyword.get(query.keyword.toLowerCase()) ?? null,
          checkedAt,
          location: liveCheck.locationLabel,
          googleProofUrl: result?.check_url ?? null,
          pageHttpStatus: page.status,
          pageReachable: page.reachable,
        });
      }
    }

    evidence.sort((a, b) => a.position - b.position || a.keyword.localeCompare(b.keyword));
    reports.push({
      businessId: business.id,
      businessName: business.businessName,
      website: business.businessWebsiteUrl,
      domain,
      location,
      billing: {
        database: business.websiteSubscription,
        stripe: liveStripe,
        stripeError,
      },
      inventory: {
        auditMode: INCLUDE_INTERNAL_QUERIES ? "internal_complete" : "public_only",
        targetKeywords: business.keywords.length,
        blogsMarkedPublish: business.Blog.filter((blog) => blog.status === "PUBLISH").length,
        blogsWithPublishedBlogRecord: business.Blog.filter(
          (blog) => blog.publishedBlogs.length > 0,
        ).length,
        uniqueQueriesChecked: candidates.size,
        discoveredTop10Candidates: discovered.length,
      },
      top10: evidence,
      summary: {
        verifiedTop10Keywords: new Set(
          evidence.map((item) => item.keyword.toLowerCase()),
        ).size,
        verifiedRankingBlogs: new Set(
          evidence.filter((item) => item.pageType === "blog").map((item) => item.url),
        ).size,
        verifiedReachableRankingPages: evidence.filter((item) => item.pageReachable).length,
      },
    });
    console.log(
      `[ranking-audit] Completed ${business.businessName}: ${evidence.length} verified rows`,
    );
  }

  const flatRows = reports.flatMap((report) =>
    report.top10.map((item: RankingEvidence) => ({
      business: report.businessName,
      domain: report.domain,
      keyword: item.keyword,
      position: item.position,
      absolutePosition: item.absolutePosition,
      pageType: item.pageType,
      title: item.title,
      rankingUrl: item.url,
      sources: item.sources.join("|"),
      searchVolume: item.searchVolume,
      location: item.location,
      checkedAt: item.checkedAt,
      pageHttpStatus: item.pageHttpStatus,
      pageReachable: item.pageReachable,
      googleProofUrl: item.googleProofUrl,
    })),
  );

  const markdown = [
    `# Paid business Google ranking audit — ${REPORT_DATE}`,
    "",
    `Fresh desktop organic SERPs checked at ${checkedAt}. Positions are Google organic rank-group positions 1–10 in each business city. Audit mode: ${INCLUDE_INTERNAL_QUERIES ? "internal target and blog queries plus public discovery" : "public domain discovery only; private stored target/blog queries were not transmitted"}.`,
    "",
    ...reports.flatMap((report) => [
      `## ${report.businessName}`,
      "",
      `- Website: ${report.website}`,
      `- Billing: database ${report.billing.database?.status ?? "unknown"}; Stripe ${report.billing.stripe?.status ?? `unverified (${report.billing.stripeError ?? "not configured"})`}`,
      `- Scope: ${report.inventory.targetKeywords} target keywords, ${report.inventory.blogsMarkedPublish} blogs marked PUBLISH, ${report.inventory.uniqueQueriesChecked} unique live queries`,
      `- Verified: ${report.summary.verifiedTop10Keywords} top-10 keywords; ${report.summary.verifiedRankingBlogs} ranking blog queries`,
      "",
      "| Pos. | Keyword | Page | Type | Proof |",
      "|---:|---|---|---|---|",
      ...report.top10.map(
        (item: RankingEvidence) =>
          `| ${item.position} | ${item.keyword.replaceAll("|", "\\|")} | [${item.title.replaceAll("|", "\\|")}](${item.url}) | ${item.pageType} | [Google SERP](${item.googleProofUrl}) |`,
      ),
      "",
    ]),
  ].join("\n");

  await mkdir(REPORT_DIR, { recursive: true });
  const base = join(
    REPORT_DIR,
    `paid-business-ranking-audit${LIVE_PRODUCTION ? "-live-prod" : ""}-${REPORT_DATE}`,
  );
  await Promise.all([
    writeFile(`${base}.json`, JSON.stringify({ generatedAt: checkedAt, reports }, null, 2)),
    writeFile(`${base}.csv`, asCsv(flatRows)),
    writeFile(`${base}.md`, markdown),
  ]);
  console.log(
    JSON.stringify(
      {
        generatedAt: checkedAt,
        files: [`${base}.json`, `${base}.csv`, `${base}.md`],
        businesses: reports.map((report) => ({
          business: report.businessName,
          billing: report.billing,
          inventory: report.inventory,
          summary: report.summary,
        })),
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
