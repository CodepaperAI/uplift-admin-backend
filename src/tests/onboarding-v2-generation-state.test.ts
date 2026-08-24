import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";

import { clearOnboardingV2GenerationError } from "../utils/onboarding-v2-generation-state";

describe("onboarding-v2 generation state", () => {
  test("clears only the recovered stage for the current revision", async () => {
    const updates: unknown[] = [];
    const prisma = {
      quickScrapeBusiness: {
        updateMany: async (input: unknown) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;

    await clearOnboardingV2GenerationError(prisma, {
      quickBusinessId: "quick-1",
      userId: "user-1",
      businessId: "business-1",
      revision: 4,
      stage: "social",
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      where: {
        id: "quick-1",
        userId: "user-1",
        onboardingV2BusinessId: "business-1",
        onboardingV2GenerationRevision: 4,
        onboardingV2GenerationError: {
          path: ["stage"],
          equals: "social",
        },
      },
    });
  });
});
