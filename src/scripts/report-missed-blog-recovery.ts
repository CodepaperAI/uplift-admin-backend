import { createPrismaClient } from "../config/prisma-client.factory";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = createPrismaClient({ log: [] });

type AccessPlan = {
  businessId: string | null;
  business: {
    isActive: boolean;
    websiteSubscription: {
      status: string;
      trialStatus: string;
      trialEndDate: Date | null;
    } | null;
  } | null;
  user: {
    role: string;
    trialStatus: string | null;
    trialEndDate: Date | null;
    Subscription: { status: string } | null;
  };
};

type AccessReason =
  | "eligible"
  | "legacy_no_business_id"
  | "inactive_or_missing_business"
  | "no_current_access";

type AccessSource =
  | "staff_bypass"
  | "website_subscription_active"
  | "website_trial_active"
  | "user_subscription_active"
  | "user_trial_active"
  | "none";

type AccessEvaluation = {
  reason: AccessReason;
  source: AccessSource;
};

type RunSummary = {
  id: string;
  createdAt: string;
  completedAt: string | null;
  status: string;
  finalSaveStatus: string | null;
  provider: string;
  model: string;
  approvedTitle: string | null;
  errorCode: string | null;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function parseDateKey(value: string | undefined, fallback: string): string {
  const resolved = value?.trim() || fallback;
  if (!datePattern.test(resolved)) {
    throw new Error(`Invalid date: ${resolved}; expected YYYY-MM-DD`);
  }
  return resolved;
}

function normalizeKeyword(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function evaluateAccess(plan: AccessPlan, now: Date): AccessEvaluation {
  if (!plan.businessId) return { reason: "legacy_no_business_id", source: "none" };
  if (!plan.business?.isActive) {
    return { reason: "inactive_or_missing_business", source: "none" };
  }

  if (plan.user.role === "ADMIN" || plan.user.role === "SUPERADMIN") {
    return { reason: "eligible", source: "staff_bypass" };
  }

  const websiteSubscription = plan.business.websiteSubscription;
  if (websiteSubscription?.status === "active") {
    return { reason: "eligible", source: "website_subscription_active" };
  }
  if (
    websiteSubscription?.trialStatus === "trialing" &&
    websiteSubscription.trialEndDate !== null &&
    websiteSubscription.trialEndDate > now
  ) {
    return { reason: "eligible", source: "website_trial_active" };
  }

  if (plan.user.Subscription?.status === "active") {
    return { reason: "eligible", source: "user_subscription_active" };
  }

  if (
    plan.user.trialStatus === "active" &&
    plan.user.trialEndDate &&
    plan.user.trialEndDate > now
  ) {
    return { reason: "eligible", source: "user_trial_active" };
  }

  return { reason: "no_current_access", source: "none" };
}

function provisionalContentType(input: {
  keyword: string;
  keywordInstructions: string | null;
  keywordIntent: string | null;
}): string {
  const keyword = input.keyword.toLowerCase();
  const instructions = input.keywordInstructions?.toLowerCase() ?? "";
  const intent = input.keywordIntent?.toLowerCase() ?? "";

  if (/\b(vs\.?|versus|compare|comparison|difference between)\b/.test(keyword)) {
    return "comparison";
  }
  if (/\b(cost|costs|price|prices|pricing|how much|packages?)\b/.test(keyword)) {
    return "cost-or-package-guide";
  }
  if (/\b(how to|steps? to|tutorial)\b/.test(keyword) || instructions.includes("how-to")) {
    return "how-to";
  }
  if (
    /\b(best|top|ideas|ways|tips|mistakes|checklist)\b/.test(keyword) ||
    instructions.includes("list")
  ) {
    return "list-or-checklist";
  }
  if (["commercial", "transactional", "navigational"].includes(intent)) {
    return "service-or-buyer-page";
  }
  if (instructions.includes("review")) return "review";
  return "complete-guide";
}

function getRunKeyword(metadata: unknown): string | null {
  return cleanText(asRecord(metadata).keyword);
}

function runKey(businessId: string | null, keyword: string): string {
  return `${businessId ?? "legacy"}::${normalizeKeyword(keyword)}`;
}

function diagnose(input: {
  accessReason: AccessReason;
  latestRun: RunSummary | null;
  publishDate: string;
  windowStart: string;
}): string {
  if (input.accessReason !== "eligible") return input.accessReason;
  if (!input.latestRun) {
    return input.publishDate < input.windowStart
      ? "eligible_older_backlog_not_attempted_in_window"
      : "eligible_due_not_attempted_in_window";
  }
  if (input.latestRun.status === "RUNNING") return "generation_run_still_or_stale_running";
  if (input.latestRun.status === "FAILED") return "generation_failed";
  if (input.latestRun.status === "BLOCKED") return "generation_blocked_by_fact_gate";
  if (input.latestRun.status === "NEEDS_REVIEW") return "generation_needs_review_not_saved";
  if (input.latestRun.status === "ACCEPTED") return "accepted_run_but_plan_still_unlinked";
  if (input.latestRun.status === "SHADOWED") return "shadow_run_not_persisted";
  return `generation_${input.latestRun.status.toLowerCase()}`;
}

function md(value: unknown): string {
  return String(value ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function html(value: unknown): string {
  return String(value ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const defaultStart = new Date(`${today}T00:00:00.000Z`);
  defaultStart.setUTCDate(defaultStart.getUTCDate() - 3);

  const windowStart = parseDateKey(process.argv[2], defaultStart.toISOString().slice(0, 10));
  const windowEnd = parseDateKey(process.argv[3], today);
  if (windowStart > windowEnd) throw new Error("windowStart must be before windowEnd");

  const outputDir = resolve(
    process.argv[4] ||
      join(process.cwd(), "reports", `missed-blog-recovery-${windowStart}_${windowEnd}`),
  );
  const now = new Date();
  const runFrom = new Date(`${windowStart}T00:00:00.000Z`);

  const [dueMissingPlans, windowPlans, runs] = await Promise.all([
    prisma.plan.findMany({
      where: {
        publishDate: { lte: windowEnd },
        deletedAt: null,
        blogId: null,
      },
      orderBy: [{ publishDate: "asc" }, { publishTime: "asc" }],
      select: {
        id: true,
        keyword: true,
        keywordInstructions: true,
        publishDate: true,
        publishTime: true,
        keywordDiffculty: true,
        keywordSearchVolume: true,
        keywordIntent: true,
        keywordCategory: true,
        keywordSource: true,
        difficultyBucket: true,
        keywordCpc: true,
        selectionMetadata: true,
        businessId: true,
        user: {
          select: {
            role: true,
            trialStatus: true,
            trialEndDate: true,
            Subscription: { select: { status: true } },
          },
        },
        business: {
          select: {
            id: true,
            businessName: true,
            businessType: true,
            businessWebsiteUrl: true,
            businessCity: true,
            businessState: true,
            businessCountry: true,
            isActive: true,
            websiteSubscription: {
              select: {
                status: true,
                trialStatus: true,
                trialEndDate: true,
              },
            },
          },
        },
      },
    }),
    prisma.plan.findMany({
      where: {
        publishDate: { gte: windowStart, lte: windowEnd },
        deletedAt: null,
      },
      select: { id: true, blogId: true, publishDate: true, businessId: true },
    }),
    prisma.blogGenerationRun.findMany({
      where: { createdAt: { gte: runFrom } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        businessId: true,
        createdAt: true,
        completedAt: true,
        status: true,
        finalSaveStatus: true,
        provider: true,
        model: true,
        approvedTitle: true,
        errorCode: true,
        metadata: true,
      },
    }),
  ]);

  const runsByBusinessKeyword = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const keyword = getRunKeyword(run.metadata);
    if (!keyword) continue;
    const key = runKey(run.businessId, keyword);
    const list = runsByBusinessKeyword.get(key) ?? [];
    list.push({
      id: run.id,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      status: run.status,
      finalSaveStatus: run.finalSaveStatus,
      provider: run.provider,
      model: run.model,
      approvedTitle: run.approvedTitle,
      errorCode: run.errorCode,
    });
    runsByBusinessKeyword.set(key, list);
  }

  const rows = dueMissingPlans.map((plan) => {
    const access = evaluateAccess(plan, now);
    const matchedRuns = runsByBusinessKeyword.get(runKey(plan.businessId, plan.keyword)) ?? [];
    const latestRun = matchedRuns.at(-1) ?? null;
    const selection = asRecord(plan.selectionMetadata);

    return {
      planId: plan.id,
      businessId: plan.businessId,
      businessName: plan.business?.businessName ?? "Legacy / no business",
      businessType: plan.business?.businessType ?? null,
      websiteUrl: plan.business?.businessWebsiteUrl ?? null,
      location: [plan.business?.businessCity, plan.business?.businessState, plan.business?.businessCountry]
        .filter(Boolean)
        .join(", ") || null,
      publishDate: plan.publishDate,
      publishTime: plan.publishTime,
      keyword: plan.keyword,
      searchVolume: plan.keywordSearchVolume,
      difficulty: plan.keywordDiffculty,
      difficultyBucket: plan.difficultyBucket,
      cpc: plan.keywordCpc,
      intent: plan.keywordIntent,
      category: plan.keywordCategory,
      source: plan.keywordSource,
      storedContentGuidance: plan.keywordInstructions,
      provisionalContentType: provisionalContentType(plan),
      contentTypeStatus: "provisional_needs_serp_and_existing_url_validation",
      businessContext: {
        service: cleanText(selection.service),
        focusArea: cleanText(selection.focusArea),
        cluster: cleanText(selection.cluster),
        aiAnalysisFeedback:
          cleanText(selection.aiAnalysisFeedback) ?? cleanText(selection.analysisFeedback),
      },
      selectionMetadata: plan.selectionMetadata,
      accessReason: access.reason,
      accessSource: access.source,
      inRecoveryWindow: plan.publishDate >= windowStart,
      matchedRuns,
      latestRun,
      diagnosis: diagnose({
        accessReason: access.reason,
        latestRun,
        publishDate: plan.publishDate,
        windowStart,
      }),
    };
  });

  const recoveryRows = rows.filter((row) => row.accessReason === "eligible");
  const windowRecoveryRows = recoveryRows.filter((row) => row.inRecoveryWindow);
  const olderBacklogRows = recoveryRows.filter((row) => !row.inRecoveryWindow);
  const excludedRows = rows.filter((row) => row.accessReason !== "eligible");
  const windowGenerated = windowPlans.filter((plan) => plan.blogId !== null).length;
  const windowMissing = windowPlans.filter((plan) => plan.blogId === null).length;

  const diagnosisCounts = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.diagnosis] = (acc[row.diagnosis] ?? 0) + 1;
    return acc;
  }, {});
  const businessCounts = recoveryRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.businessName] = (acc[row.businessName] ?? 0) + 1;
    return acc;
  }, {});
  const accessSourceCounts = recoveryRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.accessSource] = (acc[row.accessSource] ?? 0) + 1;
    return acc;
  }, {});
  const windowByDate = Array.from(
    windowPlans.reduce<
      Map<string, { date: string; planned: number; generated: number; missing: number; eligibleMissing: number }>
    >((acc, plan) => {
      const current = acc.get(plan.publishDate) ?? {
        date: plan.publishDate,
        planned: 0,
        generated: 0,
        missing: 0,
        eligibleMissing: 0,
      };
      current.planned += 1;
      if (plan.blogId) current.generated += 1;
      else current.missing += 1;
      acc.set(plan.publishDate, current);
      return acc;
    }, new Map()).values(),
  )
    .map((entry) => ({
      ...entry,
      eligibleMissing: windowRecoveryRows.filter((row) => row.publishDate === entry.date).length,
    }))
    .sort((left, right) => left.date.localeCompare(right.date));

  const businessSummaries = Array.from(
    recoveryRows.reduce<
      Map<
        string,
        {
          businessId: string | null;
          businessName: string;
          websiteUrl: string | null;
          location: string | null;
          accessSource: string;
          count: number;
          dates: Set<string>;
          keywords: string[];
        }
      >>((acc, row) => {
        const key = row.businessId ?? row.businessName;
        const current = acc.get(key) ?? {
          businessId: row.businessId,
          businessName: row.businessName,
          websiteUrl: row.websiteUrl,
          location: row.location,
          accessSource: row.accessSource,
          count: 0,
          dates: new Set<string>(),
          keywords: [],
        };
        current.count += 1;
        current.dates.add(row.publishDate);
        current.keywords.push(row.keyword);
        acc.set(key, current);
        return acc;
      }, new Map()).values(),
  )
    .map((entry) => ({ ...entry, dates: Array.from(entry.dates).sort() }))
    .sort((left, right) => left.businessName.localeCompare(right.businessName));

  const report = {
    generatedAt: now.toISOString(),
    productionReadOnly: true,
    window: { start: windowStart, end: windowEnd },
    summary: {
      windowPlanCount: windowPlans.length,
      windowGenerated,
      windowMissing,
      windowEligibleRecoveryCount: windowRecoveryRows.length,
      olderEligibleBacklogCount: olderBacklogRows.length,
      totalEligibleRecoveryCount: recoveryRows.length,
      eligibleBusinessCount: businessSummaries.length,
      excludedCount: excludedRows.length,
      diagnosisCounts,
      businessCounts,
      accessSourceCounts,
      windowByDate,
    },
    businessSummaries,
    recoveryRows,
    windowRecoveryRows,
    olderBacklogRows,
    excludedRows,
  };

  mkdirSync(outputDir, { recursive: true });
  const jsonPath = join(outputDir, "recovery-manifest.json");
  const markdownPath = join(outputDir, "recovery-list.md");
  const businessSummaryPath = join(outputDir, "business-summary.md");
  const htmlPath = join(outputDir, "index.html");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  const lines: string[] = [
    "# Missed Blog Recovery List",
    "",
    `Generated: ${now.toISOString()}`,
    `Production query: read-only`,
    `Primary recovery window: ${windowStart} through ${windowEnd} (UTC schedule dates)`,
    "",
    "## Summary",
    "",
    `- Planned items in window: ${windowPlans.length}`,
    `- Already linked to blogs: ${windowGenerated}`,
    `- Unlinked/missing in window: ${windowMissing}`,
    `- Eligible missing items in window: ${windowRecoveryRows.length}`,
    `- Eligible older backlog items: ${olderBacklogRows.length}`,
    `- Total eligible recovery candidates: ${recoveryRows.length}`,
    `- Eligible businesses: ${businessSummaries.length}`,
    `- Excluded inactive, legacy, or no-access items: ${excludedRows.length}`,
    "",
    "No blog generation and no production writes were performed.",
    "",
    "## Eligible recovery candidates in the requested window",
    "",
    "| Business | Due | Keyword | Volume | Difficulty | Stored intent | Provisional type | Generation evidence | Diagnosis |",
    "|---|---:|---|---:|---:|---|---|---|---|",
  ];

  for (const row of windowRecoveryRows) {
    lines.push(
      `| ${md(row.businessName)} | ${md(row.publishDate)} | ${md(row.keyword)} | ${md(row.searchVolume)} | ${md(row.difficulty)} | ${md(row.intent)} | ${md(row.provisionalContentType)} | ${md(row.latestRun ? `${row.latestRun.status} ${row.latestRun.errorCode ?? ""}`.trim() : "no matched run")} | ${md(row.diagnosis)} |`,
    );
  }
  if (windowRecoveryRows.length === 0) lines.push("| — | — | No eligible missing items found | — | — | — | — | — | — |");

  lines.push(
    "",
    "## Eligible older backlog",
    "",
    "| Business | Due | Keyword | Volume | Difficulty | Provisional type | Generation evidence | Diagnosis |",
    "|---|---:|---|---:|---:|---|---|---|",
  );
  for (const row of olderBacklogRows) {
    lines.push(
      `| ${md(row.businessName)} | ${md(row.publishDate)} | ${md(row.keyword)} | ${md(row.searchVolume)} | ${md(row.difficulty)} | ${md(row.provisionalContentType)} | ${md(row.latestRun ? `${row.latestRun.status} ${row.latestRun.errorCode ?? ""}`.trim() : "no matched run")} | ${md(row.diagnosis)} |`,
    );
  }
  if (olderBacklogRows.length === 0) lines.push("| — | — | No older eligible backlog found | — | — | — | — | — |");

  lines.push(
    "",
    "## Excluded due-item summary",
    "",
    "These are unlinked plans but are not current recovery candidates under the production scheduler's access rules.",
    "",
    "| Reason | Count |",
    "|---|---:|",
  );
  const excludedCounts = excludedRows.reduce<Record<string, number>>((acc, row) => {
    acc[row.accessReason] = (acc[row.accessReason] ?? 0) + 1;
    return acc;
  }, {});
  for (const [reason, count] of Object.entries(excludedCounts).sort()) {
    lines.push(`| ${md(reason)} | ${count} |`);
  }
  if (excludedRows.length === 0) lines.push("| None | 0 |");

  lines.push(
    "",
    "## Review rule before local generation",
    "",
    "Every provisional type must still pass live SERP-format, existing-URL, business-service, location, and cannibalization checks. This list intentionally does not generate titles or articles.",
    "",
  );
  writeFileSync(markdownPath, `${lines.join("\n")}\n`);

  const businessLines = [
    "# Businesses With Eligible Missing Blogs",
    "",
    `Recovery window: ${windowStart} through ${windowEnd}`,
    `Eligible businesses: ${businessSummaries.length}`,
    `Eligible missing plan items: ${recoveryRows.length}`,
    "",
    "| Business | Missing | Due dates | Access source | Location | Keywords |",
    "|---|---:|---|---|---|---|",
  ];
  for (const business of businessSummaries) {
    businessLines.push(
      `| ${md(business.businessName)} | ${business.count} | ${md(business.dates.join(", "))} | ${md(business.accessSource)} | ${md(business.location)} | ${md(business.keywords.join("; "))} |`,
    );
  }
  writeFileSync(businessSummaryPath, `${businessLines.join("\n")}\n`);

  const dateRows = windowByDate
    .map(
      (entry) =>
        `<tr><td>${html(entry.date)}</td><td>${entry.planned}</td><td>${entry.generated}</td><td>${entry.missing}</td><td>${entry.eligibleMissing}</td></tr>`,
    )
    .join("");
  const businessRows = businessSummaries
    .map(
      (business) =>
        `<tr><td><strong>${html(business.businessName)}</strong><small>${html(business.websiteUrl)}</small></td><td>${business.count}</td><td>${html(business.dates.join(", "))}</td><td>${html(business.accessSource)}</td><td>${html(business.keywords.join("; "))}</td></tr>`,
    )
    .join("");
  const detailRows = recoveryRows
    .map(
      (row) =>
        `<tr><td>${html(row.businessName)}</td><td>${html(row.publishDate)}</td><td><strong>${html(row.keyword)}</strong></td><td>${html(row.searchVolume)}</td><td>${html(row.difficulty)}</td><td>${html(row.intent)}</td><td>${html(row.provisionalContentType)}</td><td>${html(row.accessSource)}</td><td>${html(row.diagnosis)}</td></tr>`,
    )
    .join("");
  const htmlDocument = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Missed Blog Recovery List</title>
