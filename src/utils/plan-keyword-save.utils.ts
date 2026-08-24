import { Prisma, type PrismaClient } from "@prisma/client";
import { createPrismaClient } from "../config/db.config";
import {
  getPrismaErrorMessage,
  runWithTransientPrismaRetry,
} from "./prisma-resilience.utils";

export type PlanKeywordSaveItem = {
  keyword: string;
  publishDate: string;
  publishTime: string;
  keywordDiffculty: string;
  keywordSearchVolume: string;
  userId: string;
  businessId?: string | null;
  keywordCategory?: string | null;
  keywordIntent?: string | null;
  keywordSource?: string | null;
  difficultyBucket?: string | null;
  selectionMetadata?:
    | Prisma.InputJsonValue
    | Prisma.NullableJsonNullValueInput
    | null;
  keywordCpc?: number | null;
  keywordCompetition?: number | null;
  keywordTrend?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | null;
  keywordMonthlySearches?: number | null;
  keywordClicks?: number | null;
  keywordImpressions?: number | null;
  keywordCTR?: number | null;
  keywordLowTopOfPageBid?: number | null;
  keywordHighTopOfPageBid?: number | null;
  keywordDataUpdatedAt?: string | Date | null;
  clusterId?: string;
  clusterRole?: string;
};

export type PlanKeywordSaveSkip = {
  keyword: string;
  date: string;
  reason: string;
};

export type PlanKeywordSaveResult = {
  count: number;
  skipped: number;
  skippedDetails: PlanKeywordSaveSkip[];
};

type PreparedPlanKeywordSaveItem = PlanKeywordSaveItem & {
  userId: string;
  businessId: string | null;
  scopeKey: string;
  dateKey: string;
};

function getScopeKey(userId: string, businessId?: string | null) {
  return `${userId}::${businessId ?? ""}`;
}

async function disconnectRetryPrismaClient(
  dbClient: PrismaClient,
  operationName: string,
): Promise<void> {
  try {
    await dbClient.$disconnect();
  } catch (error) {
    console.warn(
      `[PlanKeywordSave] Failed to disconnect retry Prisma client for ${operationName}: ${getPrismaErrorMessage(
        error,
      )}`,
    );
  }
}

async function fetchExistingDateKeys(
  dbClient: PrismaClient,
  dateGroups: Map<
    string,
    { userId: string; businessId: string | null; dates: Set<string> }
  >,
): Promise<Set<string>> {
  const existingDateKeys = new Set<string>();

  for (const group of dateGroups.values()) {
    const existingRows = await dbClient.plan.findMany({
      where: {
        userId: group.userId,
        businessId: group.businessId,
        deletedAt: null,
        publishDate: {
          in: Array.from(group.dates),
        },
      },
      select: {
        publishDate: true,
      },
    });

    for (const row of existingRows) {
      existingDateKeys.add(
        getScopeKey(group.userId, group.businessId) + `::${row.publishDate}`,
      );
    }
  }

  return existingDateKeys;
}

