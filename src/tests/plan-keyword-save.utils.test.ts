import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { prisma } from "../config/db.config";
import { savePlanKeywords } from "../utils/plan-keyword-save.utils";

describe("savePlanKeywords provenance fields", () => {
  let testUserId = "";
  const keyword = `selection-metadata-test-${Date.now()}`;
  const publishDate = "2099-02-01";

  beforeAll(async () => {
    const user = await prisma.user.findFirst({
      select: { id: true },
    });

    if (!user) {
      throw new Error("No user available for plan-keyword-save test");
    }

    testUserId = user.id;
  });

  afterAll(async () => {
    await prisma.plan
      .deleteMany({
        where: {
          keyword,
          userId: testUserId,
        },
      })
      .catch(() => {});
  });

  it("persists keyword source, difficulty bucket, and selection metadata", async () => {
    const result = await savePlanKeywords([
      {
        keyword,
        publishDate,
        publishTime: "08:00",
        keywordDiffculty: "38",
        keywordSearchVolume: "880",
        userId: testUserId,
        businessId: null,
        keywordSource: "gap",
        difficultyBucket: "easy",
        selectionMetadata: {
          selectedService: "Family Law",
          focusArea: "Family Law",
          sourceType: "gap",
          allSources: ["gap"],
          sourceLabel: "competitor-gap",
          originSeeds: ["family law consultation"],
          aiReason: "High relevance and clear blog intent",
          aiRelevanceScore: 0.92,
          refinementRound: 1,
          metricsSnapshot: {
            searchVolume: 880,
            difficulty: 38,
            competition: 0.27,
            cpc: 6.15,
            monthlySearches: 880,
            clicks: null,
            impressions: null,
            ctr: null,
          },
        },
      },
    ]);

    expect(result.count).toBe(1);

    const saved = await prisma.plan.findFirst({
      where: {
        keyword,
        userId: testUserId,
        publishDate,
      },
      select: {
        keywordSource: true,
        difficultyBucket: true,
        selectionMetadata: true,
      },
    });

    expect(saved?.keywordSource).toBe("gap");
    expect(saved?.difficultyBucket).toBe("easy");
    expect(saved?.selectionMetadata).toBeTruthy();
    expect((saved?.selectionMetadata as any)?.selectedService).toBe(
      "Family Law",
    );
  });
});
