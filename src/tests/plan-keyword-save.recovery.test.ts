import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

const persistedDateKeys = new Set<string>();
let createAttemptCount = 0;

const connectMock = mock(async () => {});
const disconnectMock = mock(async () => {});
const findManyMock = mock(
  async ({
    where,
  }: {
    where: {
      userId: string;
      businessId: string | null;
      publishDate: { in: string[] };
    };
  }) => {
    const scopeKey = `${where.userId}::${where.businessId ?? ""}`;

    return where.publishDate.in
      .filter((publishDate) =>
        persistedDateKeys.has(`${scopeKey}::${publishDate}`),
      )
      .map((publishDate) => ({
        publishDate,
      }));
  },
);
const createManyMock = mock(
  async ({
    data,
  }: {
    data: Array<{
      userId: string;
      businessId: string | null;
      publishDate: string;
    }>;
  }) => {
    createAttemptCount += 1;

    if (createAttemptCount === 1) {
      data.forEach((row) => {
        persistedDateKeys.add(
          `${row.userId}::${row.businessId ?? ""}::${row.publishDate}`,
        );
      });

      throw new Error(
        "Error in PostgreSQL connection: Error { kind: Closed, cause: None }",
      );
    }

    return { count: data.length };
  },
);

const createPrismaClientMock = mock(() => ({
  $connect: connectMock,
  $disconnect: disconnectMock,
  plan: {
    findMany: findManyMock,
    createMany: createManyMock,
  },
}));

mock.module("../config/db.config", () => ({
  createPrismaClient: createPrismaClientMock,
}));

describe("savePlanKeywords transient Prisma recovery", () => {
  let savePlanKeywords: typeof import("../utils/plan-keyword-save.utils").savePlanKeywords;

  beforeAll(async () => {
    ({ savePlanKeywords } = await import("../utils/plan-keyword-save.utils"));
  });

  beforeEach(() => {
    persistedDateKeys.clear();
    createAttemptCount = 0;
    connectMock.mockClear();
    disconnectMock.mockClear();
    findManyMock.mockClear();
    createManyMock.mockClear();
    createPrismaClientMock.mockClear();
  });

  it("reconciles rows that were persisted before a transient closed-connection error", async () => {
    const result = await savePlanKeywords([
      {
        keyword: "transient-prisma-recovery-keyword",
        publishDate: "2099-03-01",
        publishTime: "08:00",
        keywordDiffculty: "33",
        keywordSearchVolume: "1200",
        userId: "user-1",
        businessId: "business-1",
      },
    ]);

    expect(result).toMatchObject({
      count: 1,
      skipped: 0,
    });
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(findManyMock).toHaveBeenCalledTimes(2);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(disconnectMock).toHaveBeenCalledTimes(2);
  });
});