export async function savePlanKeywords(
  items: PlanKeywordSaveItem[],
): Promise<PlanKeywordSaveResult> {
  const skipped: PlanKeywordSaveSkip[] = [];

  if (items.length === 0) {
    return { count: 0, skipped: 0, skippedDetails: skipped };
  }

  const preparedItems: PreparedPlanKeywordSaveItem[] = [];
  const dateGroups = new Map<
    string,
    { userId: string; businessId: string | null; dates: Set<string> }
  >();

  for (const item of items) {
    const userId = item.userId?.trim();
    if (!userId) {
      skipped.push({
        keyword: item.keyword,
        date: item.publishDate,
        reason: "Missing userId",
      });
      continue;
    }

    const scopeKey = getScopeKey(userId, item.businessId ?? null);
    const group = dateGroups.get(scopeKey) ?? {
      userId,
      businessId: item.businessId ?? null,
      dates: new Set<string>(),
    };
    group.dates.add(item.publishDate);
    dateGroups.set(scopeKey, group);
    preparedItems.push({
      ...item,
      userId,
      businessId: item.businessId ?? null,
      scopeKey,
      dateKey: `${scopeKey}::${item.publishDate}`,
    });
  }

  if (preparedItems.length === 0) {
    return { count: 0, skipped: skipped.length, skippedDetails: skipped };
  }

  let baselineExistingDateKeys: Set<string> | null = null;

  const saveOutcome = await runWithTransientPrismaRetry(
    async () => {
      const dbClient = createPrismaClient();

      try {
        await dbClient.$connect();

        const currentExistingDateKeys = await fetchExistingDateKeys(
          dbClient,
          dateGroups,
        );

        if (baselineExistingDateKeys === null) {
          baselineExistingDateKeys = new Set(currentExistingDateKeys);
        }

        const seenBatchDateKeys = new Set<string>();
        const effectivePersistedDateKeys = new Set<string>();
        const createData: Prisma.PlanCreateManyInput[] = [];
        const createDateKeys: string[] = [];

        for (const item of preparedItems) {
          if (baselineExistingDateKeys.has(item.dateKey)) {
            continue;
          }

          if (seenBatchDateKeys.has(item.dateKey)) {
            continue;
          }

          seenBatchDateKeys.add(item.dateKey);

          if (currentExistingDateKeys.has(item.dateKey)) {
            effectivePersistedDateKeys.add(item.dateKey);
            continue;
          }

          createDateKeys.push(item.dateKey);
          createData.push({
            keyword: item.keyword,
            publishDate: item.publishDate,
            publishTime: item.publishTime,
            keywordDiffculty: item.keywordDiffculty,
            keywordSearchVolume: item.keywordSearchVolume,
            userId: item.userId,
            businessId: item.businessId,
            keywordCategory: item.keywordCategory ?? null,
            keywordIntent: item.keywordIntent ?? null,
            keywordSource: item.keywordSource ?? null,
            difficultyBucket: item.difficultyBucket ?? null,
            selectionMetadata: item.selectionMetadata ?? Prisma.JsonNull,
            keywordCpc: item.keywordCpc ?? null,
            keywordCompetition: item.keywordCompetition ?? null,
            keywordTrend: item.keywordTrend ?? Prisma.JsonNull,
            keywordMonthlySearches: item.keywordMonthlySearches ?? null,
            keywordClicks: item.keywordClicks ?? null,
            keywordImpressions: item.keywordImpressions ?? null,
            keywordCTR: item.keywordCTR ?? null,
            keywordLowTopOfPageBid: item.keywordLowTopOfPageBid ?? null,
            keywordHighTopOfPageBid: item.keywordHighTopOfPageBid ?? null,
            keywordDataUpdatedAt: item.keywordDataUpdatedAt
              ? new Date(item.keywordDataUpdatedAt)
              : null,
            clusterId: item.clusterId ?? null,
            clusterRole: item.clusterRole ?? null,
          });
        }

        if (createData.length > 0) {
          const result = await dbClient.plan.createMany({
            data: createData,
          });

          if (result.count !== createData.length) {
            console.warn(
              `[PlanKeywordSave] Expected to create ${createData.length} rows but Prisma reported ${result.count}.`,
            );
          }

          createDateKeys.forEach((dateKey) => {
            effectivePersistedDateKeys.add(dateKey);
          });
        }

        return {
          persistedDateKeys: effectivePersistedDateKeys,
        };
      } finally {
        await disconnectRetryPrismaClient(dbClient, "savePlanKeywords");
      }
    },
    {
      operationName: "savePlanKeywords",
      maxAttempts: 3,
      retryDelayMs: 250,
      onRetry: ({ attempt, nextAttempt, error }) => {
        console.warn(
          `[PlanKeywordSave] Transient Prisma connection error on attempt ${attempt}; retrying attempt ${nextAttempt}. ${getPrismaErrorMessage(
            error,
          )}`,
        );
      },
    },
  );

  const finalExistingDateKeys = baselineExistingDateKeys ?? new Set<string>();
  const finalizedBatchDateKeys = new Set<string>();

  for (const item of preparedItems) {
    if (finalExistingDateKeys.has(item.dateKey)) {
      skipped.push({
        keyword: item.keyword,
        date: item.publishDate,
        reason: "Date already exists",
      });
      continue;
    }

    if (finalizedBatchDateKeys.has(item.dateKey)) {
      skipped.push({
        keyword: item.keyword,
        date: item.publishDate,
        reason: "Duplicate date in batch",
      });
      continue;
    }

    finalizedBatchDateKeys.add(item.dateKey);

    if (!saveOutcome.persistedDateKeys.has(item.dateKey)) {
      skipped.push({
        keyword: item.keyword,
        date: item.publishDate,
        reason: "Keyword was not persisted after retries",
      });
    }
  }

  return {
    count: saveOutcome.persistedDateKeys.size,
    skipped: skipped.length,
    skippedDetails: skipped,
  };
}
