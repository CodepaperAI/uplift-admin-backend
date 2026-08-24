import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.config";
import { majorToMinorExact } from "./money";
import { commandMonthRange, currentCommandMonth } from "./toronto-period";
import {
  MetaAdsReadOnlyClient,
  type MetaAdsInsight,
} from "./meta-ads-readonly.client";
import { invalidateCommandCache } from "../utils/command-cache";

type CampaignSpend = {
  campaignId: string;
  campaignName: string;
  spend: Prisma.Decimal;
};

function monthDates(month: string): { since: string; until: string } {
  const [year, rawMonth] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year!, rawMonth!, 0)).getUTCDate();
  return { since: `${month}-01`, until: `${month}-${String(lastDay).padStart(2, "0")}` };
}

export function aggregateMetaCampaignSpend(
  insights: MetaAdsInsight[],
): CampaignSpend[] {
  const campaigns = new Map<string, CampaignSpend>();
  for (const insight of insights) {
    const campaignId = insight.campaign_id?.trim();
    if (!campaignId) continue;
    let spend: Prisma.Decimal;
    try {
      spend = new Prisma.Decimal(insight.spend?.trim() || "0");
    } catch {
      throw new Error(`Meta Ads returned invalid spend for campaign ${campaignId}`);
    }
    if (spend.isNegative()) {
      throw new Error(`Meta Ads returned negative spend for campaign ${campaignId}`);
    }
    const existing = campaigns.get(campaignId);
    campaigns.set(campaignId, {
      campaignId,
      campaignName:
        insight.campaign_name?.trim() || existing?.campaignName || campaignId,
      spend: (existing?.spend ?? new Prisma.Decimal(0)).plus(spend),
    });
  }
  return [...campaigns.values()].sort((a, b) =>
    a.campaignId.localeCompare(b.campaignId),
  );
}

export async function syncCommandMetaAdsCosts(
  client: MetaAdsReadOnlyClient,
  month = currentCommandMonth(),
) {
  const period = commandMonthRange(month);
  const run = await prisma.commandProviderSyncRun.create({
    data: { provider: "meta_ads", mode: "daily_read_sync" },
    select: { id: true },
  });
  let inspected = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  try {
    const currency = await client.accountCurrency();
    const insights: MetaAdsInsight[] = [];
    let after: string | undefined;
    const { since, until } = monthDates(month);
    for (let page = 0; page < 10_000; page += 1) {
      const result = await client.campaignInsightsPage(since, until, after);
      insights.push(...result.data);
      if (!result.after) break;
      if (result.after === after) {
        throw new Error("Meta Ads insights pagination did not advance");
      }
      after = result.after;
    }
    const campaigns = aggregateMetaCampaignSpend(insights);
    inspected = campaigns.length;
    const sourcePrefix = `meta:${client.adAccountId}:${month}:`;
    const existing = await prisma.commandCostEntry.findMany({
      where: {
        source: "meta_api",
        sourceExternalId: { startsWith: sourcePrefix },
      },
      select: {
        id: true,
        sourceExternalId: true,
        amountMinor: true,
        currency: true,
        description: true,
        deletedAt: true,
      },
    });
    const existingByExternalId = new Map(
      existing.map((row) => [row.sourceExternalId, row]),
    );
    const seen = new Set<string>();
    for (const campaign of campaigns) {
      const sourceExternalId = `${sourcePrefix}${campaign.campaignId}`;
      seen.add(sourceExternalId);
      const amountMinor = new Prisma.Decimal(
        majorToMinorExact(campaign.spend, currency),
      );
      const description = `Meta Ads · ${campaign.campaignName}`;
      const previous = existingByExternalId.get(sourceExternalId);
      const changed =
        !previous ||
        !previous.amountMinor.equals(amountMinor) ||
        previous.currency !== currency ||
        previous.description !== description ||
        previous.deletedAt !== null;
      await prisma.commandCostEntry.upsert({
        where: { sourceExternalId },
        create: {
          category: "acquisition",
          costCategory: "Meta Ads",
          vendor: "Meta",
          source: "meta_api",
          amountMinor,
          currency,
          description,
          occurredAt: period.start,
          sourceExternalId,
        },
        update: {
          category: "acquisition",
          costCategory: "Meta Ads",
          vendor: "Meta",
          amountMinor,
          currency,
          description,
          occurredAt: period.start,
          deletedAt: null,
          updatedByUserId: null,
        },
      });
      if (!previous) created += 1;
      else if (changed) updated += 1;
      else unchanged += 1;
    }
    const staleIds = existing
      .filter(
        (row) =>
          row.sourceExternalId &&
          !seen.has(row.sourceExternalId) &&
          row.deletedAt === null,
      )
      .map((row) => row.id);
    if (staleIds.length > 0) {
      const stale = await prisma.commandCostEntry.updateMany({
        where: { id: { in: staleIds }, source: "meta_api" },
        data: { deletedAt: new Date(), updatedByUserId: null },
      });
      updated += stale.count;
    }
    const result = { inspected, created, updated, unchanged, month, currency };
    await prisma.commandProviderSyncRun.update({
      where: { id: run.id },
      data: { status: "completed", ...result, completedAt: new Date() },
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.commandProviderSyncRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        inspected,
        created,
        updated,
        unchanged,
        error: message.slice(0, 2000),
        completedAt: new Date(),
      },
    });
    throw error;
  } finally {
    await invalidateCommandCache();
  }
}