<style>body{margin:0;background:#f4f6fa;color:#172033;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:1500px;margin:36px auto;padding:0 24px}header{background:#15243a;color:#fff;padding:32px;border-radius:18px}header p{color:#cbd5e1}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:18px 0}.card,.panel{background:#fff;border:1px solid #e1e6ee;border-radius:14px;padding:20px}.card strong{display:block;font-size:1.8rem}.card span,small{display:block;color:#667085;margin-top:4px}.panel{margin:18px 0;overflow:auto}table{width:100%;border-collapse:collapse;font-size:.82rem}th,td{padding:10px;border-bottom:1px solid #e7ebf1;text-align:left;vertical-align:top}th{position:sticky;top:0;background:#f8fafc}h2{margin-top:0}.notice{background:#fff4ce;color:#7a4b00;padding:14px 18px;border-radius:12px;margin:18px 0}@media(max-width:900px){.cards{grid-template-columns:1fr 1fr}}</style></head>
<body><div class="shell"><header><h1>Missed Blog Recovery List</h1><p>Read-only production audit for ${html(windowStart)} through ${html(windowEnd)}. No blog generation and no production writes.</p></header>
<div class="cards"><div class="card"><strong>${windowPlans.length}</strong><span>planned in window</span></div><div class="card"><strong>${windowGenerated}</strong><span>already generated</span></div><div class="card"><strong>${windowRecoveryRows.length}</strong><span>eligible missing in window</span></div><div class="card"><strong>${businessSummaries.length}</strong><span>eligible businesses</span></div></div>
<div class="notice">Content types are provisional. Every item still needs SERP-format, existing-URL, service-fit, location and cannibalization validation before local generation.</div>
<section class="panel"><h2>Daily production gap</h2><table><thead><tr><th>Date</th><th>Planned</th><th>Generated</th><th>All missing</th><th>Eligible missing</th></tr></thead><tbody>${dateRows}</tbody></table></section>
<section class="panel"><h2>Businesses</h2><table><thead><tr><th>Business</th><th>Missing</th><th>Due dates</th><th>Access source</th><th>Keywords</th></tr></thead><tbody>${businessRows}</tbody></table></section>
<section class="panel"><h2>All eligible recovery candidates</h2><table><thead><tr><th>Business</th><th>Due</th><th>Keyword</th><th>Volume</th><th>Difficulty</th><th>Intent</th><th>Provisional type</th><th>Access</th><th>Diagnosis</th></tr></thead><tbody>${detailRows}</tbody></table></section>
</div></body></html>`;
  writeFileSync(htmlPath, htmlDocument);

  console.log(
    JSON.stringify(
      {
        outputDir,
        jsonPath,
        markdownPath,
        businessSummaryPath,
        htmlPath,
        summary: report.summary,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
