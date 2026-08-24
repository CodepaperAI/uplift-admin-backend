import { describe, expect, test } from "bun:test";
import {
  adjustCommandPipelineStageGroups,
  COMMAND_PIPELINE_STAGE_CORRECTION_INPUT,
  parseCommandPipelineStageCorrection,
} from "../command/pipeline-stage-correction";

describe("Command pipeline reporting corrections", () => {
  test("accepts a bounded stage plus a meaningful reason", () => {
    expect(
      COMMAND_PIPELINE_STAGE_CORRECTION_INPUT.safeParse({
        stageId: "qualified",
        stageName: "Qualified",
        stageIndex: 2,
        reason: "Historical GHL stage was recorded incorrectly.",
      }).success,
    ).toBe(true);
    expect(
      COMMAND_PIPELINE_STAGE_CORRECTION_INPUT.safeParse({
        stageId: "qualified",
        stageName: "Qualified",
        stageIndex: 2,
        reason: "too short",
      }).success,
    ).toBe(false);
  });

  test("rejects malformed stored correction values", () => {
    expect(
      parseCommandPipelineStageCorrection({
        stageId: "qualified",
        stageName: "Qualified",
        stageIndex: 2,
      }),
    ).toEqual({
      stageId: "qualified",
      stageName: "Qualified",
      stageIndex: 2,
    });
    expect(parseCommandPipelineStageCorrection({ stageId: "x" })).toBeNull();
  });

  test("moves corrected rows between funnel stages without changing totals", () => {
    const result = adjustCommandPipelineStageGroups({
      groups: [
        { stageId: "new", stageName: "New", stageIndex: 0, count: 3 },
        {
          stageId: "qualified",
          stageName: "Qualified",
          stageIndex: 2,
          count: 1,
        },
      ],
      correctedOpportunities: [
        {
          pipelineStageId: "new",
          pipelineStageName: "New",
          pipelineStageIndex: 0,
          correction: {
            stageId: "qualified",
            stageName: "Qualified",
            stageIndex: 2,
          },
        },
      ],
    });
    expect(result).toEqual([
      { stageId: "new", stageName: "New", stageIndex: 0, count: 2 },
      {
        stageId: "qualified",
        stageName: "Qualified",
        stageIndex: 2,
        count: 2,
      },
    ]);
    expect(result.reduce((total, stage) => total + stage.count, 0)).toBe(4);
  });
});
