import { Prisma, type PrismaClient } from "@prisma/client";

type OnboardingGenerationStateClient = Pick<
  PrismaClient,
  "quickScrapeBusiness"
>;

export type OnboardingV2GenerationErrorStage =
  | "orchestration"
  | "blog"
  | "social";

/**
 * Clear only the recovered stage's error. Blog and social generation run in
 * parallel, so an unconditional clear could erase a newer sibling failure.
 */
export async function clearOnboardingV2GenerationError(
  client: OnboardingGenerationStateClient,
  input: {
    quickBusinessId: string;
    userId: string;
    businessId: string;
    revision: number;
    stage: OnboardingV2GenerationErrorStage;
  },
): Promise<void> {
  await client.quickScrapeBusiness.updateMany({
    where: {
      id: input.quickBusinessId,
      userId: input.userId,
      onboardingV2BusinessId: input.businessId,
      onboardingV2GenerationRevision: input.revision,
      onboardingV2GenerationError: {
        path: ["stage"],
        equals: input.stage,
      },
    },
    data: { onboardingV2GenerationError: Prisma.DbNull },
  });
}
