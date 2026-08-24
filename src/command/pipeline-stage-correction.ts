import { z } from "zod";

export const COMMAND_PIPELINE_STAGE_CORRECTION_INPUT = z
  .object({
    stageId: z.string().trim().min(1).max(255),
    stageName: z.string().trim().min(1).max(255),
    stageIndex: z.number().int().min(0).nullable(),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict();

export type CommandPipelineStageCorrection = {
  stageId: string;
  stageName: string;
  stageIndex: number | null;
};

export function parseCommandPipelineStageCorrection(
  value: unknown,
): CommandPipelineStageCorrection | null {
  const parsed = COMMAND_PIPELINE_STAGE_CORRECTION_INPUT.omit({ reason: true })
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function adjustCommandPipelineStageGroups(input: {
  groups: readonly {
    stageId: string;
    stageName: string;
    stageIndex: number | null;
    count: number;
  }[];
  correctedOpportunities: readonly {
    pipelineStageId: string;
    pipelineStageName: string | null;
    pipelineStageIndex: number | null;
    correction: CommandPipelineStageCorrection;
  }[];
}) {
  const counts = new Map(
    input.groups.map((group) => [group.stageId, { ...group }]),
  );

  for (const opportunity of input.correctedOpportunities) {
    const original = counts.get(opportunity.pipelineStageId);
    if (original) original.count = Math.max(0, original.count - 1);

    const correction = opportunity.correction;
    const corrected = counts.get(correction.stageId) ?? {
      stageId: correction.stageId,
      stageName: correction.stageName,
      stageIndex: correction.stageIndex,
      count: 0,
    };
    corrected.stageName = correction.stageName;
    corrected.stageIndex = correction.stageIndex;
    corrected.count += 1;
    counts.set(correction.stageId, corrected);
  }

  return [...counts.values()]
    .filter((group) => group.count > 0)
    .sort((left, right) => {
      if (left.stageIndex === null && right.stageIndex === null) {
        return left.stageName.localeCompare(right.stageName);
      }
      if (left.stageIndex === null) return 1;
      if (right.stageIndex === null) return -1;
      return left.stageIndex - right.stageIndex;
    });
}
